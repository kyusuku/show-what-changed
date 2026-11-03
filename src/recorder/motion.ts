import type { Page } from 'playwright';
import { z } from 'zod';
import type { MotionFrame, MotionScenario, RecorderSettings, Side, ToolError } from '../schema/index.js';
import type { RunContext } from '../schema/contracts.js';
import { sha256 } from '../schema/io.js';
import { writeRunFile } from '../runtime/files.js';
import { MaskWorker } from './masker.js';
import type { FrameSanitizer } from './masker.js';
import { MAX_PNG_BYTES } from '../composer/images.js';
import { CaptureFault, sanitizeFrame } from './images.js';

type Track = MotionScenario['tracks']['before'];
type Clock = NonNullable<Track['clock']>;
type Sample = Clock['samples'][number];
type SourceObservation = Readonly<{ sequence: number; sourceSeconds: number; receivedMs: number }>;
export interface MotionTransport {
  metrics(): Promise<unknown>;
  onFrame(listener: (event: unknown) => void, onAfterCutoff: (sessionId: number | null) => void): void;
  start(): Promise<unknown>;
  stop(): Promise<unknown>;
  acknowledge(sessionId: number): Promise<unknown>;
  /** Ends subscription delivery synchronously without closing the ACK channel. */
  stopFrames(): void;
  /** Disposes the command channel. Repeated calls join the same closure. */
  close(): Promise<void>;
}
type Marker = Extract<MotionScenario['steps'][number]['before'], { kind: 'executed' }>['dispatch'];
const Metrics = z.object({ metrics: z.array(z.object({ name: z.string(), value: z.number().finite() })) });
const FrameSession = z.object({ sessionId: z.number().int() });
const Event = z.object({
  data: z.string().max(24 * 1024 * 1024),
  sessionId: z.number().int(),
  metadata: z.object({
    monotonicTimestamp: z.number().finite().nonnegative(),
    timestamp: z.number().finite().nonnegative().optional(),
    pageScaleFactor: z.literal(1),
    offsetTop: z.literal(0),
    deviceWidth: z.number().int(),
    deviceHeight: z.number().int(),
    scrollOffsetX: z.number().finite(),
    scrollOffsetY: z.number().finite(),
  }),
});
export type CaptureBudget = {
  count: number;
  bytes: number;
  rawBytes: number;
  sanitizedBytes: number;
  checkpoints?: { remaining: number };
};
const capacityWaiters = new WeakMap<CaptureBudget, Set<() => void>>();
const RAW_MEMORY_LIMIT = 128 * 1024 ** 2;
type RawFrameMemory = { encodedBytes: number; processingBytes: number; allocatedBytes: number };
const rawFrames = new WeakMap<CaptureBudget, Set<RawFrameMemory>>();
function notifyCapacity(budget: CaptureBudget): void {
  for (const wake of [...(capacityWaiters.get(budget) ?? [])]) wake();
}
function waitForCapacity(budget: CaptureBudget, signal: AbortSignal, deadline: number): Promise<void> {
  return new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waiters = capacityWaiters.get(budget) ?? new Set<() => void>();
    capacityWaiters.set(budget, waiters);
    const wake = () => {
      waiters.delete(wake);
      signal.removeEventListener('abort', wake);
      if (timer) clearTimeout(timer);
      resolve();
    };
    waiters.add(wake);
    signal.addEventListener('abort', wake, { once: true });
    if (Number.isFinite(deadline)) timer = setTimeout(wake, Math.max(1, deadline - performance.now()));
    if (signal.aborted) wake();
  });
}
function reserveFrameMemory(budget: CaptureBudget, encodedLength: number, pixels: number): RawFrameMemory {
  const memory = {
    encodedBytes: encodedLength * 2,
    processingBytes: Math.ceil((encodedLength * 3) / 4) * 2 + pixels * 16,
    allocatedBytes: encodedLength * 2,
  };
  const frames = rawFrames.get(budget) ?? new Set<RawFrameMemory>();
  const retainedBytes = [...frames].reduce((bytes, frame) => bytes + frame.encodedBytes, memory.encodedBytes);
  const largestProcessing = Math.max(memory.processingBytes, ...[...frames].map((frame) => frame.processingBytes));
  if (budget.rawBytes + memory.encodedBytes > RAW_MEMORY_LIMIT || retainedBytes + largestProcessing > RAW_MEMORY_LIMIT)
    throw new CaptureFault('CAPTURE_RAW_MEMORY_LIMIT');
  frames.add(memory);
  rawFrames.set(budget, frames);
  budget.rawBytes += memory.allocatedBytes;
  return memory;
}
function releaseFrameMemory(budget: CaptureBudget, memory: RawFrameMemory): void {
  rawFrames.get(budget)?.delete(memory);
  budget.rawBytes -= memory.allocatedBytes;
  notifyCapacity(budget);
}
type PendingFrame = { bytes: Buffer; path: string; metadata: Omit<MotionFrame, 'artifact'> };
export type FramePersistence = (path: string, bytes: Buffer) => Promise<void>;
export async function reserveCheckpoint(
  budget: CaptureBudget,
  settings: RecorderSettings,
  run: RunContext,
  deadline: number,
): Promise<() => void> {
  const envelope = 32 * 1024 ** 2 + settings.viewport.width * settings.viewport.height * 16;
  while (budget.rawBytes + envelope > RAW_MEMORY_LIMIT) {
    if (run.signal.aborted) throw new CaptureFault('CAPTURE_CANCELLED');
    if (performance.now() >= deadline) throw new CaptureFault('STEP_TIMEOUT');
    await new Promise((resolve) => setTimeout(resolve, Math.min(5, Math.max(1, deadline - performance.now()))));
  }
  if (run.signal.aborted) throw new CaptureFault('CAPTURE_CANCELLED');
  if (performance.now() >= deadline) throw new CaptureFault('STEP_TIMEOUT');
  budget.rawBytes += envelope;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    budget.rawBytes -= envelope;
    notifyCapacity(budget);
  };
}
export function reserveCheckpointStorage(budget: CaptureBudget, count: number): void {
  const remaining = (budget.checkpoints?.remaining ?? 0) + count;
  if (
    !Number.isSafeInteger(count) ||
    count < 0 ||
    !Number.isSafeInteger(remaining) ||
    remaining > 72 ||
    !Number.isSafeInteger(remaining * MAX_PNG_BYTES) ||
    budget.count + remaining > 12000 ||
    budget.bytes + remaining * MAX_PNG_BYTES > 10 * 1024 ** 3
  )
    throw new CaptureFault('CAPTURE_STORAGE_LIMIT');
  budget.checkpoints = { remaining };
}
export function releaseCheckpointStorage(budget: CaptureBudget): void {
  if (budget.checkpoints) budget.checkpoints.remaining = 0;
}
export function releaseArtifact(budget: CaptureBudget, bytes: number): void {
  budget.count--;
  budget.bytes -= bytes;
}
export function reserveArtifact(budget: CaptureBudget, bytes: number, kind: 'source' | 'checkpoint' = 'source'): void {
  const outstanding = budget.checkpoints?.remaining ?? 0;
  const remaining = outstanding - (kind === 'checkpoint' ? 1 : 0);
  if (
    !Number.isSafeInteger(bytes) ||
    bytes < 0 ||
    bytes > MAX_PNG_BYTES ||
    remaining < 0 ||
    budget.count + remaining + 1 > 12000 ||
    budget.bytes + remaining * MAX_PNG_BYTES + bytes > 10 * 1024 ** 3
  )
    throw new CaptureFault('CAPTURE_STORAGE_LIMIT');
  budget.count++;
  budget.bytes += bytes;
  if (kind === 'checkpoint' && budget.checkpoints) budget.checkpoints.remaining = remaining;
}
function now(run: RunContext): number {
  return performance.now() - run.startedMonotonicMs;
}
export function validateClock(clock: Clock, sample: Sample): void {
  const previous = clock.samples.at(-1);
  const half = (sample.hostAfterMs - sample.hostBeforeMs) / 2;
  const midpointOffset = (sample.hostBeforeMs + sample.hostAfterMs) / 2 - sample.sourceSeconds * 1000;
  clock.samples.push(sample);
  clock.uncertaintyMs = Math.max(clock.uncertaintyMs, half);
  clock.maxDriftMs = Math.max(clock.maxDriftMs, Math.abs(midpointOffset - clock.offsetMs));
  clock.errorBoundMs = clock.uncertaintyMs + clock.maxDriftMs;
  if (half < 0 || sample.sourceSeconds <= (previous?.sourceSeconds ?? -1) || clock.errorBoundMs > 40)
    throw new CaptureFault('CAPTURE_CLOCK_DRIFT');
}
function error(code: string, side: Side): ToolError {
  return {
    code,
    phase: 'recording',
    side,
    message: 'The browser motion stream could not be captured safely.',
    hint: 'Inspect capture quality and retry the bounded scenario.',
  };
}
export class MotionRecorder {
  private clock: Clock | null = null;
  private readonly frames: MotionFrame[] = [];
  private readonly gaps: Track['gaps'] = [];
  private readonly stats: Track['stats'] = {
    receivedFrames: 0,
    persistedFrames: 0,
    acknowledgedFrames: 0,
    rejectedFrames: 0,
    maxQueueDepth: 0,
    sourceDroppedFrames: null,
    maxGapMs: 0,
  };
  private fault: { code: string; atMs: number } | null = null;
  private pending = 0;
  private delivery: 'unbound' | 'open' | 'sealed' | 'closed' = 'unbound';
  private deliveryCutoffMs: number | null = null;
  private detachStartedMs: number | null = null;
  private detachedMs: number | null = null;
  private ackFailure: { atMs: number; kind: 'deadline' | 'command' } | null = null;
  private finalResult: Track | undefined;
  private lifecycle: 'starting' | 'active' | 'stopping' | 'stopped' = 'starting';
  private shutdownResolve: () => void = () => {};
  private readonly shutdown = new Promise<void>((resolve) => {
    this.shutdownResolve = resolve;
  });
  private forceResolve: () => void = () => {};
  private expirationResolve: () => void = () => {};
  private readonly expired = new Promise<void>((resolve) => {
    this.expirationResolve = resolve;
  });
  private readonly forced = new Promise<void>((resolve) => {
    this.forceResolve = resolve;
  });
  private sanitizerClosing: Promise<void> | undefined;
  private sanitizerClosedResolve: () => void = () => {};
  private readonly sanitizerClosed = new Promise<void>((resolve) => {
    this.sanitizerClosedResolve = resolve;
  });
  private readonly rawSettlements = new Set<Promise<void>>();
  private deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  private removeSanitizerFailure: () => void = () => {};
  private readonly abort = () => this.forceClose('CAPTURE_CANCELLED');
  private tail: Promise<void> = Promise.resolve();
  private clockTail: Promise<void> = Promise.resolve();
  private persistenceTail: Promise<void> = Promise.resolve();
  private cleanPending = 0;
  private drainDeadlineMs = Infinity;
  private persistenceFailed = false;
  private stoppedAtMs: number | null = null;
  private lastAcceptedObservation: SourceObservation | null = null;
  private previousReceivedObservation: SourceObservation | null = null;
  private stopping: Promise<void> | undefined;
  private sourceStartGuard: Promise<void> = Promise.resolve();
  private contextCloseResolve: () => void = () => {};
  private readonly contextCloseReady = new Promise<void>((resolve) => {
    this.contextCloseResolve = resolve;
  });
  private readonly acknowledgements = new Set<Promise<void>>();
  private readonly processing = {
    maskMs: 0,
    writeMs: 0,
    maxMaskMs: 0,
    maxWriteMs: 0,
    maxAckLatencyMs: 0,
    maxSanitizedQueueDepth: 0,
    maxSharedSanitizedBytes: 0,
    backpressureWaits: 0,
  };
  private constructor(
    private readonly session: MotionTransport,
    private readonly settings: Extract<RecorderSettings, { mode: 'motion' }>,
    private readonly run: RunContext,
    private readonly side: Side,
    private readonly scenarioId: string,
    private readonly budget: CaptureBudget,
    private readonly onFault: (code: string) => void,
    private readonly persist: FramePersistence,
    private readonly sanitizer: FrameSanitizer,
  ) {
    run.signal.addEventListener('abort', this.abort, { once: true });
  }
  static async start(
    page: Page,
    settings: Extract<RecorderSettings, { mode: 'motion' }>,
    run: RunContext,
    side: Side,
    scenarioId: string,
    budget: CaptureBudget,
    onFault: (code: string) => void,
  ): Promise<MotionRecorder> {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
    let closing: Promise<void> | undefined;
    let subscriber: ((event: unknown) => void) | undefined;
    let onAfterCutoff: ((sessionId: number | null) => void) | undefined;
    let framesStopped = false;
    const forward = (event: unknown) => {
      if (subscriber) subscriber(event);
      else {
        const parsed = FrameSession.safeParse(event);
        onAfterCutoff?.(parsed.success ? parsed.data.sessionId : null);
      }
    };
    const stopFrames = () => {
      if (framesStopped) return;
      framesStopped = true;
      subscriber = undefined;
      cdp.off('Page.screencastFrame', forward);
    };
    return MotionRecorder.fromTransport(
      {
        metrics: () => cdp.send('Performance.getMetrics'),
        onFrame: (listener, rejected) => {
          if (framesStopped || subscriber) throw new CaptureFault('CAPTURE_TRANSPORT_CLOSED');
          subscriber = listener;
          onAfterCutoff = rejected;
          cdp.on('Page.screencastFrame', forward);
        },
        start: () =>
          cdp.send('Page.startScreencast', {
            format: 'png',
            everyNthFrame: 1,
            maxWidth: settings.viewport.width,
            maxHeight: settings.viewport.height,
            ...{ maxFramesInFlight: 1 },
          }),
        stop: () => cdp.send('Page.stopScreencast'),
        acknowledge: (sessionId) => cdp.send('Page.screencastFrameAck', { sessionId }),
        stopFrames,
        close: () =>
          closing ??= (async () => {
            stopFrames();
            await cdp.detach();
          })(),
      },
      settings,
      run,
      side,
      scenarioId,
      budget,
      onFault,
      undefined,
      () => new MaskWorker(settings, run.signal),
    );
  }
  static async fromTransport(
    session: MotionTransport,
    settings: Extract<RecorderSettings, { mode: 'motion' }>,
    run: RunContext,
    side: Side,
    scenarioId: string,
    budget: CaptureBudget,
    onFault: (code: string) => void,
    persist: FramePersistence = (path, bytes) => writeRunFile(run, path, bytes),
    createSanitizer: () => FrameSanitizer = () => ({
      ready: Promise.resolve(),
      onFailure: () => () => {},
      sanitize: async (bytes) => sanitizeFrame(bytes, settings.viewport, settings.maskRects),
      close: async () => {},
    }),
  ): Promise<MotionRecorder> {
    let sanitizer: FrameSanitizer = {
      ready: Promise.resolve(),
      onFailure: () => () => {},
      sanitize: async () => {
        throw new CaptureFault('CAPTURE_WORKER_UNAVAILABLE');
      },
      close: async () => {},
    };
    const delegate: FrameSanitizer = {
      get ready() {
        return sanitizer.ready;
      },
      onFailure: (listener) => sanitizer.onFailure(listener),
      sanitize: (bytes) => sanitizer.sanitize(bytes),
      close: () => sanitizer.close(),
    };
    const recorder = new MotionRecorder(session, settings, run, side, scenarioId, budget, onFault, persist, delegate);
    run.resources.register({
      kind: 'capture',
      identity: `motion-${scenarioId}-${side}`,
      dispose: (deadlineMs) => recorder.stop(deadlineMs),
    });
    try {
      recorder.ensureStarting();
      sanitizer = createSanitizer();
      recorder.removeSanitizerFailure = sanitizer.onFailure((code) => recorder.fail(code));
      await recorder.startup(sanitizer.ready);
      const samples: Sample[] = [];
      for (let i = 0; i < 5; i++) {
        recorder.ensureStarting();
        samples.push(await recorder.startup(recorder.sample()));
      }
      const best = samples.reduce((a, b) => (a.hostAfterMs - a.hostBeforeMs < b.hostAfterMs - b.hostBeforeMs ? a : b));
      const uncertaintyMs = (best.hostAfterMs - best.hostBeforeMs) / 2;
      recorder.clock = {
        rate: 1,
        offsetMs: (best.hostAfterMs + best.hostBeforeMs) / 2 - best.sourceSeconds * 1000,
        uncertaintyMs,
        maxDriftMs: 0,
        errorBoundMs: uncertaintyMs,
        samples: [best],
      };
      if (uncertaintyMs > 40) throw new CaptureFault('CAPTURE_CLOCK_DRIFT');
      recorder.ensureStarting();
      recorder.lifecycle = 'active';
      recorder.delivery = 'open';
      session.onFrame(
        (event: unknown) => recorder.receive(event),
        (sessionId) => recorder.rejectAfterCutoff(sessionId),
      );
      const starting = session.start();
      recorder.sourceStartGuard = starting.then(
        async () => {
          if (recorder.lifecycle !== 'active' && recorder.delivery !== 'closed') {
            try {
              await recorder.awaitOwned(session.stop(), 'cleanup');
            } catch {
              recorder.fail('CAPTURE_DRAIN_TIMEOUT');
            }
          }
        },
        () => {},
      );
      await recorder.awaitOwned(starting, 'capture');
    } catch (cause) {
      recorder.fail(cause instanceof CaptureFault ? cause.code : 'CAPTURE_CLOCK_UNSUPPORTED');
    }
    return recorder;
  }
  private ensureStarting(): void {
    if (this.lifecycle !== 'starting' || this.fault || this.run.signal.aborted)
      throw new CaptureFault(this.fault?.code ?? 'CAPTURE_STOPPED');
  }
  private async awaitOwned<T>(task: Promise<T>, lifetime: 'capture' | 'worker' | 'cleanup'): Promise<T> {
    const ended = lifetime === 'capture' ? this.shutdown : lifetime === 'worker' ? this.forced : this.expired;
    const result = await Promise.race([
      task.then((value) => ({ kind: 'value' as const, value })),
      ended.then(() => ({ kind: 'ended' as const })),
    ]);
    if (result.kind === 'ended')
      throw new CaptureFault(
        lifetime === 'cleanup' ? 'CAPTURE_DRAIN_TIMEOUT' : (this.failureCode() ?? 'CAPTURE_STOPPED'),
      );
    return result.value;
  }
  private async startup<T>(task: Promise<T>): Promise<T> {
    this.ensureStarting();
    const value = await this.awaitOwned(task, 'capture');
    this.ensureStarting();
    return value;
  }
  private forceClose(code: string): void {
    this.fail(code);
    this.forceResolve();
    if (code === 'CAPTURE_DRAIN_TIMEOUT') {
      this.drainDeadlineMs = Math.min(this.drainDeadlineMs, performance.now());
      this.expirationResolve();
      this.contextCloseResolve();
    }
    this.shutdownResolve();
    void this.closeSanitizer().catch(() => {});
    notifyCapacity(this.budget);
  }
  private closeSanitizer(): Promise<void> {
    this.sanitizerClosing ??= (async () => {
      await this.sanitizer.close();
      this.sanitizerClosedResolve();
    })();
    return this.sanitizerClosing;
  }
  private sanitize(bytes: Buffer, releaseRaw: () => void): Promise<Buffer> {
    let task: Promise<Buffer>;
    try {
      task = this.sanitizer.sanitize(bytes);
    } catch (cause) {
      releaseRaw();
      throw cause;
    }
    const settled = Promise.race([
      task.then(() => {}, () => {}),
      this.sanitizerClosed,
    ]).then(releaseRaw);
    this.rawSettlements.add(settled);
    void settled.then(() => this.rawSettlements.delete(settled));
    return this.awaitOwned(task, 'worker');
  }
  private async sample(lifetime: 'capture' | 'cleanup' = 'capture'): Promise<Sample> {
    const hostBeforeMs = now(this.run);
    const response = Metrics.parse(await this.awaitOwned(this.session.metrics(), lifetime));
    const hostAfterMs = now(this.run);
    const sourceSeconds = response.metrics.find((metric) => metric.name === 'Timestamp')?.value;
    if (sourceSeconds === undefined || sourceSeconds < 0) throw new CaptureFault('CAPTURE_CLOCK_UNSUPPORTED');
    return { sourceSeconds, hostBeforeMs, hostAfterMs };
  }
  marker(): Promise<Marker> {
    const pending = this.clockTail.then(() => this.measureMarker());
    this.clockTail = pending.then(
      () => {},
      () => {},
    );
    return pending;
  }
  private async measureMarker(): Promise<Marker> {
    if (this.lifecycle !== 'active') throw new CaptureFault(this.failureCode() ?? 'CAPTURE_STOPPED');
    if (!this.clock || this.fault) throw new CaptureFault(this.fault?.code ?? 'CAPTURE_CLOCK_UNSUPPORTED');
    try {
      const sample = await this.sample();
      const currentFailure = this.failureCode();
      if (currentFailure) throw new CaptureFault(currentFailure);
      validateClock(this.clock, sample);
      return {
        kind: 'source',
        ...sample,
        runElapsedMs: sample.sourceSeconds * 1000 + this.clock.offsetMs,
        uncertaintyMs: this.clock.errorBoundMs,
      };
    } catch (cause) {
      this.fail(cause instanceof CaptureFault ? cause.code : 'CAPTURE_CLOCK_UNSUPPORTED');
      throw cause;
    }
  }
  private failureCode(): string | null {
    return this.fault?.code ?? null;
  }
  private fail(code: string): void {
    if (this.fault) return;
    this.fault = { code, atMs: now(this.run) };
    this.shutdownResolve();
    this.onFault(code);
    notifyCapacity(this.budget);
    if (this.delivery !== 'closed') void this.session.stop().catch(() => {});
  }
  private receive(value: unknown): void {
    if (this.delivery !== 'open') {
      const received = FrameSession.safeParse(value);
      this.rejectAfterCutoff(received.success ? received.data.sessionId : null);
      return;
    }
    if (this.fault) {
      this.stats.receivedFrames++;
      this.stats.rejectedFrames++;
      const received = FrameSession.safeParse(value);
      if (received.success) void this.ack(received.data.sessionId);
      return;
    }
    const sequence = this.stats.receivedFrames++;
    const parsed = Event.safeParse(value);
    if (!parsed.success) {
      this.stats.rejectedFrames++;
      const clock = z
        .object({ metadata: z.object({ monotonicTimestamp: z.number().finite().nonnegative() }) })
        .safeParse(value);
      this.fail(clock.success ? 'CAPTURE_METADATA_INVALID' : 'CAPTURE_CLOCK_UNSUPPORTED');
      const received = z.object({ sessionId: z.number().int() }).safeParse(value);
      if (received.success) void this.ack(received.data.sessionId);
      return;
    }
    const event = parsed.data;
    const receivedMs = now(this.run);
    const observation: SourceObservation = { sequence, sourceSeconds: event.metadata.monotonicTimestamp, receivedMs };
    const previousReceived = this.previousReceivedObservation;
    this.previousReceivedObservation = observation;
    if (this.pending >= 2) {
      this.stats.rejectedFrames++;
      this.fail('CAPTURE_QUEUE_OVERFLOW');
      void this.ack(event.sessionId);
      return;
    }
    this.pending++;
    this.stats.maxQueueDepth = Math.max(this.stats.maxQueueDepth, this.pending);
    let memory: RawFrameMemory;
    try {
      memory = reserveFrameMemory(
        this.budget,
        event.data.length,
        this.settings.viewport.width * this.settings.viewport.height,
      );
    } catch {
      this.pending--;
      this.stats.rejectedFrames++;
      this.fail('CAPTURE_RAW_MEMORY_LIMIT');
      void this.ack(event.sessionId);
      return;
    }
    this.tail = this.tail.then(async () => {
      let sanitizerOwnsRaw = false;
      let releaseRaw = () => {};
      const rawReleased = new Promise<void>((resolve) => {
        releaseRaw = () => {
          releaseFrameMemory(this.budget, memory);
          resolve();
        };
      });
      try {
        if (this.run.signal.aborted) throw new CaptureFault('CAPTURE_CANCELLED');
        const { metadata } = event;
        if (
          !this.clock ||
          metadata.deviceWidth !== this.settings.viewport.width ||
          metadata.deviceHeight !== this.settings.viewport.height
        )
          throw new CaptureFault('CAPTURE_METADATA_INVALID');
        if (this.lastAcceptedObservation !== null && metadata.monotonicTimestamp <= this.lastAcceptedObservation.sourceSeconds) {
          if (!this.fault) {
            try {
              this.run.diagnostics.event(JSON.stringify({
                kind: 'capture-timestamp-rejection',
                side: this.side,
                current: observation,
                previousReceived,
                lastAccepted: this.lastAcceptedObservation,
                deltaSeconds: metadata.monotonicTimestamp - this.lastAcceptedObservation.sourceSeconds,
                relation: metadata.monotonicTimestamp === this.lastAcceptedObservation.sourceSeconds ? 'equal' : 'backward',
              }));
            } catch {}
          }
          throw new CaptureFault('CAPTURE_TIMESTAMP_REGRESSION');
        }
        await this.reserveProcessingMemory(memory);
        const maskStart = performance.now();
        let raw = Buffer.from(event.data, 'base64');
        event.data = '';
        sanitizerOwnsRaw = true;
        const sanitized = this.sanitize(raw, releaseRaw);
        raw = Buffer.alloc(0);
        const bytes = await sanitized;
        const maskMs = performance.now() - maskStart;
        this.processing.maskMs += maskMs;
        this.processing.maxMaskMs = Math.max(this.processing.maxMaskMs, maskMs);
        const runElapsedMs = metadata.monotonicTimestamp * 1000 + this.clock.offsetMs;
        if (runElapsedMs < 0) throw new CaptureFault('CAPTURE_CLOCK_DRIFT');
        if (this.cleanPending >= 256 || this.budget.sanitizedBytes + bytes.length > 32 * 1024 ** 2)
          throw new CaptureFault('CAPTURE_SANITIZED_QUEUE_LIMIT');
        reserveArtifact(this.budget, bytes.length);
        this.lastAcceptedObservation = observation;
        this.enqueue({
          bytes,
          path: `frames/${this.scenarioId}-${this.side}-${String(sequence).padStart(5, '0')}.png`,
          metadata: {
            sequence,
            sourceMonotonicSeconds: metadata.monotonicTimestamp,
            sourceEpochSeconds: metadata.timestamp ?? null,
            runElapsedMs,
            receivedMs,
            width: metadata.deviceWidth,
            height: metadata.deviceHeight,
            deviceScaleFactor: 1,
            pageScaleFactor: 1,
            offsetTop: 0,
            scrollOffsetX: metadata.scrollOffsetX,
            scrollOffsetY: metadata.scrollOffsetY,
            maskDigest: sha256(JSON.stringify(this.settings.maskRects)),
          },
        });
      } catch (cause) {
        this.stats.rejectedFrames++;
        this.fail(cause instanceof CaptureFault ? cause.code : 'CAPTURE_FRAME_FAILED');
      } finally {
        event.data = '';
        if (!sanitizerOwnsRaw) releaseRaw();
        await rawReleased;
        this.pending--;
        await this.waitForPersistenceCapacity();
        await this.ack(event.sessionId);
        this.processing.maxAckLatencyMs = Math.max(this.processing.maxAckLatencyMs, now(this.run) - receivedMs);
      }
    });
  }
  private async reserveProcessingMemory(memory: RawFrameMemory): Promise<void> {
    for (;;) {
      if (this.run.signal.aborted) throw new CaptureFault('CAPTURE_CANCELLED');
      if (performance.now() >= this.drainDeadlineMs) throw new CaptureFault('CAPTURE_DRAIN_TIMEOUT');
      if (this.budget.rawBytes + memory.processingBytes <= RAW_MEMORY_LIMIT) {
        this.budget.rawBytes += memory.processingBytes;
        memory.allocatedBytes += memory.processingBytes;
        return;
      }
      await waitForCapacity(this.budget, this.run.signal, this.drainDeadlineMs);
    }
  }
  private enqueue(entry: PendingFrame): void {
    this.cleanPending++;
    this.budget.sanitizedBytes += entry.bytes.length;
    this.processing.maxSanitizedQueueDepth = Math.max(this.processing.maxSanitizedQueueDepth, this.cleanPending);
    this.processing.maxSharedSanitizedBytes = Math.max(
      this.processing.maxSharedSanitizedBytes,
      this.budget.sanitizedBytes,
    );
    this.persistenceTail = this.persistenceTail.then(async () => {
      try {
        if (this.run.signal.aborted) throw new CaptureFault('CAPTURE_CANCELLED');
        if (this.persistenceFailed) throw new CaptureFault('CAPTURE_PERSISTENCE_STOPPED');
        if (performance.now() >= this.drainDeadlineMs) throw new CaptureFault('CAPTURE_DRAIN_TIMEOUT');
        const writeStart = performance.now();
        await this.persist(entry.path, entry.bytes);
        const writeMs = performance.now() - writeStart;
        this.processing.writeMs += writeMs;
        this.processing.maxWriteMs = Math.max(this.processing.maxWriteMs, writeMs);
        this.frames.push({
          ...entry.metadata,
          artifact: { path: entry.path, sha256: sha256(entry.bytes), bytes: entry.bytes.length },
        });
        this.stats.persistedFrames++;
        if (this.run.signal.aborted || performance.now() >= this.drainDeadlineMs) {
          this.persistenceFailed = true;
          this.fail(this.run.signal.aborted ? 'CAPTURE_CANCELLED' : 'CAPTURE_DRAIN_TIMEOUT');
        }
        const previous = this.frames.at(-2);
        if (previous) {
          const durationMs = (entry.metadata.sourceMonotonicSeconds - previous.sourceMonotonicSeconds) * 1000;
          this.stats.maxGapMs = Math.max(this.stats.maxGapMs, durationMs);
          this.gaps.push({
            fromSourceSeconds: previous.sourceMonotonicSeconds,
            toSourceSeconds: entry.metadata.sourceMonotonicSeconds,
            durationMs,
          });
        }
      } catch (cause) {
        this.persistenceFailed = true;
        this.stats.rejectedFrames++;
        this.fail(cause instanceof CaptureFault ? cause.code : 'CAPTURE_WRITE_FAILED');
      } finally {
        this.cleanPending--;
        this.budget.sanitizedBytes -= entry.bytes.length;
        entry.bytes = Buffer.alloc(0);
        notifyCapacity(this.budget);
      }
    });
  }
  sanitizeCheckpoint(bytes: Buffer, releaseRaw: () => void): Promise<Buffer> {
    if (this.fault) {
      releaseRaw();
      throw new CaptureFault(this.fault.code);
    }
    return this.sanitize(bytes, releaseRaw);
  }
  private async waitForPersistenceCapacity(): Promise<void> {
    while (!this.fault && (this.cleanPending >= 128 || this.budget.sanitizedBytes >= 16 * 1024 ** 2)) {
      if (this.run.signal.aborted) {
        this.fail('CAPTURE_CANCELLED');
        return;
      }
      if (performance.now() >= this.drainDeadlineMs) {
        this.fail('CAPTURE_DRAIN_TIMEOUT');
        return;
      }
      this.processing.backpressureWaits++;
      await waitForCapacity(this.budget, this.run.signal, this.drainDeadlineMs);
    }
  }
  contextMayClose(): Promise<void> {
    return this.contextCloseReady;
  }
  captureEndMs(): number {
    if (this.stoppedAtMs === null) throw new Error('Motion source has not stopped');
    return this.stoppedAtMs;
  }
  private rejectAfterCutoff(sessionId: number | null): void {
    this.stats.receivedFrames++;
    this.stats.rejectedFrames++;
    this.fail('CAPTURE_DELIVERY_AFTER_CUTOFF');
    if (sessionId !== null && this.delivery !== 'closed') void this.ack(sessionId);
  }
  private ack(sessionId: number): Promise<void> {
    const pending = (async () => {
      try {
        await this.awaitOwned(this.session.acknowledge(sessionId), 'cleanup');
        this.stats.acknowledgedFrames++;
      } catch (cause) {
        this.ackFailure ??= {
          atMs: now(this.run),
          kind: cause instanceof CaptureFault && cause.code === 'CAPTURE_DRAIN_TIMEOUT' ? 'deadline' : 'command',
        };
        this.fail('CAPTURE_ACK_FAILED');
      }
    })();
    this.acknowledgements.add(pending);
    void pending.then(() => this.acknowledgements.delete(pending));
    return pending;
  }
  stop(deadlineMs = performance.now() + 30_000): Promise<void> {
    this.drainDeadlineMs = Math.min(this.drainDeadlineMs, deadlineMs);
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    if (Number.isFinite(this.drainDeadlineMs) && this.lifecycle !== 'stopped')
      this.deadlineTimer = setTimeout(
        () => this.forceClose('CAPTURE_DRAIN_TIMEOUT'),
        Math.max(1, this.drainDeadlineMs - performance.now()),
      );
    notifyCapacity(this.budget);
    if (this.stopping) return this.stopping;
    const wasStarting = this.lifecycle === 'starting';
    this.lifecycle = 'stopping';
    this.shutdownResolve();
    if (wasStarting) void this.closeSanitizer().catch(() => {});
    this.stopping = (async () => {
      let sourceStopped = false;
      try {
        try {
          await this.awaitOwned(Promise.all([this.session.stop(), this.sourceStartGuard]), 'cleanup');
          sourceStopped = true;
        } catch (cause) {
          this.fail(cause instanceof CaptureFault ? cause.code : 'CAPTURE_STOP_FAILED');
        }
        this.stoppedAtMs = now(this.run);
        let drained = true;
        try {
          await this.awaitOwned(this.clockTail, 'cleanup');
        } catch {
          drained = false;
        }
        if (!this.fault && this.clock) {
          try {
            validateClock(this.clock, await this.sample('cleanup'));
          } catch (cause) {
            this.fail(cause instanceof CaptureFault ? cause.code : 'CAPTURE_CLOCK_UNSUPPORTED');
          }
        }
        let cutoff = true;
        try {
          this.session.stopFrames();
          this.delivery = 'sealed';
          this.deliveryCutoffMs = now(this.run);
        } catch {
          cutoff = false;
          this.fail('CAPTURE_CUTOFF_FAILED');
        }
        try {
          await this.awaitOwned(this.tail, 'cleanup');
          await this.awaitOwned(Promise.all(this.acknowledgements), 'cleanup');
        } catch {
          drained = false;
        }
        let closed = true;
        try {
          this.detachStartedMs = now(this.run);
          const closing = this.session.close().then(() => {
            this.delivery = 'closed';
            this.detachedMs = now(this.run);
          });
          await this.awaitOwned(closing, 'cleanup');
        } catch (cause) {
          closed = false;
          this.fail(cause instanceof CaptureFault ? cause.code : 'CAPTURE_CLOSE_FAILED');
        }
        this.contextCloseResolve();
        let persisted = true;
        try {
          await this.awaitOwned(this.persistenceTail, 'cleanup');
        } catch {
          persisted = false;
        }
        let joined = true;
        try {
          await this.awaitOwned(this.closeSanitizer(), 'cleanup');
          await this.awaitOwned(Promise.all(this.rawSettlements), 'cleanup');
        } catch {
          joined = false;
        }
        if (!sourceStopped || !cutoff || !closed || !drained || !persisted || !joined) {
          this.fail('CAPTURE_DRAIN_TIMEOUT');
          throw new CaptureFault('CAPTURE_DRAIN_TIMEOUT');
        }
        if (!this.frames.length && !this.fault) this.fail('CAPTURE_NO_FRAMES');
        this.run.diagnostics.event(
          JSON.stringify({
            kind: 'capture-processing',
            side: this.side,
            frames: this.frames.length,
            pendingRaw: this.pending,
            pendingSanitized: this.cleanPending,
            sharedSanitizedBytes: this.budget.sanitizedBytes,
            ...this.processing,
          }),
        );
      } finally {
        this.contextCloseResolve();
        this.removeSanitizerFailure();
        void this.closeSanitizer().catch(() => {});
        this.run.signal.removeEventListener('abort', this.abort);
        if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
        this.lifecycle = 'stopped';
        this.finalResult = this.result();
        if (this.fault) {
          try {
            this.run.diagnostics.event(
              JSON.stringify({
                kind: 'capture-shutdown-failure',
                side: this.side,
                code: this.fault.code,
                failureAtMs: this.fault.atMs,
                sourceStoppedAtMs: sourceStopped ? this.stoppedAtMs : null,
                deliveryCutoffMs: this.deliveryCutoffMs,
                detachStartedMs: this.detachStartedMs,
                detachedMs: this.detachedMs,
                delivery: this.delivery,
                ackFailure: this.ackFailure,
                stats: this.stats,
                pendingRaw: this.pending,
                pendingAcknowledgements: this.acknowledgements.size,
                pendingSanitized: this.cleanPending,
                rawSettlements: this.rawSettlements.size,
              }),
            );
          } catch {}
        }
      }
    })();
    return this.stopping;
  }
  result(): Track {
    if (this.finalResult) return structuredClone(this.finalResult);
    const shared = { frames: this.frames, gaps: this.gaps, stats: this.stats };
    return structuredClone(this.fault || !this.clock
      ? {
          ...shared,
          status: 'failed',
          clock: this.clock,
          error: error(this.fault?.code ?? 'CAPTURE_CLOCK_UNSUPPORTED', this.side),
          failureAtMs: this.fault?.atMs ?? now(this.run),
        }
      : { ...shared, status: 'ok', clock: this.clock, error: null });
  }
}
