import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { CaptureBundleSchema } from '../../src/schema/index.js';
import type { CaptureBundle, MotionScenario, Side, Timeline } from '../../src/schema/index.js';
import { digest } from '../../src/schema/io.js';
import {
  buildPresentation,
  presentationText,
  presentationWarnings,
  selectSource,
} from '../../src/composer/presentation.js';
import { validateTimelineCapture } from '../../src/composer/index.js';
const fixture = CaptureBundleSchema.parse(
  JSON.parse(await readFile(new URL('../fixtures/capture.json', import.meta.url), 'utf8')),
);
const settings = {
  coverage: { selected: [], unresolved: [], omitted: [], unsupported: [], complete: true },
  provenance: {
    before: { valid: true, actualHash: null, errors: [] },
    after: { valid: true, actualHash: null, errors: [] },
  },
};
function motionBundle(): Extract<CaptureBundle, { captureMode: 'motion' }> {
  const step = fixture.scenarios[0]?.steps[0];
  if (!step) throw new Error('Missing fixture');
  const frame = (sequence: number, at: number, side: 'before' | 'after') => ({
    artifact: { ...step[side].image, path: `frames/${side}-${sequence}.png` },
    sequence,
    sourceMonotonicSeconds: at / 1000,
    sourceEpochSeconds: null,
    runElapsedMs: at,
    receivedMs: at + 2,
    width: 1280,
    height: 800,
    deviceScaleFactor: 1 as const,
    pageScaleFactor: 1 as const,
    offsetTop: 0 as const,
    scrollOffsetX: 0,
    scrollOffsetY: 0,
    maskDigest: 'a'.repeat(64),
  });
  const marker = (at: number) => ({
    kind: 'source' as const,
    sourceSeconds: at / 1000,
    hostBeforeMs: at,
    hostAfterMs: at,
    runElapsedMs: at,
    uncertaintyMs: 0,
  });
  const track = (side: 'before' | 'after') => ({
    status: 'ok' as const,
    error: null,
    clock: {
      rate: 1 as const,
      offsetMs: 0,
      uncertaintyMs: 0,
      maxDriftMs: 0,
      errorBoundMs: 0,
      samples: [{ sourceSeconds: 0, hostBeforeMs: 0, hostAfterMs: 0 }],
    },
    frames: [frame(0, 120, side), frame(1, 160, side)],
    stats: {
      receivedFrames: 2,
      persistedFrames: 2,
      acknowledgedFrames: 2,
      rejectedFrames: 0,
      maxQueueDepth: 1,
      sourceDroppedFrames: null,
      maxGapMs: 40,
    },
    gaps: [{ fromSourceSeconds: 0.12, toSourceSeconds: 0.16, durationMs: 40 }],
  });
  const motion: MotionScenario = {
    id: 'n0-probe',
    startMs: 100,
    endMs: 200,
    tracks: { before: track('before'), after: track('after') },
    steps: [
      {
        id: step.id,
        barrierMs: 100,
        before: { kind: 'executed', dispatch: marker(100), completion: marker(110), observationEnd: marker(190) },
        after: { kind: 'executed', dispatch: marker(100), completion: marker(110), observationEnd: marker(190) },
      },
    ],
    annotations: [],
  };
  const bundle = CaptureBundleSchema.parse({
    ...fixture,
    captureMode: 'motion',
    settings: { fixedTime: null, maskRects: [] },
    motion: [motion],
  });
  if (bundle.captureMode !== 'motion') throw new Error('Expected motion');
  return bundle;
}
function sourceMarker(at: number) {
  return {
    kind: 'source' as const,
    sourceSeconds: at / 1000,
    hostBeforeMs: at,
    hostAfterMs: at,
    runElapsedMs: at,
    uncertaintyMs: 0,
  };
}
function partialMotionBundle(side: Side, trackFailure = false): Extract<CaptureBundle, { captureMode: 'motion' }> {
  const bundle = motionBundle();
  const scenario = bundle.scenarios[0]!;
  const motion = bundle.motion[0]!;
  const step = scenario.steps[0]!;
  scenario.outcome = 'partial';
  step[side].status = 'failed';
  step[side].reasonCode = 'ACTION_FAILED';
  step.changeRatio = null;
  const blocked = structuredClone(step);
  blocked.id = 'next-step';
  blocked.caption = 'Next step';
  blocked[side].status = 'blocked';
  blocked[side].reasonCode = 'PREVIOUS_STEP_FAILED';
  scenario.steps = [step, blocked];
  const firstTiming = motion.steps[0]!;
  firstTiming[side] = { kind: 'failed', dispatch: sourceMarker(100), failure: sourceMarker(150) };
  motion.endMs = 300;
  motion.steps.push({
    id: blocked.id,
    barrierMs: 165,
    before: { kind: 'executed', dispatch: sourceMarker(165), completion: sourceMarker(190), observationEnd: sourceMarker(290) },
    after: { kind: 'executed', dispatch: sourceMarker(165), completion: sourceMarker(190), observationEnd: sourceMarker(290) },
    [side]: { kind: 'blocked', atMs: 168 },
  });
  motion.annotations = [
    { side, stepId: step.id, kind: 'failed', startMs: 150, endMs: 165 },
    { side, stepId: blocked.id, kind: 'blocked', startMs: 168, endMs: 300 },
  ];
  if (trackFailure)
    motion.tracks[side] = {
      ...motion.tracks[side],
      status: 'failed',
      failureAtMs: 150,
      error: { code: 'CAPTURE_STREAM_FAILED', phase: 'capture', message: 'Synthetic stream failure', hint: 'Inspect the synthetic track' },
    };
  CaptureBundleSchema.parse(bundle);
  return bundle;
}
function motionOverlays(model: ReturnType<typeof buildPresentation>) {
  return model.selections.map((selection) => {
    const overlay = model.cards.find((card) => card.image === selection.overlay);
    if (!overlay) throw new Error('Missing overlay');
    return overlay;
  });
}
function timeline(bundle: CaptureBundle): Timeline {
  const model = buildPresentation(bundle, settings);
  const images = new Map(
    bundle.scenarios.flatMap((s) => s.steps.flatMap((s) => [s.before.image, s.after.image])).map((a) => [a.path, a]),
  );
  if (bundle.captureMode === 'motion')
    for (const scenario of bundle.motion)
      for (const side of ['before', 'after'] as const)
        for (const frame of scenario.tracks[side].frames) images.set(frame.artifact.path, frame.artifact);
  for (const card of model.cards) images.set(card.image, { path: card.image, sha256: 'c'.repeat(64), bytes: 1 });
  return {
    schemaVersion: 2,
    templateVersion: 2,
    runId: bundle.runId,
    captureMode: bundle.captureMode,
    captureSha256: digest(bundle),
    fps: 30,
    width: 1920,
    height: 686,
    viewport: bundle.viewport,
    totalFrames: model.totalFrames,
    segments: model.segments,
    selections: model.selections,
    stepBoundaries: model.stepBoundaries,
    annotations: model.annotations,
    posterSelection: model.posterSelection,
    poster: model.poster,
    images: [...images.values()],
  };
}
describe('saved presentation schedule', () => {
  it('uses exactly one title and ceil observation with a six-frame minimum', () => {
    const bundle = structuredClone(fixture);
    const scenario = bundle.scenarios[0];
    const source = scenario?.steps[0];
    if (!scenario || !source) throw new Error('Missing fixture');
    scenario.steps = [0, 200, 201, 333, 801, 3000].map((observeMs, index) => ({
      ...source,
      id: `step-${index}`,
      observeMs,
    }));
    const model = buildPresentation(bundle, settings);
    expect(model.segments.map((s) => s.durationFrames)).toEqual([30, 6, 6, 7, 10, 25, 90]);
    expect(model.totalFrames).toBe(174);
  });
  it('retains native duration and chooses latest actual source at common ticks', () => {
    const bundle = motionBundle();
    const model = buildPresentation(bundle, settings);
    expect(model.totalFrames).toBe(33);
    expect(model.selections.map((s) => s.before)).toEqual([null, 'frames/before-0.png', 'frames/before-1.png']);
    expect(model.selections.map((s) => s.frame)).toEqual([30, 31, 32]);
    expect(() => validateTimelineCapture(timeline(bundle), bundle)).not.toThrow();
  });
  it('rejects self-consistent source substitution, changed clock identity, and retiming', () => {
    const bundle = motionBundle();
    const original = timeline(bundle);
    for (const mutate of [
      (t: Timeline) => {
        const selection = t.selections[1];
        if (selection) selection.before = 'frames/before-1.png';
      },
      (t: Timeline) => {
        t.captureSha256 = 'f'.repeat(64);
      },
      (t: Timeline) => {
        const boundary = t.stepBoundaries[0];
        if (boundary) boundary.startFrame++;
      },
    ]) {
      const changed = structuredClone(original);
      mutate(changed);
      expect(() => validateTimelineCapture(changed, bundle)).toThrow();
    }
  });
  it('starts failure labels at the actual marker and never selects later source frames', () => {
    const bundle = motionBundle();
    const scenario = bundle.scenarios[0];
    const motion = bundle.motion[0];
    const step = scenario?.steps[0];
    const timing = motion?.steps[0];
    if (!scenario || !motion || !step || !timing) throw new Error('Missing fixture');
    scenario.outcome = 'partial';
    step.before.status = 'failed';
    step.before.reasonCode = 'ACTION_FAILED';
    step.changeRatio = null;
    motion.endMs = 300;
    timing.before = {
      kind: 'failed',
      dispatch: {
        kind: 'source',
        sourceSeconds: 0.1,
        hostBeforeMs: 100,
        hostAfterMs: 100,
        runElapsedMs: 100,
        uncertaintyMs: 0,
      },
      failure: {
        kind: 'source',
        sourceSeconds: 0.15,
        hostBeforeMs: 150,
        hostAfterMs: 150,
        runElapsedMs: 150,
        uncertaintyMs: 0,
      },
    };
    motion.annotations = [{ side: 'before', stepId: step.id, kind: 'failed', startMs: 150, endMs: 300 }];
    expect(selectSource(bundle, 0, 'before', 140)).toBe('frames/before-0.png');
    expect(selectSource(bundle, 0, 'before', 290)).toBe('frames/before-0.png');
    expect(selectSource(bundle, 0, 'after', 290)).toBe('frames/after-1.png');
    const model = buildPresentation(bundle, settings);
    const failure = model.annotations[0];
    expect(failure).toMatchObject({ startFrame: 32, endFrame: 36 });
    const earlyOverlay = model.cards.find((card) => card.image === model.selections[1]?.overlay);
    const failedOverlay = model.cards.find((card) => card.image === model.selections[2]?.overlay);
    expect(earlyOverlay?.beforeBadge).toBe('');
    expect(failedOverlay?.beforeBadge).toContain('FAILED');
  });

  it('explains a prior failure throughout blocked frames even when the failed interval is shorter than one frame', () => {
    const bundle = motionBundle();
    const scenario = bundle.scenarios[0]!;
    const motion = bundle.motion[0]!;
    const step = scenario.steps[0]!;
    const marker = (at: number) => ({ kind: 'source' as const, sourceSeconds: at / 1000, hostBeforeMs: at, hostAfterMs: at, runElapsedMs: at, uncertaintyMs: 0 });
    scenario.outcome = 'partial';
    step.before.status = 'failed';
    step.before.reasonCode = 'ACTION_FAILED';
    step.changeRatio = null;
    const blocked = structuredClone(step);
    blocked.id = 'next-step';
    blocked.before.status = 'blocked';
    blocked.before.reasonCode = 'PRIOR_STEP_FAILED';
    scenario.steps = [step, blocked];
    motion.endMs = 300;
    motion.steps = [
      { id: step.id, barrierMs: 100, before: { kind: 'failed', dispatch: marker(100), failure: marker(150) }, after: { kind: 'executed', dispatch: marker(100), completion: marker(140), observationEnd: marker(155) } },
      { id: blocked.id, barrierMs: 159, before: { kind: 'blocked', atMs: 159 }, after: { kind: 'executed', dispatch: marker(159), completion: marker(190), observationEnd: marker(290) } },
    ];
    motion.annotations = [
      { side: 'before', stepId: step.id, kind: 'failed', startMs: 150, endMs: 159 },
      { side: 'before', stepId: blocked.id, kind: 'blocked', startMs: 159, endMs: 300 },
    ];
    const model = buildPresentation(bundle, settings);
    expect(model.totalFrames).toBe(36);
    expect(model.annotations[0]).toMatchObject({ startFrame: 32, endFrame: 32 });
    const beforeFailure = model.cards.find((card) => card.image === model.selections[1]?.overlay);
    expect(beforeFailure?.beforeBadge).toBe('');
    for (const selection of model.selections.slice(2)) {
      const overlay = model.cards.find((card) => card.image === selection.overlay);
      expect(overlay?.beforeBadge).toContain('BLOCKED');
      expect(overlay?.beforeBadge).toContain('PRIOR STEP FAILED');
      expect(overlay?.beforeBadge).toContain('HELD');
      expect(overlay?.beforeBadge).toContain('UNVERIFIED PAIR');
      expect(overlay?.afterBadge).toBe('');
      expect(selection.before).toBe('frames/before-0.png');
    }
  });

  describe.each(['before', 'after'] as const)('motion status on %s', (side) => {
    const failedBadge = 'FAILED | HELD | UNVERIFIED PAIR';
    const blockedBadge = 'BLOCKED | PRIOR STEP FAILED | HELD | UNVERIFIED PAIR';
    const otherSide = side === 'before' ? 'after' : 'before';
    const badgeKey = side === 'before' ? 'beforeBadge' : 'afterBadge';
    const otherBadgeKey = side === 'before' ? 'afterBadge' : 'beforeBadge';

    it.each([false, true])('labels the barrier gap and preserves blocked status with track failure %s', (trackFailure) => {
      const bundle = partialMotionBundle(side, trackFailure);
      const scenario = bundle.scenarios[0]!;
      const recordedMotion = structuredClone(bundle.motion);
      const model = buildPresentation(bundle, settings);
      const overlays = motionOverlays(model);
      expect(overlays.map((card) => card[badgeKey])).toEqual(['', '', failedBadge, blockedBadge, blockedBadge, blockedBadge]);
      expect(overlays.every((card) => card[otherBadgeKey] === '')).toBe(true);
      expect(model.totalFrames).toBe(36);
      expect(model.segments.find((segment) => segment.kind === 'motion')).toEqual({
        kind: 'motion', scenarioId: scenario.id, stepId: null, startFrame: 30, durationFrames: 6,
        sourceStartMs: 100, sourceEndMs: 300,
      });
      expect(model.stepBoundaries).toEqual([
        { scenarioId: scenario.id, stepId: scenario.steps[0]!.id, startFrame: 30, endFrame: 32 },
        { scenarioId: scenario.id, stepId: 'next-step', startFrame: 32, endFrame: 36 },
      ]);
      expect(model.annotations).toEqual([
        { scenarioId: scenario.id, stepId: scenario.steps[0]!.id, side, kind: 'failed', startFrame: 32, endFrame: 32 },
        { scenarioId: scenario.id, stepId: 'next-step', side, kind: 'blocked', startFrame: 33, endFrame: 36 },
      ]);
      expect(model.selections.map(({ frame, before, after }) => ({ frame, before, after }))).toEqual([
        { frame: 30, before: null, after: null },
        { frame: 31, before: 'frames/before-0.png', after: 'frames/after-0.png' },
        ...[32, 33, 34, 35].map((frame) => ({
          frame, [side]: `frames/${side}-0.png`, [otherSide]: `frames/${otherSide}-1.png`,
        })),
      ]);
      expect(bundle.motion).toEqual(recordedMotion);
    });

    it('uses the current blocked marker across successive step gaps without relying on terminal annotations', () => {
      const bundle = partialMotionBundle(side, true);
      const scenario = bundle.scenarios[0]!;
      const motion = bundle.motion[0]!;
      const blocked = structuredClone(scenario.steps[1]!);
      blocked.id = 'third-step';
      blocked.caption = 'Third step';
      scenario.steps.push(blocked);
      const timing = { ...structuredClone(motion.steps[1]!), id: blocked.id, barrierMs: 100 + 4000 / 30 };
      timing[side] = { kind: 'blocked', atMs: 234 };
      timing[otherSide] = { kind: 'executed', dispatch: sourceMarker(234), completion: sourceMarker(260), observationEnd: sourceMarker(290) };
      motion.steps.push(timing);
      motion.annotations = [];
      CaptureBundleSchema.parse(bundle);
      const model = buildPresentation(bundle, settings);
      const overlays = motionOverlays(model);
      expect(overlays.map((card) => card[badgeKey])).toEqual(['', '', failedBadge, blockedBadge, failedBadge, blockedBadge]);
      expect(overlays[4]?.caption).toContain('Third step');
      expect(overlays[5]?.caption).toContain('Third step');
      expect(model.totalFrames).toBe(36);
      expect(model.selections.slice(2).every((selection) => selection[side] === `frames/${side}-0.png`)).toBe(true);
      expect(model.selections.slice(2).every((selection) => selection[otherSide] === `frames/${otherSide}-1.png`)).toBe(true);
    });

    it('does not start terminal labels from widened annotations before their markers', () => {
      const bundle = partialMotionBundle(side);
      const motion = bundle.motion[0]!;
      motion.annotations[0]!.startMs = 100;
      motion.annotations[1]!.startMs = 165;
      const overlays = motionOverlays(buildPresentation(bundle, settings));
      expect(overlays.map((card) => card[badgeKey])).toEqual(['', '', failedBadge, blockedBadge, blockedBadge, blockedBadge]);
    });

    for (const kind of ['waiting', 'expected_absent', 'skipped_by_side'] as const) {
      it.each([0, 0.001])(`starts track-only failure at the reached tick over ${kind}, offset %s ms`, (offset) => {
        const bundle = motionBundle();
        const motion = bundle.motion[0]!;
        const failureAtMs = 100 + 2000 / 30 + offset;
        motion.endMs = 300;
        motion.tracks[side] = {
          ...motion.tracks[side], status: 'failed', failureAtMs,
          error: { code: 'CAPTURE_STREAM_FAILED', phase: 'capture', message: 'Synthetic stream failure', hint: 'Inspect the synthetic track' },
        };
        bundle.scenarios[0]!.outcome = 'partial';
        bundle.scenarios[0]!.errors = [motion.tracks[side].error];
        motion.annotations = [{ side, stepId: motion.steps[0]!.id, kind, startMs: 100, endMs: 300 }];
        CaptureBundleSchema.parse(bundle);
        const ordinaryBadge = {
          waiting: 'WAITING | APP CONTINUES LIVE',
          expected_absent: 'EXPECTED ABSENT | UNVERIFIED PAIR',
          skipped_by_side: 'EXCLUDED | HELD | UNVERIFIED PAIR',
        }[kind];
        const model = buildPresentation(bundle, settings);
        expect(motionOverlays(model).map((card) => card[badgeKey])).toEqual([
          ordinaryBadge, ordinaryBadge, offset === 0 ? failedBadge : ordinaryBadge,
          failedBadge, failedBadge, failedBadge,
        ]);
        expect(motionOverlays(model).every((card) => card[otherBadgeKey] === '')).toBe(true);
        expect(model.totalFrames).toBe(36);
        expect(model.selections.slice(2).every((selection) => selection[side] === `frames/${side}-1.png`)).toBe(true);
      });
    }

    it('retains ordinary half-open annotation intervals and leaves the next scenario free of prior failure', () => {
      const bundle = partialMotionBundle(side, true);
      const fresh = motionBundle();
      const scenario = fresh.scenarios[0]!;
      const motion = fresh.motion[0]!;
      scenario.id = 'fresh-scenario';
      motion.id = scenario.id;
      motion.endMs = 300;
      motion.annotations = [
        { side, stepId: motion.steps[0]!.id, kind: 'waiting', startMs: 100, endMs: 100 + 2000 / 30 },
        { side, stepId: motion.steps[0]!.id, kind: 'expected_absent', startMs: 100 + 2000 / 30, endMs: 100 + 4000 / 30 },
        { side, stepId: motion.steps[0]!.id, kind: 'skipped_by_side', startMs: 100 + 4000 / 30, endMs: 100 + 5000 / 30 },
      ];
      bundle.scenarios.push(scenario);
      bundle.motion.push(motion);
      CaptureBundleSchema.parse(bundle);
      const model = buildPresentation(bundle, settings);
      const overlays = motionOverlays(model).slice(6);
      expect(overlays.map((card) => card[badgeKey])).toEqual([
        'WAITING | APP CONTINUES LIVE', 'WAITING | APP CONTINUES LIVE',
        'EXPECTED ABSENT | UNVERIFIED PAIR', 'EXPECTED ABSENT | UNVERIFIED PAIR',
        'EXCLUDED | HELD | UNVERIFIED PAIR', '',
      ]);
      expect(overlays.every((card) => card[otherBadgeKey] === '')).toBe(true);
      expect(model.totalFrames).toBe(72);
      expect(model.selections.slice(6).map((selection) => selection.frame)).toEqual([66, 67, 68, 69, 70, 71]);
      expect(model.selections.slice(8).every((selection) => selection[side] === `frames/${side}-1.png`)).toBe(true);
    });
  });

  it('uses the earliest highest valid checkpoint and labels missing pairs incomplete', () => {
    const bundle = structuredClone(fixture);
    const scenario = bundle.scenarios[0];
    const source = scenario?.steps[0];
    if (!scenario || !source) throw new Error('Missing fixture');
    scenario.steps = [0.1, 0.7, 0.7].map((changeRatio, index) => ({ ...source, id: `step-${index}`, changeRatio }));
    expect(buildPresentation(bundle, settings).posterSelection).toEqual({
      kind: 'checkpoint',
      scenarioId: scenario.id,
      stepId: 'step-1',
      changeRatio: 0.7,
    });
    scenario.steps = [
      { ...source, changeRatio: null, before: { ...source.before, status: 'failed', reasonCode: 'STEP_TIMEOUT' } },
    ];
    scenario.outcome = 'partial';
    expect(buildPresentation(bundle, settings).posterSelection.kind).toBe('incomplete');
  });
  it('shows failures and preserves explicit selection without falsely claiming missing coverage', () => {
    const model = buildPresentation(fixture, { ...settings, coverage: { ...settings.coverage, complete: false } });
    expect(model.cards[0]?.caption).not.toContain('COVERAGE INCOMPLETE');
    const omitted = buildPresentation(fixture, {
      ...settings,
      coverage: { ...settings.coverage, omitted: [{ path: '/other', reason: 'omitted', via: [] }] },
    });
    expect(omitted.cards.every((card) => card.caption.includes('COVERAGE INCOMPLETE'))).toBe(true);
  });
  it('retains JSON Unicode with an explicit ASCII presentation fallback', () => {
    expect(presentationText('après\nHello')).toBe('apr?s Hello');
    expect(presentationWarnings(fixture, settings)[0]?.code).toBe('FONT_GLYPH_UNSUPPORTED');
  });
});
