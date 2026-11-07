import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunContext } from '../../src/schema/contracts.js';
import { CaptureSettingsSchema, ClockMappingSchema, MotionScenarioSchema, MotionTrackSchema } from '../../src/schema/index.js';
import { CLOCK_MAGNITUDE_MS, endpointFrameCovered, inspectEndpointClock, sampleOffset, startupAnchor } from '../../src/schema/clock.js';
import type { ClockSample, EndpointClock } from '../../src/schema/clock.js';
import { MotionRecorder } from '../../src/recorder/motion.js';
import type { MotionTransport } from '../../src/recorder/motion.js';
import { LOCAL_MONOTONE_CLOCK } from '../../src/runtime/browser.js';

const sample = (sourceMs: number, offsetMs = 1000, before = 1, after = 1): ClockSample => ({
  sourceSeconds: sourceMs / 1000, hostBeforeMs: sourceMs + offsetMs - before, hostAfterMs: sourceMs + offsetMs + after,
});
function clock(samples = Array.from({ length: 5 }, (_, i) => sample(1000 + i * 10))): EndpointClock {
  const anchorIndex = startupAnchor(samples);
  return { rate: 1, offsetMs: sampleOffset(samples[anchorIndex]!), errorBoundMs: 0, samples,
    proof: { kind: 'monotone-endpoints', anchorIndex, finalIndex: null, numericAllowanceMs: 0.01 } };
}
function finish(clock: EndpointClock): EndpointClock {
  clock.errorBoundMs = inspectEndpointClock(clock).acceptedBoundMs;
  clock.proof.finalIndex = clock.samples.length - 1;
  return clock;
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('fixed monotone endpoint evidence', () => {
  it('recovers the observed broad response with its raw evidence and original mapping retained', () => {
    const initial = { sourceSeconds: 1220.383575, hostBeforeMs: 3753.179077, hostAfterMs: 3754.461932 };
    const delayed = { sourceSeconds: 1220.393399, hostBeforeMs: 3762.4112369999993, hostAfterMs: 3807.856874 };
    const samples = Array.from({ length: 4 }, (_, i) => ({ sourceSeconds: initial.sourceSeconds - (4 - i) * 0.01,
      hostBeforeMs: initial.hostBeforeMs - (4 - i) * 10 - 0.1, hostAfterMs: initial.hostAfterMs - (4 - i) * 10 + 0.1 }));
    const value = clock([...samples, initial]);
    const offset = value.offsetMs;
    value.samples.push(delayed);
    expect(inspectEndpointClock(value).latestBoundMs).toBeGreaterThan(40);
    value.samples.push(sample(1220440, offset, 0.5, 0.5));
    expect(ClockMappingSchema.safeParse(finish(value)).success).toBe(true);
    expect(value.errorBoundMs).toBeLessThan(1);
    expect(value.offsetMs).toBe(offset);
    expect(value.samples).toHaveLength(7);
    expect(value.samples[5]).toEqual(delayed);
  });
  it.each([45, -45])('rejects a narrow %sms shift immediately', (shift) => {
    const value = clock();
    value.samples.push(sample(1100, 1000 + shift));
    expect(() => inspectEndpointClock(value)).toThrow();
  });
  it('uses one global numeric budget across the whole sample history', () => {
    const value = clock(Array.from({ length: 5 }, (_, i) => sample(1000 + i * 10, 1000, 0, 0)));
    for (let i = 1; i <= 10; i++) value.samples.push(sample(1100 + i * 10, 1000 - i * 0.005, 0, 0));
    expect(() => inspectEndpointClock(value)).toThrow('monotone');
  });
  it.each(['source reset', 'host overlap', 'numeric overflow'])('rejects %s in retained observations', (kind) => {
    const value = clock();
    value.samples.push(kind === 'source reset' ? sample(1000) : kind === 'host overlap'
      ? { sourceSeconds: 1.05, hostBeforeMs: 2040, hostAfterMs: 2060 }
      : { sourceSeconds: CLOCK_MAGNITUDE_MS, hostBeforeMs: 1, hostAfterMs: 2 });
    expect(() => inspectEndpointClock(value)).toThrow();
  });
  it('retains the largest accepted bound without retaining an ambiguous provisional bound', () => {
    const value = clock();
    value.samples.push(sample(1100, 1000, 1, 20), sample(1200, 1000, 1, 50), sample(1300));
    const proof = inspectEndpointClock(value);
    expect(proof.latestBoundMs).toBeCloseTo(1.02);
    expect(proof.acceptedBoundMs).toBeCloseTo(20.02);
    expect(ClockMappingSchema.safeParse(finish(value)).success).toBe(true);
    expect(ClockMappingSchema.safeParse({ ...value, errorBoundMs: 1.02 }).success).toBe(false);
  });
  it('requires final endpoints, strict frame coverage, exact anchors and unchanged numeric allowances', () => {
    const value = finish(clock([...clock().samples, sample(1100)]));
    expect(endpointFrameCovered(value, 1.07)).toBe(true);
    for (const source of [1, 1.04, 1.1, 1.11]) expect(endpointFrameCovered(value, source)).toBe(false);
    for (const proof of [
      { ...value.proof, finalIndex: null }, { ...value.proof, finalIndex: 4 },
      { ...value.proof, anchorIndex: 0 }, { ...value.proof, numericAllowanceMs: 0 },
    ]) expect(ClockMappingSchema.safeParse({ ...value, proof }).success).toBe(false);
  });
});

type Measurement = { responseDelay?: number; offsetShift?: number; sourceMs?: number; wait?: Promise<void> };
async function harness(options: { measurements?: Measurement[]; sanitizeWait?: Promise<void>; trusted?: boolean } = {}) {
  let time = 10000;
  vi.spyOn(performance, 'now').mockImplementation(() => time);
  const controller = new AbortController();
  const run = { startedMonotonicMs: 0, signal: controller.signal, resources: { register() {} }, diagnostics: { event() {} } } as unknown as RunContext;
  const settings = CaptureSettingsSchema.parse({ mode: 'motion', viewport: { width: 320, height: 240 } });
  if (settings.mode !== 'motion') throw new Error('Expected motion');
  const measurements = options.measurements ?? [];
  let calls = 0;
  let listener: ((event: unknown) => void) | undefined;
  let late: ((id: number | null) => void) | undefined;
  let sealed = false;
  const faults: string[] = [];
  const acknowledged: number[] = [];
  const transport: MotionTransport = {
    metrics: async () => {
      const measurement = measurements[calls++ - 5] ?? {};
      const sourceMs = measurement.sourceMs ?? time + 1 - 1000 - (measurement.offsetShift ?? 0);
      time += 2 + (measurement.responseDelay ?? 0);
      await measurement.wait;
      return { metrics: [{ name: 'Timestamp', value: sourceMs / 1000 }] };
    },
    onFrame: (receive, onLate) => { listener = receive; late = onLate; },
    start: async () => {}, stop: async () => {},
    stopFrames: () => { sealed = true; },
    acknowledge: async (id) => { acknowledged.push(id); },
    close: async () => {},
  };
  const recorder = await MotionRecorder.fromTransport(transport, settings, run, 'before', 'clock',
    { count: 0, bytes: 0, rawBytes: 0, sanitizedBytes: 0 }, (code) => faults.push(code), async () => {},
    () => ({ ready: Promise.resolve(), onFailure: () => () => {}, close: async () => {},
      sanitize: async (bytes) => { await options.sanitizeWait; return bytes; } }),
    options.trusted === false ? undefined : LOCAL_MONOTONE_CLOCK);
  function frame(sourceMs = time + 1 - 1000) {
    time += 3;
    if (sealed) return late?.(1);
    listener?.({ sessionId: 1, data: Buffer.from('sanitized-frame').toString('base64'), metadata: {
      monotonicTimestamp: sourceMs / 1000, pageScaleFactor: 1, offsetTop: 0, deviceWidth: 320, deviceHeight: 240, scrollOffsetX: 0, scrollOffsetY: 0,
    } });
  }
  return { recorder, controller, frame, faults, acknowledged, now: () => time, calls: () => calls, advance: (ms: number) => { time += ms; } };
}
function gate() {
  let release!: () => void;
  return { promise: new Promise<void>((resolve) => { release = resolve; }), release: () => release() };
}
async function tickUntil(predicate: () => boolean) {
  for (let i = 0; i < 100 && !predicate(); i++) await Promise.resolve();
  expect(predicate()).toBe(true);
}

describe('owned endpoint recording', () => {
  it('refreshes a delayed dispatch once, invokes once, keeps every sample and closes with covered frames', async () => {
    const h = await harness({ measurements: [{ responseDelay: 50 }] });
    expect(h.recorder.result().status).toBe('failed');
    let invoked = 0;
    const attempt = await h.recorder.dispatch(async () => { invoked++; return 'done'; });
    expect(await attempt.completion).toBe('done');
    expect(invoked).toBe(1);
    expect(h.calls()).toBe(7);
    expect(attempt.marker).toMatchObject({ sampleIndex: 6, eventHostMs: h.now() });
    h.frame();
    await h.recorder.stop();
    const track = MotionTrackSchema.parse(h.recorder.result());
    expect(track.status).toBe('ok');
    expect(track.clock?.samples).toHaveLength(8);
    expect(track.clock?.samples[5]!.hostAfterMs! - track.clock?.samples[5]!.hostBeforeMs!).toBe(52);
    expect(track.clock?.errorBoundMs).toBeCloseTo(1.02);
    expect(track.clock?.offsetMs).toBe(1000);
    expect(h.acknowledged).toEqual([1]);
  });
  it('keeps an original completion observation and source sample through delayed-response proof recovery', async () => {
    const h = await harness({ measurements: [{ responseDelay: 50 }] });
    const eventHostMs = h.now();
    const marker = await h.recorder.marker(eventHostMs);
    expect(marker).toMatchObject({ eventHostMs, eventEndHostMs: eventHostMs, sampleIndex: 5 });
    expect(marker.runElapsedMs).toBe(eventHostMs + 1);
    expect(h.calls()).toBe(7);
    h.frame();
    await h.recorder.stop();
    expect(h.recorder.result().status).toBe('ok');
  });
  it('fails a completion whose source was sampled too late instead of substituting a recovery sample', async () => {
    const h = await harness();
    const eventHostMs = h.now();
    h.advance(45);
    await expect(h.recorder.marker(eventHostMs)).rejects.toThrow('CAPTURE_MARKER_STALE');
    expect(h.calls()).toBe(6);
    await h.recorder.stop();
  });
  it('fails after two broad responses without invoking the action or making a third request', async () => {
    const h = await harness({ measurements: [{ responseDelay: 50 }, { responseDelay: 50 }] });
    const invoke = vi.fn(async () => {});
    await expect(h.recorder.dispatch(invoke)).rejects.toThrow('CAPTURE_CLOCK_UNCERTAIN');
    expect(invoke).not.toHaveBeenCalled();
    expect(h.calls()).toBe(7);
    await h.recorder.stop();
    expect(h.recorder.result().clock?.samples).toHaveLength(7);
  });
  it.each([45, -45])('fails a narrow %sms shift without retrying or invoking', async (offsetShift) => {
    const h = await harness({ measurements: [{ offsetShift }] });
    h.advance(100);
    const invoke = vi.fn(async () => {});
    await expect(h.recorder.dispatch(invoke)).rejects.toThrow('CAPTURE_CLOCK_DRIFT');
    expect(invoke).not.toHaveBeenCalled();
    expect(h.calls()).toBe(6);
    await h.recorder.stop();
  });
  it.each(['abort', 'stop'] as const)('cannot invoke an action when %s interrupts recovery', async (interrupt) => {
    const blocked = gate();
    const h = await harness({ measurements: [{ responseDelay: 50 }, { wait: blocked.promise }] });
    const invoke = vi.fn(async () => {});
    const attempt = h.recorder.dispatch(invoke);
    const rejected = expect(attempt).rejects.toThrow();
    await tickUntil(() => h.calls() === 7);
    if (interrupt === 'abort') h.controller.abort();
    const stopping = h.recorder.stop();
    await rejected;
    blocked.release();
    await stopping;
    expect(invoke).not.toHaveBeenCalled();
  });
  it.each([false, true])('refreshes stale proven dispatch at most once when both attempts stale is %s', async (twice) => {
    const h = await harness();
    const invoke = vi.fn(async () => {});
    let checks = 0;
    const attempt = h.recorder.dispatch(invoke, () => { if (++checks === 1 || twice) h.advance(45); });
    if (twice) {
      await expect(attempt).rejects.toThrow('CAPTURE_MARKER_STALE');
      expect(invoke).not.toHaveBeenCalled();
    } else {
      expect((await attempt).marker).toMatchObject({ sampleIndex: 6, eventHostMs: h.now() });
      expect(invoke).toHaveBeenCalledTimes(1);
      h.frame();
    }
    expect(h.calls()).toBe(7);
    await h.recorder.stop();
  });
  it('rechecks cancellation synchronously after the caller deadline check', async () => {
    const h = await harness();
    const invoke = vi.fn(async () => {});
    await expect(h.recorder.dispatch(invoke, () => h.controller.abort())).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
    await h.recorder.stop();
  });
  it('checks the actual invocation bracket without a later await or stale callback', async () => {
    const h = await harness();
    const invoke = vi.fn(async () => { h.advance(41); });
    await expect(h.recorder.dispatch(invoke)).rejects.toThrow('CAPTURE_MARKER_STALE');
    expect(invoke).toHaveBeenCalledTimes(1);
    await h.recorder.stop();
  });
  it('checks a delayed frame after queued sanitization against the final source endpoint', async () => {
    const processing = gate();
    const h = await harness({ sanitizeWait: processing.promise });
    h.frame(h.now() + 100 - 1000);
    const stopped = h.recorder.stop();
    await tickUntil(() => h.calls() === 6);
    processing.release();
    await stopped;
    const track = MotionTrackSchema.parse(h.recorder.result());
    expect(track.status).toBe('failed');
    expect(track.frames).toHaveLength(1);
    expect(h.faults).toEqual(['CAPTURE_CLOCK_COVERAGE']);
    expect(h.acknowledged).toEqual([1]);
  });
  it('covers an admitted future display timestamp with one bounded follow-up before queued sanitization finishes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const processing = gate();
    const h = await harness({ sanitizeWait: processing.promise });
    const sourceMs = h.now() + 12 - 1000;
    h.frame(sourceMs);
    const stopped = h.recorder.stop();
    await tickUntil(() => h.calls() === 6);
    expect(h.recorder.result().frames).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(0);
    h.advance(8);
    await vi.advanceTimersByTimeAsync(8);
    expect(h.calls()).toBe(6);
    h.advance(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.calls()).toBe(7);
    processing.release();
    await stopped;
    const track = MotionTrackSchema.parse(h.recorder.result());
    expect(track.status).toBe('ok');
    expect(track.frames).toHaveLength(1);
    expect(track.frames[0]).toMatchObject({ sourceMonotonicSeconds: sourceMs / 1000, runElapsedMs: sourceMs + 1000 });
    expect(track.clock).toMatchObject({ offsetMs: 1000, proof: { finalIndex: 6 } });
    expect(track.clock?.samples).toHaveLength(7);
    expect(track.clock?.errorBoundMs).toBeCloseTo(1.02);
    expect(h.acknowledged).toEqual([1]);
    expect(h.faults).toEqual([]);
  });
  it.each(['uncovered', 'uncertain', 'drift'] as const)('fails a %s follow-up without a third endpoint request', async (failure) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const h = await harness({ measurements: [{}, failure === 'uncertain' ? { responseDelay: 50 }
      : failure === 'drift' ? { offsetShift: 45 } : { sourceMs: 9016 }] });
    h.frame(h.now() + 12 - 1000);
    const stopped = h.recorder.stop();
    await tickUntil(() => h.calls() === 6);
    await vi.advanceTimersByTimeAsync(0);
    h.advance(failure === 'drift' ? 100 : 9);
    await vi.advanceTimersByTimeAsync(9);
    await stopped;
    expect(h.calls()).toBe(7);
    expect(h.recorder.result().status).toBe('failed');
    expect(h.recorder.result().frames).toHaveLength(1);
    expect(h.acknowledged).toEqual([1]);
    expect(h.faults).toEqual([failure === 'uncovered' ? 'CAPTURE_CLOCK_COVERAGE'
      : failure === 'uncertain' ? 'CAPTURE_CLOCK_UNCERTAIN' : 'CAPTURE_CLOCK_DRIFT']);
  });
  it.each(['abort', 'deadline'] as const)('ends the coverage wait on %s without a fresh request or later result mutation', async (interrupt) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const h = await harness();
    h.frame(h.now() + 12 - 1000);
    const stopped = h.recorder.stop(h.now() + (interrupt === 'deadline' ? 5 : 100));
    const completion = stopped.then(() => null, (cause: unknown) => cause);
    await tickUntil(() => h.calls() === 6);
    await vi.advanceTimersByTimeAsync(0);
    if (interrupt === 'abort') h.controller.abort();
    else {
      h.advance(5);
      await vi.advanceTimersByTimeAsync(5);
    }
    const outcome = await completion;
    if (interrupt === 'deadline') expect(outcome).toMatchObject({ code: 'CAPTURE_DRAIN_TIMEOUT' });
    else expect(outcome).toBeNull();
    const track = h.recorder.result();
    expect(track.status).toBe('failed');
    expect(h.faults).toEqual([interrupt === 'abort' ? 'CAPTURE_CANCELLED' : 'CAPTURE_DRAIN_TIMEOUT']);
    h.advance(40);
    await vi.advanceTimersByTimeAsync(40);
    expect(h.calls()).toBe(6);
    expect(h.recorder.result()).toEqual(track);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('rejects a frame tied with its lower anchor and retains its actual ACK', async () => {
    const h = await harness();
    h.frame(9009);
    await h.recorder.stop();
    expect(h.faults).toEqual(['CAPTURE_CLOCK_COVERAGE']);
    expect(h.acknowledged).toEqual([1]);
  });
  it('keeps generic transports on the legacy strict measurement rule', async () => {
    const h = await harness({ trusted: false, measurements: [{ responseDelay: 50 }] });
    await expect(h.recorder.marker()).rejects.toThrow('CAPTURE_CLOCK_DRIFT');
    await h.recorder.stop();
    expect(h.recorder.result().clock).not.toHaveProperty('proof');
  });
  it('rejects tampered source marker identities and understated final mapping bounds', async () => {
    const h = await harness({ measurements: [{}, { responseDelay: 20 }] });
    const attempt = await h.recorder.dispatch(async () => {});
    await attempt.completion;
    const completion = await h.recorder.marker(h.now());
    h.frame();
    await h.recorder.stop();
    const track = h.recorder.result();
    const scenario = { id: 'clock', timing: { startMs: 10000, observedEndMs: h.now(), limitMs: 1000 },
      tracks: { before: track, after: track }, annotations: [], steps: [{ id: 'step', barrierMs: 10010,
        before: { kind: 'executed', dispatch: attempt.marker, completion, observationEnd: completion },
        after: { kind: 'excluded', atMs: 10010 } }] };
    expect(MotionScenarioSchema.safeParse(scenario).success).toBe(true);
    expect(attempt.marker).toHaveProperty('errorBoundMs', track.clock?.errorBoundMs);
    if (!track.clock || !('proof' in track.clock)) throw new Error('Expected endpoint evidence');
    for (const source of [track.clock.samples[track.clock.proof.anchorIndex]!.sourceSeconds,
      track.clock.samples[track.clock.proof.finalIndex!]!.sourceSeconds]) {
      const changed = structuredClone(track);
      changed.frames[0]!.sourceMonotonicSeconds = source;
      changed.frames[0]!.runElapsedMs = source * 1000 + track.clock.offsetMs;
      expect(MotionTrackSchema.safeParse(changed).success).toBe(false);
    }
    for (const patch of [{ sampleIndex: 0 }, { sampleIndex: 6 }, { hostBeforeMs: 1 }, { eventHostMs: 1 }, { errorBoundMs: 1.02 },
      { eventHostMs: attempt.marker.hostBeforeMs, eventEndHostMs: attempt.marker.hostBeforeMs }]) {
      const changed = structuredClone(scenario);
      Object.assign(changed.steps[0]!.before.dispatch, patch);
      expect(MotionScenarioSchema.safeParse(changed).success).toBe(false);
    }
    if (!('eventHostMs' in attempt.marker)) throw new Error('Expected an observed invocation');
    const reversed = structuredClone(scenario);
    Object.assign(reversed.steps[0]!.before.completion, {
      eventHostMs: attempt.marker.eventHostMs - 1, eventEndHostMs: attempt.marker.eventHostMs - 1,
    });
    expect(MotionScenarioSchema.safeParse(reversed).success).toBe(false);
    const afterSample = structuredClone(scenario);
    Object.assign(afterSample.steps[0]!.before.completion, {
      eventHostMs: completion.hostAfterMs + 1, eventEndHostMs: completion.hostAfterMs + 1,
    });
    expect(MotionScenarioSchema.safeParse(afterSample).success).toBe(false);
    const dispatch = { ...attempt.marker, eventEndHostMs: attempt.marker.eventHostMs + 3 };
    const failed = { ...scenario, steps: [{ ...scenario.steps[0], before: {
      kind: 'failed', dispatch,
      failure: { kind: 'host', runElapsedMs: dispatch.eventHostMs + 1, reason: 'source-clock-unavailable' },
    } }] };
    expect(MotionScenarioSchema.safeParse(failed).success).toBe(true);
    failed.steps[0]!.before.failure.runElapsedMs = dispatch.eventHostMs - 1;
    expect(MotionScenarioSchema.safeParse(failed).success).toBe(false);
  });
});
