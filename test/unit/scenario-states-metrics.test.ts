import { describe, expect, it, vi } from 'vitest';
import { PNG } from 'pngjs';
import { changeRatio, neutralFrame } from '../../src/recorder/images.js';

describe('source keyframe comparison', () => {
  it('measures source pixels with a 0.1 threshold and ignores identical pairs', () => {
    const before = neutralFrame();
    const image = PNG.sync.read(before);
    for (let y = 0; y < 80; y++)
      for (let x = 0; x < 128; x++) {
        const offset = (y * image.width + x) * 4;
        image.data[offset] = 255;
        image.data[offset + 1] = 255;
        image.data[offset + 2] = 255;
      }
    const after = PNG.sync.write(image);
    expect(changeRatio(before, before)).toBe(0);
    expect(changeRatio(before, after)).toBeCloseTo(0.01, 8);
  });
  it('rejects unequal dimensions', () => {
    expect(() => changeRatio(neutralFrame(), PNG.sync.write(new PNG({ width: 1, height: 1 })))).toThrow(
      'INVALID_FRAME_SIZE',
    );
  });
});

import { CaptureFault, sanitizeFrame } from '../../src/recorder/images.js';
import { reserveArtifact, validateClock } from '../../src/recorder/motion.js';

describe('motion safety boundaries', () => {
  it('fills every mask pixel opaquely before persistence, including odd narrow viewports', () => {
    const raw = new PNG({ width: 391, height: 845 });
    raw.data.fill(255);
    const sanitized = PNG.sync.read(
      sanitizeFrame(PNG.sync.write(raw), { width: 391, height: 845 }, [{ x: 3, y: 4, width: 17, height: 21 }]),
    );
    for (let y = 4; y < 25; y++)
      for (let x = 3; x < 20; x++) {
        const p = (y * 391 + x) * 4;
        expect([...sanitized.data.subarray(p, p + 4)]).toEqual([16, 16, 16, 255]);
      }
    expect(() =>
      sanitizeFrame(PNG.sync.write(raw), { width: 391, height: 845 }, [{ x: 390, y: 0, width: 2, height: 2 }]),
    ).toThrow('MASK_INVALID');
  });
  it('fails later calibration that would require a backward offset replacement and retains the original offset', () => {
    const clock = {
      rate: 1 as const,
      offsetMs: 100,
      uncertaintyMs: 1,
      maxDriftMs: 0,
      errorBoundMs: 1,
      samples: [{ sourceSeconds: 1, hostBeforeMs: 1099, hostAfterMs: 1101 }],
    };
    expect(() => validateClock(clock, { sourceSeconds: 2, hostBeforeMs: 1899, hostAfterMs: 1901 })).toThrow(
      'CAPTURE_CLOCK_DRIFT',
    );
    expect(clock.offsetMs).toBe(100);
    expect(clock.errorBoundMs).toBeGreaterThan(40);
    expect(clock.samples).toHaveLength(2);
  });
  it('rejects source clock resets and enforces storage incrementally', () => {
    const clock = {
      rate: 1 as const,
      offsetMs: 0,
      uncertaintyMs: 0,
      maxDriftMs: 0,
      errorBoundMs: 0,
      samples: [{ sourceSeconds: 2, hostBeforeMs: 2000, hostAfterMs: 2000 }],
    };
    expect(() => validateClock(clock, { sourceSeconds: 1, hostBeforeMs: 2100, hostAfterMs: 2100 })).toThrow();
    expect(() => reserveArtifact({ count: 12000, bytes: 0, rawBytes: 0, sanitizedBytes: 0 }, 1)).toThrow(
      'CAPTURE_STORAGE_LIMIT',
    );
    expect(() => reserveArtifact({ count: 0, bytes: 10 * 1024 ** 3, rawBytes: 0, sanitizedBytes: 0 }, 1)).toThrow(
      'CAPTURE_STORAGE_LIMIT',
    );
  });
});

import { mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { CaptureSettingsSchema, MotionTrackSchema } from '../../src/schema/index.js';
import type { RunContext } from '../../src/schema/contracts.js';
import { MotionRecorder } from '../../src/recorder/motion.js';
import { writeRunFile } from '../../src/runtime/files.js';
import type { CaptureBudget, FramePersistence, MotionTransport } from '../../src/recorder/motion.js';
const rawRoots: string[] = [];
afterEach(async () => {
  for (const root of rawRoots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function streamHarness(
  persist?: FramePersistence,
  options: {
    createSanitizer?: () => import('../../src/recorder/masker.js').FrameSanitizer;
    metrics?: MotionTransport['metrics'];
    register?: (resource: Parameters<RunContext['resources']['register']>[0]) => void;
    onStart?: () => void;
    stop?: MotionTransport['stop'];
    start?: MotionTransport['start'];
    close?: () => Promise<void>;
    stopFrames?: () => void;
    acknowledge?: MotionTransport['acknowledge'];
    onFrame?: (listener: (event: unknown) => void, onAfterCutoff: (sessionId: number | null) => void) => void;
    viewport?: { width: number; height: number };
    budget?: CaptureBudget;
    side?: 'before' | 'after';
    diagnostics?: RunContext['diagnostics'];
  } = {},
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'swc-stream-')));
  rawRoots.push(root);
  const controller = new AbortController();
  const unavailable = async (): Promise<never> => {
    throw new Error('Unexpected process in frame-stream unit');
  };
  const run: RunContext = {
    runId: '20261102T000000000Z-0000000000000000',
    startedAt: '2026-11-02T00:00:00.000Z',
    startedMonotonicMs: performance.now() - 1000,
    deadlineMs: performance.now() + 30000,
    signal: controller.signal,
    paths: {
      repoRoot: root,
      runDir: root,
      privateDir: join(root, 'private'),
      tempDir: join(root, 'temp'),
      framesDir: join(root, 'frames'),
      composedDir: join(root, 'composed'),
    },
    diagnostics: options.diagnostics ?? { event() {} },
    resources: {
      register(resource) {
        options.register?.(resource);
      },
      disposeAll: async () => ({ status: 'ok', errors: [] }),
    },
    supervisor: {
      spawn: unavailable,
      adopt: unavailable,
      stop: unavailable,
      stopAll: async () => ({ status: 'ok', errors: [] }),
    },
    redactions: {
      add() {},
      text(value) {
        return value;
      },
    },
  };
  let receiver: ((event: unknown) => void) | null = null;
  let transportClosed = false;
  let framesStopped = false;
  let transportClosing: Promise<void> | undefined;
  const acknowledged: number[] = [];
  const faults: string[] = [];
  const stopFrames = () => {
    if (framesStopped) return;
    framesStopped = true;
    options.stopFrames?.();
  };
  const transport: MotionTransport = {
    metrics: options.metrics ?? (async () => ({ metrics: [{ name: 'Timestamp', value: performance.now() / 1000 }] })),
    onFrame(listener, onAfterCutoff) {
      if (framesStopped) throw new Error('Frame subscription is stopped');
      receiver = listener;
      options.onFrame?.(listener, onAfterCutoff);
    },
    start: async () => {
      options.onStart?.();
      await options.start?.();
    },
    stop: options.stop ?? (async () => {}),
    acknowledge: async (id) => {
      if (transportClosed) throw new Error('Transport is closed');
      await options.acknowledge?.(id);
      if (transportClosed) throw new Error('Transport closed during ACK');
      acknowledged.push(id);
    },
    stopFrames,
    close: () => transportClosing ??= (async () => {
      stopFrames();
      await options.close?.();
      transportClosed = true;
    })(),
  };
  const settings = CaptureSettingsSchema.parse({
    mode: 'motion',
    viewport: options.viewport ?? { width: 320, height: 240 },
    maskRects: [{ x: 0, y: 0, width: 20, height: 20 }],
  });
  if (settings.mode !== 'motion') throw new Error('Expected motion');
  const budget: CaptureBudget = options.budget ?? { count: 0, bytes: 0, rawBytes: 0, sanitizedBytes: 0 };
  const recorder = await MotionRecorder.fromTransport(
    transport,
    settings,
    run,
    options.side ?? 'before',
    'stream',
    budget,
    (code) => faults.push(code),
    persist,
    options.createSanitizer,
  );
  const bytes = PNG.sync.write(new PNG({ ...settings.viewport }));
  const event = (sessionId: number, time = performance.now() / 1000) => ({
    sessionId,
    data: bytes.toString('base64'),
    metadata: {
      monotonicTimestamp: time,
      pageScaleFactor: 1,
      offsetTop: 0,
      deviceWidth: settings.viewport.width,
      deviceHeight: settings.viewport.height,
      scrollOffsetX: 0,
      scrollOffsetY: 0,
    },
  });
  const send = (value: unknown) => {
    if (transportClosed) throw new Error('Transport is closed');
    if (framesStopped) throw new Error('Frame subscription is stopped');
    if (!receiver) throw new Error('Missing stream listener');
    receiver(value);
  };
  return { recorder, event, send, root, run, budget, faults, acknowledged, controller, settings };
}
describe('bounded frame stream protocol', () => {
  it('fails queue overflow explicitly and drains only its two bounded raw frames', async () => {
    const h = await streamHarness();
    h.send(h.event(1));
    h.send(h.event(2, performance.now() / 1000 + 0.001));
    h.send(h.event(3, performance.now() / 1000 + 0.002));
    await h.recorder.stop();
    const result = MotionTrackSchema.parse(h.recorder.result());
    expect(result.status).toBe('failed');
    expect(h.faults).toEqual(['CAPTURE_QUEUE_OVERFLOW']);
    expect(result.stats).toMatchObject({
      receivedFrames: 3,
      persistedFrames: 2,
      acknowledgedFrames: 3,
      rejectedFrames: 1,
      maxQueueDepth: 2,
      sourceDroppedFrames: null,
    });
    expect(h.budget.rawBytes).toBe(0);
  });
  it('rejects missing source clocks, scale mismatches, and malformed PNGs without writing raw frames', async () => {
    for (const variant of ['missing-clock', 'scale', 'png']) {
      const h = await streamHarness();
      const original = h.event(1);
      const event =
        variant === 'missing-clock'
          ? { ...original, metadata: { pageScaleFactor: 1 } }
          : variant === 'scale'
            ? { ...original, metadata: { ...original.metadata, pageScaleFactor: 2 } }
            : { ...original, data: Buffer.from('private invalid PNG').toString('base64') };
      h.send(event);
      await h.recorder.stop();
      const result = h.recorder.result();
      expect(result.status).toBe('failed');
      expect(result.frames).toEqual([]);
      expect(h.budget.rawBytes).toBe(0);
      expect(await readdir(h.root)).toEqual([]);
      expect(h.faults[0]).toBe(
        variant === 'missing-clock'
          ? 'CAPTURE_CLOCK_UNSUPPORTED'
          : variant === 'scale'
            ? 'CAPTURE_METADATA_INVALID'
            : 'CAPTURE_PNG_INVALID',
      );
    }
  });
  it('retains the fixed mapping on a regressing timestamp and acknowledges actual processing', async () => {
    const h = await streamHarness();
    const time = performance.now() / 1000;
    h.send(h.event(1, time));
    h.send(h.event(2, time));
    await h.recorder.stop();
    const result = MotionTrackSchema.parse(h.recorder.result());
    expect(result.status).toBe('failed');
    expect(result.frames).toHaveLength(1);
    expect(h.faults).toEqual(['CAPTURE_TIMESTAMP_REGRESSION']);
    expect(result.stats.acknowledgedFrames).toBe(2);
  });
  it.each([
    { relation: 'equal', difference: 0 },
    { relation: 'backward', difference: -0.001 },
  ])('records bounded scalar evidence for a $relation source timestamp', async ({ relation, difference }) => {
    const events: string[] = [];
    const h = await streamHarness(undefined, { diagnostics: { event: (value) => events.push(value) } });
    const time = performance.now() / 1000;
    h.send(h.event(1, time));
    await until(() => h.acknowledged.length === 1);
    h.send({ ...h.event(2, time + difference), url: 'https://private.invalid/secret', text: 'private-sentinel' });
    await until(() => h.faults.length === 1);
    h.send(h.event(3, time));
    await h.recorder.stop();
    const records = events.map((value) => JSON.parse(value)).filter((value) => value.kind === 'capture-timestamp-rejection');
    expect(records).toHaveLength(1);
    expect(records[0]).toEqual({
      kind: 'capture-timestamp-rejection',
      side: 'before',
      current: { sequence: 1, sourceSeconds: time + difference, receivedMs: expect.any(Number) },
      previousReceived: { sequence: 0, sourceSeconds: time, receivedMs: expect.any(Number) },
      lastAccepted: { sequence: 0, sourceSeconds: time, receivedMs: expect.any(Number) },
      deltaSeconds: time + difference - time,
      relation,
    });
    expect(records[0].previousReceived).toEqual(records[0].lastAccepted);
    expect(JSON.stringify(records)).not.toContain('private');
    const result = MotionTrackSchema.parse(h.recorder.result());
    expect(result.status).toBe('failed');
    expect(h.faults).toEqual(['CAPTURE_TIMESTAMP_REGRESSION']);
    expect(result.frames.map((frame) => frame.sourceMonotonicSeconds)).toEqual([time]);
    expect(result.stats).toMatchObject({ receivedFrames: 3, persistedFrames: 1, rejectedFrames: 2, acknowledgedFrames: 3 });
    expect(h.budget.rawBytes).toBe(0);
    expect(h.budget.sanitizedBytes).toBe(0);
  });
  it('captures the previous received observation before asynchronous masking advances', async () => {
    const events: string[] = [];
    let entered = false;
    let release = () => {};
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const h = await streamHarness(undefined, {
      diagnostics: { event: (value) => events.push(value) },
      createSanitizer: () => ({
        ready: Promise.resolve(),
        onFailure: () => () => {},
        sanitize: async (bytes) => {
          entered = true;
          await blocked;
          return sanitizeFrame(bytes, { width: 320, height: 240 }, [{ x: 0, y: 0, width: 20, height: 20 }]);
        },
        close: async () => {},
      }),
    });
    const time = performance.now() / 1000;
    h.send(h.event(1, time));
    await until(() => entered);
    h.send(h.event(2, time - 0.001));
    release();
    await h.recorder.stop();
    const records = events.map((value) => JSON.parse(value)).filter((value) => value.kind === 'capture-timestamp-rejection');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      current: { sequence: 1, sourceSeconds: time - 0.001 },
      previousReceived: { sequence: 0, sourceSeconds: time },
      lastAccepted: { sequence: 0, sourceSeconds: time },
      relation: 'backward',
    });
    expect(h.faults).toEqual(['CAPTURE_TIMESTAMP_REGRESSION']);
    expect(h.acknowledged).toEqual([1, 2]);
    expect(h.budget.rawBytes).toBe(0);
  });
  it('preserves timestamp failure and raw ownership when its diagnostic sink throws', async () => {
    let attempts = 0;
    const h = await streamHarness(undefined, {
      diagnostics: {
        event(value) {
          if (JSON.parse(value).kind === 'capture-timestamp-rejection') {
            attempts++;
            throw new Error('diagnostic sink unavailable');
          }
        },
      },
    });
    const time = performance.now() / 1000;
    h.send(h.event(1, time));
    h.send(h.event(2, time));
    await h.recorder.stop();
    const result = MotionTrackSchema.parse(h.recorder.result());
    expect(attempts).toBe(1);
    expect(h.faults).toEqual(['CAPTURE_TIMESTAMP_REGRESSION']);
    expect(result.status).toBe('failed');
    expect(result.stats).toMatchObject({ receivedFrames: 2, persistedFrames: 1, rejectedFrames: 1, acknowledgedFrames: 2 });
    expect(h.acknowledged).toEqual([1, 2]);
    expect(h.budget.rawBytes).toBe(0);
    expect(h.budget.sanitizedBytes).toBe(0);
  });
  it('accepts a static stream and stops cleanly under cancellation backpressure', async () => {
    const h = await streamHarness();
    h.send(h.event(1));
    await h.recorder.stop();
    expect(MotionTrackSchema.parse(h.recorder.result()).status).toBe('ok');
    const cancelled = await streamHarness();
    cancelled.send(cancelled.event(1));
    cancelled.controller.abort();
    await cancelled.recorder.stop();
    expect(cancelled.recorder.result().status).toBe('failed');
    expect(cancelled.budget.rawBytes).toBe(0);
    expect(cancelled.acknowledged).toEqual([1]);
    expect(await readdir(cancelled.root)).toEqual([]);
  });
});

async function until(condition: () => boolean): Promise<void> {
  const deadline = performance.now() + 1000;
  while (!condition()) {
    if (performance.now() > deadline) throw new Error('Stream condition did not settle');
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
describe('sanitized persistence queue', () => {
  it('acknowledges released raw frames before slow durability writes and drains before returning', async () => {
    let release = () => {};
    let detached = false;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = await streamHarness(
      async (path, bytes) => {
        await gate;
        await writeRunFile(h.run, path, bytes);
      },
      { close: async () => { detached = true; } },
    );
    h.send(h.event(1));
    await until(() => h.acknowledged.length === 1);
    h.send(h.event(2));
    await until(() => h.acknowledged.length === 2);
    expect(h.recorder.result().stats.persistedFrames).toBe(0);
    expect(h.budget.rawBytes).toBe(0);
    expect(h.budget.sanitizedBytes).toBeGreaterThan(0);
    let finished = false;
    const stopped = h.recorder.stop().then(() => {
      finished = true;
    });
    await until(() => detached);
    expect(finished).toBe(false);
    const stopTime = h.recorder.captureEndMs();
    release();
    await stopped;
    expect(h.recorder.captureEndMs()).toBe(stopTime);
    expect(MotionTrackSchema.parse(h.recorder.result()).status).toBe('ok');
    expect(h.recorder.result().frames).toHaveLength(2);
    expect(h.budget.sanitizedBytes).toBe(0);
    expect(await readdir(join(h.root, 'frames'))).toHaveLength(2);
  });
  it('reports failed writes, discards queued safe bytes, and starts no later write', async () => {
    let writes = 0;
    const h = await streamHarness(async () => {
      writes++;
      throw new Error('Synthetic disk failure');
    });
    h.send(h.event(1));
    h.send(h.event(2, performance.now() / 1000 + 0.001));
    await h.recorder.stop();
    const result = MotionTrackSchema.parse(h.recorder.result());
    expect(result.status).toBe('failed');
    expect(h.faults).toEqual(['CAPTURE_WRITE_FAILED']);
    expect(writes).toBe(1);
    expect(result.stats.persistedFrames).toBe(0);
    expect(result.stats.rejectedFrames).toBe(2);
    expect(h.budget.sanitizedBytes).toBe(0);
    expect(h.budget.rawBytes).toBe(0);
    expect(await readdir(h.root)).toEqual([]);
  });
  it('counts a completed safe in-flight write on cancellation and releases later queued frames', async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let writes = 0;
    const h = await streamHarness(async (path, bytes) => {
      writes++;
      await gate;
      await writeRunFile(h.run, path, bytes);
    });
    h.send(h.event(1));
    await until(() => h.acknowledged.length === 1);
    h.send(h.event(2));
    await until(() => h.acknowledged.length === 2);
    h.controller.abort();
    release();
    await h.recorder.stop();
    const result = MotionTrackSchema.parse(h.recorder.result());
    expect(result.status).toBe('failed');
    expect(writes).toBe(1);
    expect(result.stats.persistedFrames).toBe(1);
    expect(result.stats.rejectedFrames).toBe(1);
    expect(h.faults).toEqual(['CAPTURE_CANCELLED']);
    expect(h.budget.rawBytes).toBe(0);
    expect(h.budget.sanitizedBytes).toBe(0);
    expect(await readdir(join(h.root, 'frames'))).toHaveLength(1);
  });
});

describe('sanitized queue caps', () => {
  it('applies ACK backpressure below hard caps and releases it when safe writes progress', async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = await streamHarness(async () => {
      await gate;
    });
    for (let index = 0; index < 127; index++) {
      h.send(h.event(index));
      await until(() => h.acknowledged.length === index + 1);
    }
    h.send(h.event(127));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.acknowledged).toHaveLength(127);
    expect(h.recorder.result().stats.receivedFrames).toBe(128);
    expect(h.budget.rawBytes).toBe(0);
    release();
    await until(() => h.acknowledged.length === 128);
    await h.recorder.stop();
    const result = MotionTrackSchema.parse(h.recorder.result());
    expect(result.status).toBe('ok');
    expect(result.stats.persistedFrames).toBe(128);
    expect(result.stats.rejectedFrames).toBe(0);
    expect(h.budget.sanitizedBytes).toBe(0);
  });
  it('fails the shared byte cap before persisting the affected frame', async () => {
    const h = await streamHarness();
    h.budget.sanitizedBytes = 32 * 1024 ** 2;
    h.send(h.event(1));
    await h.recorder.stop();
    expect(h.faults).toEqual(['CAPTURE_SANITIZED_QUEUE_LIMIT']);
    expect(h.recorder.result().frames).toEqual([]);
    expect(await readdir(h.root)).toEqual([]);
  });
});

describe('capture drain deadline', () => {
  it('prevents later writes after cleanup deadline and preserves the incomplete published track', async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let writes = 0;
    const h = await streamHarness(async (path, bytes) => {
      writes++;
      await gate;
      await writeRunFile(h.run, path, bytes);
    });
    h.send(h.event(1));
    await until(() => h.acknowledged.length === 1);
    h.send(h.event(2));
    await until(() => h.acknowledged.length === 2);
    const stopped = h.recorder.stop(performance.now() + 5);
    const rejected = expect(stopped).rejects.toMatchObject({ code: 'CAPTURE_DRAIN_TIMEOUT' });
    await rejected;
    const published = h.recorder.result();
    expect(h.budget.sanitizedBytes).toBeGreaterThan(0);
    release();
    await until(() => h.budget.sanitizedBytes === 0);
    const result = MotionTrackSchema.parse(h.recorder.result());
    expect(result.status).toBe('failed');
    expect(h.faults).toEqual(['CAPTURE_DRAIN_TIMEOUT']);
    expect(writes).toBe(1);
    expect(result).toEqual(published);
    expect(result.stats.persistedFrames).toBe(0);
    expect(result.stats.receivedFrames).toBe(2);
    expect(await readdir(join(h.root, 'frames'))).toHaveLength(1);
    expect(h.budget.sanitizedBytes).toBe(0);
  });
});

import { MaskWorker } from '../../src/recorder/masker.js';
function workerSettings() {
  const settings = CaptureSettingsSchema.parse({
    mode: 'motion',
    viewport: { width: 391, height: 845 },
    maskRects: [{ x: 3, y: 5, width: 17, height: 21 }],
  });
  if (settings.mode !== 'motion') throw new Error('Expected motion');
  return settings;
}
describe('real owned mask worker', () => {
  it('loads tool source, transfers only exact payloads, verifies opaque masks, and closes idempotently', async () => {
    const controller = new AbortController();
    const worker = new MaskWorker(workerSettings(), controller.signal);
    try {
      await worker.ready;
      const image = new PNG({ width: 391, height: 845 });
      image.data.fill(255);
      const original = PNG.sync.write(image);
      const backing = Buffer.alloc(original.length + 100, 0x78);
      original.copy(backing, 31);
      const payload = backing.subarray(31, 31 + original.length);
      const result = PNG.sync.read(await worker.sanitize(payload));
      for (let y = 5; y < 26; y++)
        for (let x = 3; x < 20; x++) {
          const p = (y * 391 + x) * 4;
          expect([...result.data.subarray(p, p + 4)]).toEqual([16, 16, 16, 255]);
        }
      expect([...result.data.subarray(0, 4)]).toEqual([255, 255, 255, 255]);
    } finally {
      await worker.close();
      await worker.close();
    }
  });
  it('rejects malformed PNG with a fixed code and terminates pending work on abort', async () => {
    const controller = new AbortController();
    const worker = new MaskWorker(workerSettings(), controller.signal);
    try {
      await worker.ready;
      await expect(worker.sanitize(Buffer.from('private malformed frame'))).rejects.toMatchObject({
        code: 'CAPTURE_PNG_INVALID',
      });
      const image = PNG.sync.write(new PNG({ width: 391, height: 845 }));
      const pending = worker.sanitize(image);
      controller.abort();
      await expect(pending).rejects.toMatchObject({ code: 'CAPTURE_WORKER_STOPPED' });
    } finally {
      await worker.close();
    }
  });
  it('reports startup failure without raw worker exceptions and enforces RPC queue bounds', async () => {
    const settings = workerSettings();
    settings.viewport.width = 1;
    const broken = new MaskWorker(settings, new AbortController().signal);
    try {
      await expect(broken.ready).rejects.toMatchObject({ code: 'CAPTURE_WORKER_FAILED' });
    } finally {
      await broken.close();
    }
    const controller = new AbortController();
    const worker = new MaskWorker(workerSettings(), controller.signal);
    try {
      await worker.ready;
      const bytes = PNG.sync.write(new PNG({ width: 391, height: 845 }));
      const pending = [worker.sanitize(Buffer.from(bytes)), worker.sanitize(Buffer.from(bytes)), worker.sanitize(Buffer.from(bytes))];
      await expect(worker.sanitize(Buffer.from(bytes))).rejects.toMatchObject({ code: 'CAPTURE_WORKER_QUEUE_LIMIT' });
      await Promise.all(pending);
    } finally {
      await worker.close();
    }
  });
});

import { Worker as NodeWorker } from 'node:worker_threads';
import type { FrameSanitizer } from '../../src/recorder/masker.js';
import { sourceTarget } from '../../src/recorder/source-loader.js';
function nodeWorker(worker: MaskWorker): NodeWorker {
  const value: unknown = Reflect.get(worker, 'worker');
  if (!(value instanceof NodeWorker)) throw new Error('Missing owned fault-injection target');
  return value;
}
describe('worker lifecycle regressions from independent review', () => {
  it('closes a never-settling sanitize RPC at the cleanup deadline and releases raw accounting', async () => {
    let closes = 0;
    const h = await streamHarness(undefined, {
      createSanitizer: () => ({
        ready: Promise.resolve(),
        onFailure: () => () => {},
        sanitize: () => new Promise<Buffer>(() => {}),
        close: async () => {
          closes++;
        },
      }),
    });
    h.send(h.event(1));
    await new Promise((resolve) => setTimeout(resolve, 1));
    await expect(h.recorder.stop(performance.now() + 10)).rejects.toMatchObject({ code: 'CAPTURE_DRAIN_TIMEOUT' });
    expect(closes).toBeGreaterThan(0);
    expect(h.recorder.result().status).toBe('failed');
    expect(h.faults).toEqual(['CAPTURE_DRAIN_TIMEOUT']);
    expect(h.budget.rawBytes).toBe(0);
    expect(h.budget.sanitizedBytes).toBe(0);
  });
  it('fails a track when its real sanitizer exits while idle and joins one termination promise', async () => {
    const settings = CaptureSettingsSchema.parse({
      mode: 'motion',
      viewport: { width: 320, height: 240 },
      maskRects: [{ x: 0, y: 0, width: 20, height: 20 }],
    });
    if (settings.mode !== 'motion') throw new Error('Expected motion');
    let worker: MaskWorker | undefined;
    const h = await streamHarness(undefined, {
      createSanitizer: () => {
        worker = new MaskWorker(settings, new AbortController().signal);
        return worker;
      },
    });
    h.send(h.event(1));
    await until(() => h.recorder.result().frames.length === 1);
    if (!worker) throw new Error('Missing worker');
    await nodeWorker(worker).terminate();
    await until(() => h.faults.length > 0);
    await h.recorder.stop();
    expect(h.recorder.result().status).toBe('failed');
    expect(h.faults).toEqual(['CAPTURE_WORKER_EXIT']);
    expect(worker.close()).toBe(worker.close());
  });
  it('cannot start the source after disposal while calibration is paused', async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let dispose: ((deadline: number) => Promise<void>) | undefined;
    let sampled = false;
    let starts = 0;
    const starting = streamHarness(undefined, {
      register: (resource) => {
        dispose = resource.dispose;
      },
      metrics: async () => {
        sampled = true;
        await gate;
        return { metrics: [{ name: 'Timestamp', value: performance.now() / 1000 }] };
      },
      onStart: () => {
        starts++;
      },
    });
    await until(() => sampled && dispose !== undefined);
    if (!dispose) throw new Error('Missing disposer');
    await dispose(performance.now() + 100);
    const h = await starting;
    release();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(starts).toBe(0);
    expect(h.recorder.result().status).toBe('failed');
    expect(h.budget.rawBytes).toBe(0);
  });
  it('settles readiness and source construction when disposed before readiness', async () => {
    let dispose: ((deadline: number) => Promise<void>) | undefined;
    let closes = 0;
    let starts = 0;
    const starting = streamHarness(undefined, {
      register: (resource) => {
        dispose = resource.dispose;
      },
      createSanitizer: () => ({
        ready: new Promise<void>(() => {}),
        onFailure: () => () => {},
        sanitize: async () => {
          throw new Error('Unexpected sanitize');
        },
        close: async () => {
          closes++;
        },
      }),
      onStart: () => {
        starts++;
      },
    });
    await until(() => dispose !== undefined);
    if (!dispose) throw new Error('Missing disposer');
    await dispose(performance.now() + 100);
    const h = await starting;
    expect(closes).toBeGreaterThan(0);
    expect(starts).toBe(0);
    expect(h.recorder.result().status).toBe('failed');
  });
  it('settles abort before real worker readiness and restricts normalized loader targets', async () => {
    const controller = new AbortController();
    controller.abort();
    const worker = new MaskWorker(workerSettings(), controller.signal);
    await expect(worker.ready).rejects.toMatchObject({ code: 'CAPTURE_WORKER_STOPPED' });
    await worker.close();
    const root = 'file:///owned/tool/src/';
    expect(sourceTarget('../schema/index.js', root + 'recorder/mask-worker.ts', root)).toBe(root + 'schema/index.ts');
    expect(sourceTarget('../../../outside.js', root + 'recorder/mask-worker.ts', root)).toBeNull();
    expect(sourceTarget('./inside.js', 'file:///unowned/src/file.ts', root)).toBeNull();
    expect(sourceTarget('pngjs', root + 'recorder/mask-worker.ts', root)).toBeNull();
  });
  it('rejects unknown codes, duplicate readiness, unknown ids, and invalid success payloads as protocol failures', async () => {
    for (const reply of [
      { kind: 'error', id: 0, code: 'PRIVATE-ERROR-TEXT' },
      { kind: 'ready' },
      { kind: 'ok', id: 999, bytes: new Uint8Array(1) },
      { kind: 'ok', id: 0, bytes: new Uint8Array(16 * 1024 ** 2 + 1) },
      { kind: 'ok', id: 0, bytes: new Uint8Array(new ArrayBuffer(10), 1, 2) },
    ]) {
      const worker = new MaskWorker(workerSettings(), new AbortController().signal);
      const failures: string[] = [];
      worker.onFailure((code) => failures.push(code));
      try {
        await worker.ready;
        nodeWorker(worker).emit('message', reply);
        await worker.close();
        expect(failures).toEqual(['CAPTURE_WORKER_PROTOCOL']);
      } finally {
        await worker.close();
      }
    }
  }, 20000);
});
import { reserveCheckpoint } from '../../src/recorder/motion.js';
describe('checkpoint admission before screenshot allocation', () => {
  it('waits for shared raw capacity and releases its envelope exactly once', async () => {
    const h = await streamHarness();
    const settings = workerSettings();
    h.budget.rawBytes = 127 * 1024 ** 2;
    let admitted = false;
    const pending = reserveCheckpoint(h.budget, settings, h.run, performance.now() + 1000).then((release) => {
      admitted = true;
      return release;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(admitted).toBe(false);
    h.budget.rawBytes = 0;
    const release = await pending;
    expect(h.budget.rawBytes).toBeGreaterThan(32 * 1024 ** 2);
    release();
    release();
    expect(h.budget.rawBytes).toBe(0);
    await h.recorder.stop();
  });
  it('releases no unreserved bytes on timeout or cancellation', async () => {
    const h = await streamHarness();
    h.budget.rawBytes = 127 * 1024 ** 2;
    await expect(reserveCheckpoint(h.budget, workerSettings(), h.run, performance.now() + 5)).rejects.toMatchObject({
      code: 'STEP_TIMEOUT',
    });
    expect(h.budget.rawBytes).toBe(127 * 1024 ** 2);
    h.controller.abort();
    await expect(reserveCheckpoint(h.budget, workerSettings(), h.run, performance.now() + 100)).rejects.toMatchObject({
      code: 'CAPTURE_CANCELLED',
    });
    expect(h.budget.rawBytes).toBe(127 * 1024 ** 2);
    h.budget.rawBytes = 0;
    await h.recorder.stop();
  });
});

function contentionPng(viewport: { width: number; height: number }): string {
  const source = new PNG({ ...viewport });
  source.data.fill(255);
  if (viewport.width === 1280) {
    let random = 1;
    for (let index = 0; index < 512 * 1024; index++) {
      random ^= random << 13;
      random ^= random >>> 17;
      random ^= random << 5;
      source.data[index] = random & 255;
    }
  }
  return PNG.sync.write(source).toString('base64');
}
describe('raw allocation phases under checkpoint contention', () => {
  for (const viewport of [{ width: 1280, height: 800 }, { width: 1920, height: 1080 }]) {
    it(`retains all arriving frames and waits for decode capacity at ${viewport.width} by ${viewport.height}`, async () => {
      const encoded = contentionPng(viewport);
      let rawBytes = 0;
      let peakRawBytes = 0;
      const budget: CaptureBudget = {
        count: 0,
        bytes: 0,
        sanitizedBytes: 0,
        get rawBytes() { return rawBytes; },
        set rawBytes(value) { rawBytes = value; peakRawBytes = Math.max(peakRawBytes, value); },
      };
      let started = 0;
      let unblocked = false;
      const finish: (() => void)[] = [];
      const written: Buffer[] = [];
      const createSanitizer = () => ({
        ready: Promise.resolve(),
        onFailure: () => () => {},
        sanitize: async (bytes: Buffer) => {
          started++;
          if (!unblocked) await new Promise<void>((resolve) => finish.push(resolve));
          return sanitizeFrame(bytes, viewport, [{ x: 0, y: 0, width: 20, height: 20 }]);
        },
        close: async () => {},
      });
      const persist: FramePersistence = async (_path, bytes) => { written.push(bytes); };
      const before = await streamHarness(persist, { viewport, budget, createSanitizer });
      const after = await streamHarness(persist, { viewport, budget, createSanitizer, side: 'after' });
      const releaseBefore = await reserveCheckpoint(budget, before.settings, before.run, performance.now() + 1000);
      const releaseAfter = await reserveCheckpoint(budget, after.settings, after.run, performance.now() + 1000);
      try {
        for (const h of [before, after]) {
          h.send({ ...h.event(1), data: encoded });
          h.send({ ...h.event(2, performance.now() / 1000 + 0.001), data: encoded });
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect([...before.faults, ...after.faults]).toEqual([]);
        expect(started).toBe(viewport.width === 1280 ? 1 : 0);
        expect([...before.acknowledged, ...after.acknowledged]).toEqual([]);
        if (started) {
          finish.shift()?.();
          await expect.poll(() => started).toBe(2);
        } else {
          releaseBefore();
          await expect.poll(() => started).toBeGreaterThan(0);
        }
      } finally {
        releaseBefore();
        releaseAfter();
        unblocked = true;
        for (const resolve of finish.splice(0)) resolve();
        await Promise.all([before.recorder.stop(), after.recorder.stop()]);
      }
      for (const h of [before, after]) {
        expect(h.faults).toEqual([]);
        expect(h.recorder.result().stats).toMatchObject({
          receivedFrames: 2, persistedFrames: 2, acknowledgedFrames: 2, rejectedFrames: 0, maxQueueDepth: 2,
        });
      }
      expect(written).toHaveLength(4);
      for (const bytes of written) {
        const image = PNG.sync.read(bytes);
        expect([...image.data.subarray(0, 4)]).toEqual([16, 16, 16, 255]);
      }
      expect(budget.rawBytes).toBe(0);
      expect(peakRawBytes).toBeLessThanOrEqual(128 * 1024 ** 2);
    });
  }
  for (const interruption of ['abort', 'deadline'] as const) {
    it(`releases a frame waiting for decode capacity on ${interruption}`, async () => {
      let sanitized = 0;
      const viewport = { width: 1920, height: 1080 };
      const h = await streamHarness(undefined, {
        viewport,
        createSanitizer: () => ({
          ready: Promise.resolve(),
          onFailure: () => () => {},
          sanitize: async (bytes) => { sanitized++; return bytes; },
          close: async () => {},
        }),
      });
      const first = await reserveCheckpoint(h.budget, h.settings, h.run, performance.now() + 1000);
      const second = await reserveCheckpoint(h.budget, h.settings, h.run, performance.now() + 1000);
      const checkpointBytes = h.budget.rawBytes;
      try {
        h.send(h.event(1));
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(sanitized).toBe(0);
        expect(h.acknowledged).toEqual([]);
        if (interruption === 'abort') h.controller.abort();
        await h.recorder.stop(performance.now() + 20).catch((error: unknown) => {
          expect(error).toMatchObject({ code: 'CAPTURE_DRAIN_TIMEOUT' });
        });
        expect(h.faults).toEqual([interruption === 'abort' ? 'CAPTURE_CANCELLED' : 'CAPTURE_DRAIN_TIMEOUT']);
        expect(h.recorder.result().stats).toMatchObject({ receivedFrames: 1, persistedFrames: 0, rejectedFrames: 1 });
        expect(sanitized).toBe(0);
        expect(h.budget.rawBytes).toBe(checkpointBytes);
      } finally {
        first();
        second();
      }
      expect(h.budget.rawBytes).toBe(0);
    });
  }
  for (const releaseCapacity of [false, true]) {
    it(`rejects a never-decoded frame when the drain timer fires early with capacity ${releaseCapacity ? 'released' : 'held'}`, async () => {
      let sanitized = 0;
      let persisted = 0;
      const h = await streamHarness(async () => { persisted++; }, {
        viewport: { width: 1920, height: 1080 },
        createSanitizer: () => ({
          ready: Promise.resolve(),
          onFailure: () => () => {},
          sanitize: async (bytes) => { sanitized++; return bytes; },
          close: async () => {},
        }),
      });
      const first = await reserveCheckpoint(h.budget, h.settings, h.run, performance.now() + 1000);
      const second = await reserveCheckpoint(h.budget, h.settings, h.run, performance.now() + 1000);
      const checkpointBytes = h.budget.rawBytes;
      try {
        h.send(h.event(1));
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(sanitized).toBe(0);
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const deadline = performance.now() + 1000;
        const stopped = expect(h.recorder.stop(deadline)).rejects.toMatchObject({ code: 'CAPTURE_DRAIN_TIMEOUT' });
        await vi.advanceTimersByTimeAsync(1000);
        await stopped;
        expect(performance.now()).toBeLessThan(deadline);
        expect(h.faults).toEqual(['CAPTURE_DRAIN_TIMEOUT']);
        if (!releaseCapacity) {
          expect(h.recorder.result().stats).toMatchObject({ receivedFrames: 1, persistedFrames: 0, rejectedFrames: 1 });
          expect(h.budget.rawBytes).toBe(checkpointBytes);
        }
        first();
        second();
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(sanitized).toBe(0);
        expect(persisted).toBe(0);
        expect(h.recorder.result().stats).toMatchObject({ receivedFrames: 1, persistedFrames: 0, rejectedFrames: 1 });
        expect(h.budget.rawBytes).toBe(0);
      } finally {
        first();
        second();
        vi.useRealTimers();
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    });
  }
  it('wakes the peer decoder when masking fails and retains the original frame failure', async () => {
    const viewport = { width: 1280, height: 800 };
    const encoded = contentionPng(viewport);
    let rejectMask: (error: Error) => void = () => {};
    let started = 0;
    const before = await streamHarness(undefined, {
      viewport,
      createSanitizer: () => ({
        ready: Promise.resolve(),
        onFailure: () => () => {},
        sanitize: async () => {
          started++;
          return new Promise<Buffer>((_resolve, reject) => { rejectMask = reject; });
        },
        close: async () => {},
      }),
    });
    const after = await streamHarness(async () => {}, { viewport, budget: before.budget, side: 'after' });
    const first = await reserveCheckpoint(before.budget, before.settings, before.run, performance.now() + 1000);
    const second = await reserveCheckpoint(before.budget, before.settings, before.run, performance.now() + 1000);
    try {
      before.send({ ...before.event(1), data: encoded });
      after.send({ ...after.event(1), data: encoded });
      await expect.poll(() => started).toBe(1);
      expect(after.acknowledged).toEqual([]);
      rejectMask(new CaptureFault('CAPTURE_PNG_INVALID'));
      await expect.poll(() => after.acknowledged.length).toBe(1);
      expect(before.faults).toEqual(['CAPTURE_PNG_INVALID']);
      expect(after.faults).toEqual([]);
    } finally {
      first();
      second();
      rejectMask(new CaptureFault('CAPTURE_PNG_INVALID'));
      await Promise.all([before.recorder.stop(), after.recorder.stop()]);
    }
    expect(after.recorder.result().stats.persistedFrames).toBe(1);
    expect(before.budget.rawBytes).toBe(0);
  });
  it('rejects encoded payloads that would leave every decoder without eventual headroom', async () => {
    const viewport = { width: 1920, height: 1080 };
    const encoded = Buffer.alloc(8 * 1024 ** 2).toString('base64');
    const safe = PNG.sync.write(new PNG({ ...viewport }));
    const createSanitizer = () => ({
      ready: Promise.resolve(),
      onFailure: () => () => {},
      sanitize: async () => safe,
      close: async () => {},
    });
    const before = await streamHarness(async () => {}, { viewport, createSanitizer });
    const after = await streamHarness(async () => {}, { viewport, createSanitizer, budget: before.budget, side: 'after' });
    for (const h of [before, after]) {
      h.send({ ...h.event(1), data: encoded });
      h.send({ ...h.event(2, performance.now() / 1000 + 0.001), data: encoded });
    }
    expect(before.faults).toEqual([]);
    expect(after.faults).toEqual(['CAPTURE_RAW_MEMORY_LIMIT']);
    await Promise.all([before.recorder.stop(), after.recorder.stop()]);
    expect(before.recorder.result().stats.persistedFrames).toBe(2);
    expect(after.recorder.result().stats).toMatchObject({ persistedFrames: 1, rejectedFrames: 1 });
    expect(before.budget.rawBytes).toBe(0);
  });
});

describe('hung source shutdown deadlines', () => {
  it('bounds a hung CDP stop and joins sanitizer termination', async () => {
    let closes = 0;
    const h = await streamHarness(undefined, {
      stop: () => new Promise(() => {}),
      createSanitizer: () => ({
        ready: Promise.resolve(),
        onFailure: () => () => {},
        sanitize: async (bytes) => sanitizeFrame(bytes, { width: 320, height: 240 }, []),
        close: async () => {
          closes++;
        },
      }),
    });
    await expect(h.recorder.stop(performance.now() + 10)).rejects.toMatchObject({ code: 'CAPTURE_DRAIN_TIMEOUT' });
    expect(closes).toBeGreaterThan(0);
    expect(h.recorder.result().status).toBe('failed');
    expect(h.budget.rawBytes).toBe(0);
  });
  it('tightens an existing infinite stop wait when cleanup supplies a deadline', async () => {
    const h = await streamHarness(undefined, { stop: () => new Promise(() => {}) });
    const pending = h.recorder.stop();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const tightened = h.recorder.stop(performance.now() + 10);
    expect(tightened).toBe(pending);
    await expect(tightened).rejects.toMatchObject({ code: 'CAPTURE_DRAIN_TIMEOUT' });
    expect(h.recorder.result().status).toBe('failed');
  });
});

import { reserveCheckpointStorage, releaseCheckpointStorage, releaseArtifact } from '../../src/recorder/motion.js';
describe('checkpoint storage headroom', () => {
  it('retains safe partial frames and still persists reserved checkpoints when source admission reaches the total count limit', async () => {
    const h = await streamHarness();
    h.budget.count = 11997;
    reserveCheckpointStorage(h.budget, 2);
    h.send(h.event(1));
    h.send(h.event(2, performance.now() / 1000 + 0.001));
    await h.recorder.stop();
    const track = MotionTrackSchema.parse(h.recorder.result());
    expect(track.status).toBe('failed');
    expect(h.faults).toEqual(['CAPTURE_STORAGE_LIMIT']);
    expect(track.frames).toHaveLength(1);
    const frame = track.frames[0];
    if (!frame) throw new Error('Missing safe frame');
    const bytes = await import('node:fs/promises').then((fs) => fs.readFile(join(h.root, frame.artifact.path)));
    for (const path of ['frames/limit-before.png', 'frames/limit-after.png']) {
      reserveArtifact(h.budget, bytes.length, 'checkpoint');
      await writeRunFile(h.run, path, bytes);
    }
    expect(h.budget.count).toBe(12000);
    expect(h.budget.checkpoints?.remaining).toBe(0);
    expect(await readdir(join(h.root, 'frames'))).toHaveLength(3);
  });
  it('reserves byte headroom and releases failed checkpoint and unused cancellation reservations without exceeding limits', () => {
    const budget: import('../../src/recorder/motion.js').CaptureBudget = {
      count: 0,
      bytes: 10 * 1024 ** 3 - 2 * 16 * 1024 ** 2,
      rawBytes: 0,
      sanitizedBytes: 0,
    };
    reserveCheckpointStorage(budget, 2);
    expect(() => reserveArtifact(budget, 1)).toThrow('CAPTURE_STORAGE_LIMIT');
    reserveArtifact(budget, 123, 'checkpoint');
    releaseArtifact(budget, 123);
    expect(budget.count).toBe(0);
    expect(budget.checkpoints?.remaining).toBe(1);
    releaseCheckpointStorage(budget);
    releaseCheckpointStorage(budget);
    expect(budget.checkpoints?.remaining).toBe(0);
    expect(() => reserveCheckpointStorage(budget, Number.MAX_SAFE_INTEGER)).toThrow('CAPTURE_STORAGE_LIMIT');
    expect(() => reserveCheckpointStorage(budget, 73)).toThrow('CAPTURE_STORAGE_LIMIT');
    expect(() => reserveCheckpointStorage(budget, 1.5)).toThrow('CAPTURE_STORAGE_LIMIT');
  });
});

import { CaptureBundleSchema } from '../../src/schema/index.js';
import { render as renderComparison } from '../../src/composer/index.js';
import { readFile } from 'node:fs/promises';
describe('no usable capture boundary', () => {
  it('fails neutral-only capture before opening a renderer or encoding invented motion', async () => {
    const h = await streamHarness();
    const bundle = CaptureBundleSchema.parse(
      JSON.parse(await readFile(new URL('../fixtures/capture.json', import.meta.url), 'utf8')),
    );
    bundle.runId = h.run.runId;
    for (const scenario of bundle.scenarios) {
      scenario.outcome = 'partial';
      for (const step of scenario.steps) {
        step.changeRatio = null;
        for (const side of ['before', 'after'] as const) {
          step[side] = {
            ...step[side],
            status: 'failed',
            reasonCode: 'CAPTURE_CLOCK_UNSUPPORTED',
            imageKind: 'neutral',
            sanitization: { kind: 'neutral' },
          };
        }
      }
    }
    await expect(
      renderComparison(
        bundle,
        {
          coverage: { selected: [], unresolved: [], omitted: [], unsupported: [], complete: true },
          provenance: {
            before: { valid: true, actualHash: null, errors: [] },
            after: { valid: true, actualHash: null, errors: [] },
          },
        },
        h.run,
      ),
    ).rejects.toMatchObject({ exitCode: 9, detail: { code: 'CAPTURE_MEDIA_UNAVAILABLE' } });
    await h.recorder.stop();
  });
});

function gate() {
  let release = () => {};
  return {
    promise: new Promise<void>((resolve) => {
      release = resolve;
    }),
    release: () => release(),
  };
}
describe('every transport await follows recorder lifetime', () => {
  it('settles a hung marker on abort and disposal without waiting for the metrics response', async () => {
    const blocked = gate();
    let calls = 0,
      sampling = false;
    const h = await streamHarness(undefined, {
      metrics: async () => {
        if (++calls > 5) {
          sampling = true;
          await blocked.promise;
        }
        return { metrics: [{ name: 'Timestamp', value: performance.now() / 1000 }] };
      },
    });
    let status = 'pending';
    const marker = h.recorder.marker().then(
      () => {
        status = 'ok';
      },
      () => {
        status = 'failed';
      },
    );
    try {
      await until(() => sampling);
      h.controller.abort();
      await h.recorder.stop(performance.now() + 20);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(status).toBe('failed');
      expect(h.budget.rawBytes).toBe(0);
    } finally {
      blocked.release();
      await marker;
    }
  });
  it('bounds a hung final clock validation with the independent cleanup deadline', async () => {
    const blocked = gate();
    let calls = 0,
      final = false;
    const h = await streamHarness(undefined, {
      metrics: async () => {
        if (++calls > 5) {
          final = true;
          await blocked.promise;
        }
        return { metrics: [{ name: 'Timestamp', value: performance.now() / 1000 }] };
      },
    });
    h.send(h.event(1));
    await until(() => h.recorder.result().frames.length === 1);
    let settled = false;
    const stopped = h.recorder.stop(performance.now() + 10).then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    try {
      await until(() => final);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(settled).toBe(true);
      expect(h.recorder.result().status).toBe('failed');
      expect(h.faults).toEqual(['CAPTURE_DRAIN_TIMEOUT']);
    } finally {
      blocked.release();
      await stopped;
    }
  });
  it('settles factory disposal during a hung source start and does not claim clean shutdown', async () => {
    const blocked = gate();
    let entered = false;
    let dispose: ((deadline: number) => Promise<void>) | undefined;
    let settled = false;
    const starting = streamHarness(undefined, {
      start: async () => {
        entered = true;
        await blocked.promise;
      },
      register: (resource) => {
        dispose = resource.dispose;
      },
    });
    starting.then(() => {
      settled = true;
    });
    await until(() => entered && dispose !== undefined);
    if (!dispose) throw new Error('Missing disposer');
    let cleanup = 'pending';
    const stopped = dispose(performance.now() + 10).then(
      () => {
        cleanup = 'ok';
      },
      () => {
        cleanup = 'failed';
      },
    );
    try {
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(settled).toBe(true);
      expect(cleanup).toBe('failed');
    } finally {
      blocked.release();
      await starting;
      await stopped;
    }
  });
  it('bounds the cleanup request for a source that starts late after disposal', async () => {
    const blocked = gate(),
      lateStop = gate();
    let entered = false,
      stops = 0;
    let dispose: ((deadline: number) => Promise<void>) | undefined;
    let settled = false;
    const starting = streamHarness(undefined, {
      start: async () => {
        entered = true;
        await blocked.promise;
      },
      stop: async () => {
        if (++stops > 1) await lateStop.promise;
      },
      register: (resource) => {
        dispose = resource.dispose;
      },
    });
    starting.then(() => {
      settled = true;
    });
    await until(() => entered && dispose !== undefined);
    if (!dispose) throw new Error('Missing disposer');
    const stopped = dispose(performance.now() + 10).catch(() => {});
    try {
      await new Promise((resolve) => setTimeout(resolve, 20));
      blocked.release();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(settled).toBe(true);
      expect(stops).toBeGreaterThanOrEqual(2);
    } finally {
      blocked.release();
      lateStop.release();
      await starting;
      await stopped;
    }
  });
});

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
describe('actual recorder operation failure boundary', () => {
  it('stops and closes on step timeout without global abort and preserves early track fault time', async () => {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        '--experimental-transform-types',
        fileURLToPath(new URL('../../fixtures/motion/recorder-lifecycle-probe.mjs', import.meta.url)),
      ],
      { cwd: fileURLToPath(new URL('../../', import.meta.url)), timeout: 10000, env: { PATH: process.env.PATH ?? '' } },
    );
    const result: unknown = JSON.parse(stdout);
    expect(result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          probe: 'actual execute step timeout while dispatch marker metrics hang',
          executeStatus: 'failed',
          primaryCode: 'STEP_TIMEOUT',
          closeCalls: 1,
          runAborted: false,
        }),
        expect.objectContaining({
          probe: 'pre-scenario fault preserves original time and records fresh failed attempt',
          closeCalls: 1,
        }),
        expect.objectContaining({
          probe: 'actual checkpoint caller returns while failed cleanup retains worker raw ownership',
          primaryCode: 'STEP_TIMEOUT',
          cleanup: 'failed',
          closeCalls: 1,
          rawBytesAfterJoin: 0,
        }),
        ...['admitted', 'upstream-queued', 'reentrant'].map((stage) => expect.objectContaining({
          probe: 'pinned Playwright adapter subscription closure', stage, detachCalls: 1,
          status: stage === 'reentrant' ? 'failed' : 'ok',
        })),
      ]),
    );
  }, 15000);
});


describe('raw ownership through worker termination', () => {
  it('keeps the peer waiting while the aborted worker still retains its input', async () => {
    const closed = gate();
    let retained: Buffer | undefined;
    let closeStarted = false;
    const viewport = { width: 1280, height: 800 };
    const before = await streamHarness(undefined, {
      viewport,
      createSanitizer: () => ({
        ready: Promise.resolve(),
        onFailure: () => () => {},
        sanitize: (bytes) => { retained = bytes; return new Promise<Buffer>(() => {}); },
        close: async () => { closeStarted = true; await closed.promise; retained = undefined; },
      }),
    });
    const after = await streamHarness(async () => {}, { viewport, budget: before.budget, side: 'after' });
    const first = await reserveCheckpoint(before.budget, before.settings, before.run, performance.now() + 1000);
    const second = await reserveCheckpoint(before.budget, before.settings, before.run, performance.now() + 1000);
    const encoded = contentionPng(viewport);
    try {
      before.send({ ...before.event(1), data: encoded });
      await until(() => retained !== undefined);
      after.send({ ...after.event(1), data: encoded });
      const reserved = before.budget.rawBytes;
      before.controller.abort();
      let contextClosed = false;
      void before.recorder.contextMayClose().then(() => { contextClosed = true; });
      void before.recorder.stop().catch(() => {});
      await until(() => closeStarted);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(contextClosed).toBe(false);
      expect(before.acknowledged).toEqual([]);
      expect(retained?.length).toBeGreaterThan(0);
      expect(before.budget.rawBytes).toBe(reserved);
      expect(after.acknowledged).toEqual([]);
      closed.release();
      await expect.poll(() => after.acknowledged.length).toBe(1);
      expect(retained).toBeUndefined();
      expect(after.faults).toEqual([]);
    } finally {
      closed.release();
      first();
      second();
      await Promise.all([before.recorder.stop(), after.recorder.stop()]);
    }
    expect(before.budget.rawBytes).toBe(0);
  });
  it('fails bounded cleanup while close is pending and releases only after the late join', async () => {
    const closed = gate();
    let retained: Buffer | undefined;
    const h = await streamHarness(undefined, {
      createSanitizer: () => ({
        ready: Promise.resolve(),
        onFailure: () => () => {},
        sanitize: (bytes) => { retained = bytes; return new Promise<Buffer>(() => {}); },
        close: async () => { await closed.promise; retained = undefined; },
      }),
    });
    h.send(h.event(1));
    await until(() => retained !== undefined);
    const reserved = h.budget.rawBytes;
    let outcome = 'pending';
    const stopped = h.recorder.stop(performance.now() + 10).then(
      () => { outcome = 'ok'; },
      (error: unknown) => { expect(error).toMatchObject({ code: 'CAPTURE_DRAIN_TIMEOUT' }); outcome = 'failed'; },
    );
    try {
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(outcome).toBe('failed');
      expect(h.budget.rawBytes).toBe(reserved);
      expect(retained?.length).toBeGreaterThan(0);
      expect(h.faults).toEqual(['CAPTURE_DRAIN_TIMEOUT']);
      await h.recorder.contextMayClose();
    } finally {
      closed.release();
      await stopped;
    }
    await expect.poll(() => h.budget.rawBytes).toBe(0);
  });
  it('retains a checkpoint reservation after caller interruption until close joins', async () => {
    const closed = gate();
    let retained: Buffer | undefined;
    const h = await streamHarness(undefined, {
      createSanitizer: () => ({
        ready: Promise.resolve(),
        onFailure: () => () => {},
        sanitize: (bytes) => { retained = bytes; return new Promise<Buffer>(() => {}); },
        close: async () => { await closed.promise; retained = undefined; },
      }),
    });
    const release = await reserveCheckpoint(h.budget, h.settings, h.run, performance.now() + 1000);
    const reserved = h.budget.rawBytes;
    const pending = h.recorder.sanitizeCheckpoint(PNG.sync.write(new PNG(h.settings.viewport)), release);
    const interrupted = expect(pending).rejects.toMatchObject({ code: 'CAPTURE_CANCELLED' });
    h.controller.abort();
    try {
      await interrupted;
      expect(h.budget.rawBytes).toBe(reserved);
      expect(retained?.length).toBeGreaterThan(0);
      await expect(h.recorder.stop(performance.now() + 10)).rejects.toMatchObject({ code: 'CAPTURE_DRAIN_TIMEOUT' });
      expect(h.faults).toEqual(['CAPTURE_CANCELLED']);
    } finally {
      closed.release();
    }
    await expect.poll(() => h.budget.rawBytes).toBe(0);
    release();
    expect(h.budget.rawBytes).toBe(0);
  });
  it.each(['faulted', 'throws', 'rejects'])('releases a checkpoint exactly once when sanitizer admission %s', async (failure) => {
    const h = await streamHarness(undefined, {
      createSanitizer: () => ({
        ready: Promise.resolve(),
        onFailure: () => () => {},
        sanitize: () => {
          if (failure === 'throws') throw new CaptureFault('CAPTURE_PNG_INVALID');
          return Promise.reject(new CaptureFault('CAPTURE_PNG_INVALID'));
        },
        close: async () => {},
      }),
    });
    const release = await reserveCheckpoint(h.budget, h.settings, h.run, performance.now() + 1000);
    let releases = 0;
    if (failure === 'faulted') h.controller.abort();
    await expect((async () => h.recorder.sanitizeCheckpoint(Buffer.alloc(0), () => { releases++; release(); }))())
      .rejects.toMatchObject({ code: failure === 'faulted' ? 'CAPTURE_CANCELLED' : 'CAPTURE_PNG_INVALID' });
    await h.recorder.stop();
    expect(releases).toBe(1);
    expect(h.budget.rawBytes).toBe(0);
  });
  it('reports failed cleanup and retains uncertain raw ownership when termination rejects', async () => {
    let retained: Buffer | undefined;
    let finish: (bytes: Buffer) => void = () => {};
    const h = await streamHarness(undefined, {
      createSanitizer: () => ({
        ready: Promise.resolve(),
        onFailure: () => () => {},
        sanitize: (bytes) => {
          retained = bytes;
          return new Promise<Buffer>((resolve) => { finish = resolve; });
        },
        close: async () => { throw new Error('Synthetic failed termination'); },
      }),
    });
    h.send(h.event(1));
    await until(() => retained !== undefined);
    const reserved = h.budget.rawBytes;
    h.controller.abort();
    await expect(h.recorder.stop(performance.now() + 30)).rejects.toMatchObject({ code: 'CAPTURE_DRAIN_TIMEOUT' });
    expect(h.budget.rawBytes).toBe(reserved);
    expect(h.faults).toEqual(['CAPTURE_CANCELLED']);
    retained = undefined;
    finish(Buffer.alloc(0));
    await expect.poll(() => h.budget.rawBytes).toBe(0);
  });
  it('rejects pending real Worker RPCs only after termination joins', async () => {
    const controller = new AbortController();
    const worker = new MaskWorker(workerSettings(), controller.signal);
    await worker.ready;
    const owned = nodeWorker(worker);
    const terminate = owned.terminate.bind(owned);
    const allowed = gate();
    const termination = vi.spyOn(owned, 'terminate').mockImplementation(async () => {
      await allowed.promise;
      return terminate();
    });
    let outcome = 'pending';
    const pending = worker.sanitize(PNG.sync.write(new PNG({ width: 391, height: 845 }))).then(
      () => { outcome = 'ok'; },
      (error: unknown) => {
        expect(error).toMatchObject({ code: 'CAPTURE_WORKER_STOPPED' });
        outcome = owned.threadId === -1 ? 'joined' : 'unjoined';
      },
    );
    try {
      controller.abort();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(outcome).toBe('pending');
      expect(owned.threadId).not.toBe(-1);
      allowed.release();
      await pending;
      expect(outcome).toBe('joined');
    } finally {
      allowed.release();
      await worker.close();
      termination.mockRestore();
    }
  });
});


describe('motion delivery closure', () => {
  it('persists frames delivered after source stop while final metrics are pending', async () => {
    const finalSample = gate();
    let samples = 0, sampling = false, closes = 0;
    const h = await streamHarness(undefined, {
      metrics: async () => {
        if (++samples > 5) { sampling = true; await finalSample.promise; }
        return { metrics: [{ name: 'Timestamp', value: performance.now() / 1000 }] };
      },
      close: async () => { closes++; },
    });
    h.send(h.event(1));
    await until(() => h.acknowledged.length === 1);
    const late = h.event(2);
    const stopped = h.recorder.stop();
    try {
      await until(() => sampling);
      h.send(late);
    } finally {
      finalSample.release();
      await stopped;
    }
    const track = MotionTrackSchema.parse(h.recorder.result());
    expect(track.status).toBe('ok');
    expect(track.stats).toMatchObject({ receivedFrames: 2, persistedFrames: 2, acknowledgedFrames: 2, rejectedFrames: 0 });
    expect(track.frames[1]?.sourceMonotonicSeconds).toBe(late.metadata.monotonicTimestamp);
    expect(closes).toBe(1);
    expect(h.budget).toMatchObject({ rawBytes: 0, sanitizedBytes: 0 });
  });

  it('drains a narrow frame and its actual ACK after cutoff before detaching', async () => {
    const final = gate(), masking = gate(), ack = gate();
    let samples = 0, sampling = false, masks = 0, cutoff = false, detached = false, ackEntered = false;
    const h = await streamHarness(undefined, {
      viewport: { width: 391, height: 845 },
      metrics: async () => {
        if (++samples > 5) { sampling = true; await final.promise; }
        return { metrics: [{ name: 'Timestamp', value: performance.now() / 1000 }] };
      },
      stopFrames: () => { cutoff = true; },
      close: async () => { detached = true; },
      acknowledge: async (id) => { if (id === 2) { ackEntered = true; await ack.promise; } },
      createSanitizer: () => ({
        ready: Promise.resolve(), onFailure: () => () => {}, close: async () => {},
        sanitize: async (bytes) => {
          if (++masks > 1) await masking.promise;
          return sanitizeFrame(bytes, { width: 391, height: 845 }, [{ x: 0, y: 0, width: 20, height: 20 }]);
        },
      }),
    });
    h.send(h.event(1));
    await until(() => h.acknowledged.length === 1);
    const stopped = h.recorder.stop();
    try {
      await until(() => sampling);
      const sourceEnd = h.recorder.captureEndMs();
      h.send(h.event(2));
      await until(() => masks === 2);
      final.release();
      await until(() => cutoff);
      expect(detached).toBe(false);
      expect(h.recorder.result().stats.acknowledgedFrames).toBe(1);
      masking.release();
      await until(() => ackEntered);
      expect(detached).toBe(false);
      expect(h.recorder.result().stats.acknowledgedFrames).toBe(1);
      ack.release();
      await stopped;
      expect(h.recorder.captureEndMs()).toBe(sourceEnd);
    } finally {
      final.release(); masking.release(); ack.release(); await stopped;
    }
    const track = MotionTrackSchema.parse(h.recorder.result());
    expect(track.status).toBe('ok');
    expect(track.stats).toMatchObject({ receivedFrames: 2, persistedFrames: 2, acknowledgedFrames: 2, rejectedFrames: 0 });
    expect(detached).toBe(true);
    expect(h.faults).toEqual([]);
    expect(h.budget).toMatchObject({ rawBytes: 0, sanitizedBytes: 0 });
    for (const frame of track.frames) {
      const image = PNG.sync.read(await readFile(join(h.root, frame.artifact.path)));
      expect([...image.data.subarray(0, 4)]).toEqual([16, 16, 16, 255]);
    }
  });

  it('rejects an observed excluded callback and ACKs it without taking raw ownership', async () => {
    let excluded: ((sessionId: number | null) => void) | undefined;
    const events: string[] = [];
    const h = await streamHarness(undefined, {
      onFrame: (_listener, onAfterCutoff) => { excluded = onAfterCutoff; },
      stopFrames: () => { excluded?.(2); },
      diagnostics: { event: (value) => { events.push(value); } },
    });
    h.send(h.event(1));
    await until(() => h.acknowledged.length === 1);
    await h.recorder.stop();
    const track = MotionTrackSchema.parse(h.recorder.result());
    expect(track.status).toBe('failed');
    expect(h.faults).toEqual(['CAPTURE_DELIVERY_AFTER_CUTOFF']);
    expect(track.stats).toMatchObject({ receivedFrames: 2, persistedFrames: 1, acknowledgedFrames: 2, rejectedFrames: 1 });
    expect(h.acknowledged).toEqual([1, 2]);
    expect(h.budget).toMatchObject({ rawBytes: 0, sanitizedBytes: 0 });
    expect(events.map((value) => JSON.parse(value))).toContainEqual(expect.objectContaining({ kind: 'capture-shutdown-failure', code: 'CAPTURE_DELIVERY_AFTER_CUTOFF' }));
  });

  it('fails a synchronous cutoff error and still disposes the command channel', async () => {
    let closes = 0;
    const h = await streamHarness(undefined, {
      stopFrames: () => { throw new Error('Synthetic cutoff failure'); },
      close: async () => { closes++; },
    });
    h.send(h.event(1));
    await until(() => h.acknowledged.length === 1);
    await expect(h.recorder.stop()).rejects.toMatchObject({ code: 'CAPTURE_DRAIN_TIMEOUT' });
    expect(h.faults).toEqual(['CAPTURE_CUTOFF_FAILED']);
    expect(closes).toBe(1);
  });

  it.each(['reject', 'timeout'])('reports no confirmed source-stop time after a %s stop', async (mode) => {
    const stopping = gate();
    const events: string[] = [];
    const h = await streamHarness(undefined, {
      stop: async () => {
        if (mode === 'reject') throw new Error('Synthetic source-stop rejection');
        await stopping.promise;
      },
      diagnostics: { event: (value) => { events.push(value); } },
    });
    h.send(h.event(1));
    await until(() => h.acknowledged.length === 1);
    const stopStartedAtMs = performance.now() - h.run.startedMonotonicMs;
    try {
      await expect(h.recorder.stop(performance.now() + 20)).rejects.toMatchObject({ code: 'CAPTURE_DRAIN_TIMEOUT' });
      const track = MotionTrackSchema.parse(h.recorder.result());
      expect(track.status).toBe('failed');
      expect(h.faults).toEqual([mode === 'reject' ? 'CAPTURE_STOP_FAILED' : 'CAPTURE_DRAIN_TIMEOUT']);
      expect(track.stats).toMatchObject({ receivedFrames: 1, persistedFrames: 1, acknowledgedFrames: 1, rejectedFrames: 0 });
      const sourceEnd = h.recorder.captureEndMs();
      expect(sourceEnd).toBeGreaterThanOrEqual(stopStartedAtMs);
      expect(sourceEnd).toBeLessThanOrEqual(performance.now() - h.run.startedMonotonicMs);
      const failures = events.map((value) => JSON.parse(value)).filter((value) => value.kind === 'capture-shutdown-failure');
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({ code: h.faults[0], sourceStoppedAtMs: null });
      stopping.release();
      await new Promise((resolve) => setTimeout(resolve, 1));
      expect(h.recorder.captureEndMs()).toBe(sourceEnd);
      expect(h.recorder.result()).toEqual(track);
      expect(events.map((value) => JSON.parse(value)).filter((value) => value.kind === 'capture-shutdown-failure')).toEqual(failures);
      expect(h.budget).toMatchObject({ rawBytes: 0, sanitizedBytes: 0 });
    } finally {
      stopping.release();
    }
  });

  it('guards shutdown diagnostics without changing actual ACK accounting', async () => {
    let failures = 0;
    const events: string[] = [];
    const h = await streamHarness(undefined, {
      acknowledge: async () => { throw new Error('Private transport error text'); },
      diagnostics: { event: (value) => {
        events.push(value);
        if (JSON.parse(value).kind === 'capture-shutdown-failure') { failures++; throw new Error('Synthetic diagnostic failure'); }
      } },
    });
    h.send(h.event(1));
    await h.recorder.stop();
    expect(MotionTrackSchema.parse(h.recorder.result()).status).toBe('failed');
    expect(h.faults).toEqual(['CAPTURE_ACK_FAILED']);
    expect(h.recorder.result().stats.acknowledgedFrames).toBe(0);
    expect(failures).toBe(1);
    expect(events.map((value) => JSON.parse(value))).toContainEqual(expect.objectContaining({
      kind: 'capture-shutdown-failure', sourceStoppedAtMs: expect.any(Number),
    }));
    expect(events.join('')).not.toContain('Private transport error text');
  });

  it('counts an actual ACK completion during cancellation cleanup', async () => {
    const ack = gate();
    let entered = false;
    const h = await streamHarness(undefined, { acknowledge: async () => { entered = true; await ack.promise; } });
    h.send(h.event(1));
    await until(() => entered);
    h.controller.abort();
    const stopped = h.recorder.stop();
    ack.release();
    await stopped;
    expect(h.faults).toEqual(['CAPTURE_CANCELLED']);
    expect(h.recorder.result().stats.acknowledgedFrames).toBe(1);
  });

  it.each(['reject', 'timeout'])('fails %s closure and preserves an immutable result', async (mode) => {
    const closing = gate();
    let entered = false;
    const h = await streamHarness(undefined, {
      close: async () => {
        entered = true;
        if (mode === 'reject') throw new Error('Synthetic detach rejection');
        await closing.promise;
      },
    });
    h.send(h.event(1));
    await until(() => h.acknowledged.length === 1);
    const stopped = h.recorder.stop(performance.now() + 20);
    await expect(stopped).rejects.toMatchObject({ code: 'CAPTURE_DRAIN_TIMEOUT' });
    expect(entered).toBe(true);
    const published = h.recorder.result();
    const saved = structuredClone(published);
    expect(published.status).toBe('failed');
    expect(() => h.send(h.event(2))).toThrow('Frame subscription is stopped');
    closing.release();
    await new Promise((resolve) => setTimeout(resolve, 1));
    expect(published).toEqual(saved);
    expect(h.recorder.result()).toEqual(saved);
    expect(h.faults).toEqual([mode === 'reject' ? 'CAPTURE_CLOSE_FAILED' : 'CAPTURE_DRAIN_TIMEOUT']);
  });

  it('keeps a failed published snapshot unchanged when a safe write settles late', async () => {
    const writing = gate();
    let entered = false;
    const h = await streamHarness(async () => { entered = true; await writing.promise; });
    h.send(h.event(1));
    await until(() => entered && h.acknowledged.length === 1);
    await expect(h.recorder.stop(performance.now() + 10)).rejects.toMatchObject({ code: 'CAPTURE_DRAIN_TIMEOUT' });
    const published = h.recorder.result();
    const saved = structuredClone(published);
    expect(h.budget.sanitizedBytes).toBeGreaterThan(0);
    writing.release();
    await until(() => h.budget.sanitizedBytes === 0);
    expect(published).toEqual(saved);
    expect(h.recorder.result()).toEqual(saved);
    expect(saved.stats.persistedFrames).toBe(0);
  });

  it('closes a static stream once without waiting for a later frame', async () => {
    let closes = 0;
    const h = await streamHarness(undefined, { close: async () => { closes++; } });
    h.send(h.event(1));
    const stopped = h.recorder.stop();
    expect(h.recorder.stop()).toBe(stopped);
    await stopped;
    await h.recorder.stop();
    expect(closes).toBe(1);
    const published = h.recorder.result();
    expect(MotionTrackSchema.parse(published).status).toBe('ok');
    published.stats.receivedFrames = 10;
    expect(h.recorder.result().stats.receivedFrames).toBe(1);
  });

  it('does not issue a late start compensation after transport closure', async () => {
    const starting = gate();
    let entered = false, stops = 0, closes = 0;
    let dispose: ((deadline: number) => Promise<void>) | undefined;
    const factory = streamHarness(undefined, {
      start: async () => { entered = true; await starting.promise; },
      stop: async () => { stops++; },
      close: async () => { closes++; },
      register: (resource) => { dispose = resource.dispose; },
    });
    await until(() => entered && dispose !== undefined);
    if (!dispose) throw new Error('Missing disposer');
    await expect(dispose(performance.now() + 10)).rejects.toMatchObject({ code: 'CAPTURE_DRAIN_TIMEOUT' });
    const h = await factory;
    const stoppedCalls = stops;
    const published = h.recorder.result();
    expect(closes).toBe(1);
    starting.release();
    await new Promise((resolve) => setTimeout(resolve, 1));
    expect(stops).toBe(stoppedCalls);
    expect(h.recorder.result()).toEqual(published);
  });
});
