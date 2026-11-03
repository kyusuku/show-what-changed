import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { Browser } from 'playwright';
import { capture } from '../../src/recorder/index.js';
import { MotionRecorder } from '../../src/recorder/motion.js';
import { CaptureFault, neutralFrame } from '../../src/recorder/images.js';
import { CaptureBundleSchema, CaptureSettingsSchema, ScenarioSchema, motionPlaybackWindow } from '../../src/schema/index.js';
import type { RunContext, ServerPair } from '../../src/schema/contracts.js';
import { openBrowser } from '../../src/runtime/browser.js';
import { performAction } from '../../src/recorder/actions.js';

const clock = vi.hoisted(() => ({ now: 1000, expireAfterCheckpoint: false }));
vi.mock('../../src/runtime/browser.js', () => ({ openBrowser: vi.fn() }));
vi.mock('../../src/recorder/actions.js', () => ({ performAction: vi.fn(), settle: async () => {} }));
vi.mock('../../src/runtime/files.js', async (original) => {
  const actual = await original<typeof import('../../src/runtime/files.js')>();
  return {
    ...actual,
    writeRunFile: async (...args: Parameters<typeof actual.writeRunFile>) => {
      await actual.writeRunFile(...args);
      if (args[1].startsWith('frames/')) clock.now += 5;
      if (clock.expireAfterCheckpoint && args[1].startsWith('frames/002-')) clock.now = Math.max(clock.now, 100000);
    },
  };
});
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it.each([[false, false, false], [true, false, false], [false, true, false], [false, false, true]])('persists default-deadline partial capture with pre-dispatch expiry %s, pre-start dispatch %s, and expected absence %s', async (expiredBeforeDispatch, mappedBeforeStart, expectedAbsence) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'swc-deadline-')));
  roots.push(root);
  clock.now = 1000;
  clock.expireAfterCheckpoint = expiredBeforeDispatch;
  vi.mocked(performAction).mockClear();
  vi.spyOn(performance, 'now').mockImplementation(() => clock.now += 0.01);
  const settings = CaptureSettingsSchema.parse({ mode: 'motion', viewport: { width: 320, height: 240 }, observeMs: 0 });
  const bytes = neutralFrame(settings.viewport);
  const events: string[] = [];
  const run = {
    runId: '20261104T000000000Z-0000000000000000', startedMonotonicMs: 0, deadlineMs: 180000,
    paths: { runDir: root }, signal: new AbortController().signal,
    diagnostics: { event: (event: string) => events.push(event) }, resources: { register() {} },
    redactions: { text: (value: string) => value },
  } as unknown as RunContext;
  const servers = Object.fromEntries(['before', 'after'].map((side) => [side, {
    side, origin: `http://${side}.invalid`, sourceLabel: side, exited: new Promise(() => {}), storageState: null,
    source: { requested: side, commit: 'a'.repeat(40), kind: 'commit', materializedHash: 'b'.repeat(64) },
  }])) as unknown as ServerPair;
  const browser = {
    newContext: async () => ({
      newPage: async () => ({ on() {}, screenshot: async () => Buffer.from(bytes), waitForTimeout: async () => {} }),
      route: async () => {}, on() {}, close: async () => { clock.now += 20; },
    }), isConnected: () => true, version: () => 'controlled-safe-transport', close: async () => {},
  } as unknown as Browser;
  vi.mocked(openBrowser).mockResolvedValue(browser);
  const tracks: MotionRecorder[] = [];
  vi.spyOn(MotionRecorder, 'start').mockImplementation(async (_page, input, context, side, id, budget, onFault) => {
    let receive: ((event: unknown) => void) | undefined;
    let samples = 0;
    let previousSourceSeconds = 0;
    const recorder = await MotionRecorder.fromTransport({
      metrics: async () => {
        clock.now += 0.25;
        samples++;
        const sourceSeconds = mappedBeforeStart && samples === 6
          ? previousSourceSeconds + 0.000001
          : (clock.now + (expectedAbsence && samples >= 13 ? 20 : 0)) / 1000;
        previousSourceSeconds = sourceSeconds;
        return { metrics: [{ name: 'Timestamp', value: sourceSeconds }] };
      },
      onFrame: (listener) => { receive = listener; },
      start: async () => {}, stop: async () => {}, acknowledge: async () => {},
      stopFrames: () => {}, close: async () => {},
    }, input, context, side, id, budget, onFault);
    receive!({ sessionId: 1, data: bytes.toString('base64'), metadata: {
      monotonicTimestamp: clock.now / 1000, pageScaleFactor: 1, offsetTop: 0,
      deviceWidth: 320, deviceHeight: 240, scrollOffsetX: 0, scrollOffsetY: 0,
    } });
    tracks.push(recorder);
    return recorder;
  });
  const actionPairs = new Map<string, { count: number; ready: Promise<void>; release: () => void }>();
  vi.mocked(performAction).mockImplementation(async ({ step, origin, deadline }) => {
    let pair = actionPairs.get(step.id);
    if (!pair) {
      let release!: () => void;
      pair = { count: 0, ready: new Promise<void>((resolve) => { release = resolve; }), release: () => release() };
      actionPairs.set(step.id, pair);
    }
    if (++pair.count === 2) pair.release();
    await pair.ready;
    if (step.id === 'open') clock.now = Math.max(clock.now, 1010);
    if (step.id === 'stage-one') clock.now = Math.max(clock.now, 26000);
    if (step.id === 'stage-two') {
      clock.now = Math.max(clock.now, 51000);
      if (expectedAbsence) return { kind: 'missing' };
    }
    if (step.id === 'disabled') {
      clock.now = Math.max(clock.now, deadline + 7);
      throw new CaptureFault('SCENARIO_TIMEOUT');
    }
    return { kind: 'done', successfulDocument: origin + '/' };
  });
  const scenario = ScenarioSchema.parse({ schemaVersion: 2, id: 'deadline', title: 'Default deadline', steps: [
    { id: 'open', op: 'goto', path: '/' },
    { id: 'stage-one', op: 'click', target: { role: 'button', name: 'First stage' }, timeoutMs: 30000 },
    { id: 'stage-two', op: 'click', target: { role: 'button', name: 'Second stage' }, timeoutMs: 30000, allowMissing: expectedAbsence ? ['before', 'after'] : [] },
    { id: 'disabled', op: 'click', target: { role: 'button', name: 'Disabled' }, timeoutMs: 30000 },
    { id: 'blocked', op: 'screenshot' },
  ] });
  const bundle = await capture(servers, [scenario], settings, run);
  const saved = CaptureBundleSchema.parse(JSON.parse(await readFile(join(root, 'capture.json'), 'utf8')));
  expect(saved).toEqual(bundle);
  expect(bundle.captureMode).toBe('motion');
  if (bundle.captureMode !== 'motion') throw new Error('Expected motion capture');
  expect(bundle.scenarios[0]!.outcome).toBe('partial');
  expect(bundle.scenarios[0]!.steps.map((step) => step.before.status)).toEqual(['ok', 'ok', expectedAbsence ? 'expected_absent' : 'ok', 'failed', 'blocked']);
  const motion = bundle.motion[0]!;
  expect(motion.timing.limitMs).toBe(60000);
  if (expectedAbsence) {
    const timing = motion.steps[2]!.before;
    if (timing.kind !== 'executed') throw new Error('Expected measured absence');
    expect(timing.observationEnd).toEqual(timing.completion);
    expect(timing.completion.runElapsedMs).toBeGreaterThan(motion.steps[3]!.barrierMs);
    expect(motion.annotations.filter((annotation) => annotation.kind === 'expected_absent')).toEqual([]);
  }
  if (mappedBeforeStart) {
    const timing = motion.steps[0]!.before;
    if (timing.kind !== 'executed') throw new Error('Expected successful first step');
    expect(timing.dispatch.runElapsedMs).toBeLessThan(motion.timing.startMs);
    expect(timing.dispatch.hostBeforeMs).toBeGreaterThanOrEqual(motion.steps[0]!.barrierMs);
    expect(motion.steps[0]!.barrierMs).toBeGreaterThanOrEqual(motion.timing.startMs);
  }
  const window = motionPlaybackWindow(motion.timing);
  expect(window.endMs).toBe(motion.timing.startMs + 60000);
  expect(window.durationFrames).toBe(1800);
  for (const side of ['before', 'after'] as const) {
    const failed = motion.steps[3]![side];
    const blocked = motion.steps[4]![side];
    expect(failed.kind).toBe('failed');
    expect(blocked.kind).toBe('blocked');
    if (failed.kind !== 'failed' || blocked.kind !== 'blocked') throw new Error('Expected terminal timing');
    expect(failed.failure.runElapsedMs).toBeGreaterThan(window.endMs);
    expect(blocked.atMs).toBeGreaterThan(failed.failure.runElapsedMs);
    expect(motion.timing.observedEndMs).toBeGreaterThan(blocked.atMs);
    expect(bundle.scenarios[0]!.steps[3]![side].reasonCode).toBe('SCENARIO_TIMEOUT');
    expect(bundle.scenarios[0]!.steps[3]![side].heldFromStepId).toBe(expectedAbsence ? 'stage-one' : 'stage-two');
    if (expiredBeforeDispatch) expect(failed.dispatch).toBeNull();
  }
  expect(vi.mocked(performAction).mock.calls.filter(([input]) => input.step.id === 'disabled')).toHaveLength(expiredBeforeDispatch ? 0 : 2);
  expect(tracks.every((track) => track.result().status === 'ok')).toBe(true);
  expect(tracks.every((track) => track.result().stats.persistedFrames === 1)).toBe(true);
  expect(events).not.toEqual([]);
});
