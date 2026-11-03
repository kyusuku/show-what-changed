import { motionPlaybackWindow } from '../schema/index.js';
import type { CaptureBundle, CapturedStep, MotionScenario, Side, Timeline, Warning } from '../schema/index.js';
import type { ComposerSettings } from '../schema/contracts.js';

export type RenderCard = {
  image: string;
  kind: 'title' | 'step' | 'overlay';
  title: string;
  route: string;
  caption: string;
  beforeLabel: string;
  afterLabel: string;
  beforeBadge: string;
  afterBadge: string;
  beforeImage: string | null;
  afterImage: string | null;
};
export type Presentation = {
  cards: RenderCard[];
  segments: Timeline['segments'];
  selections: Timeline['selections'];
  stepBoundaries: Timeline['stepBoundaries'];
  annotations: Timeline['annotations'];
  totalFrames: number;
  poster: string;
  posterSelection: Timeline['posterSelection'];
};
export function presentationText(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').replace(/[^\x20-\x7e]/gu, '?');
}
function badge(status: string): string {
  switch (status) {
    case 'ok':
      return '';
    case 'waiting':
      return 'WAITING | APP CONTINUES LIVE';
    case 'expected_absent':
      return 'EXPECTED ABSENT | UNVERIFIED PAIR';
    case 'skipped_by_side':
      return 'EXCLUDED | HELD | UNVERIFIED PAIR';
    case 'failed':
      return 'FAILED | HELD | UNVERIFIED PAIR';
    case 'blocked':
      return 'BLOCKED | PRIOR STEP FAILED | HELD | UNVERIFIED PAIR';
    default:
      return '';
  }
}
type MotionStatus = 'ok' | MotionScenario['annotations'][number]['kind'];
function motionStatus(motion: MotionScenario, side: Side, atMs: number): MotionStatus {
  const current = motion.steps.findLast((step) => step.barrierMs <= atMs)?.[side];
  if (current?.kind === 'blocked' && current.atMs <= atMs) return 'blocked';
  const track = motion.tracks[side];
  if (
    motion.steps.some((step) => {
      const timing = step[side];
      return timing.kind === 'failed' && timing.failure.runElapsedMs <= atMs;
    }) ||
    (track.status === 'failed' && track.failureAtMs <= atMs)
  ) return 'failed';
  const annotation = motion.annotations.findLast(
    (value) => value.side === side && value.kind !== 'failed' && value.kind !== 'blocked' &&
      value.startMs <= atMs && atMs < value.endMs,
  );
  return annotation?.kind ?? 'ok';
}
export function selectSource(
  bundle: Extract<CaptureBundle, { captureMode: 'motion' }>,
  scenarioIndex: number,
  side: Side,
  atMs: number,
): string | null {
  const motion = bundle.motion[scenarioIndex];
  const scenario = bundle.scenarios[scenarioIndex];
  if (!motion || !scenario) throw new Error('Missing motion scenario');
  let cutoff = atMs;
  let held: string | null | undefined;
  for (let i = 0; i < motion.steps.length; i++) {
    const timingStep = motion.steps[i];
    const step = scenario.steps[i];
    if (!timingStep || !step) continue;
    const timing = timingStep[side];
    const result = step[side];
    if (timing.kind === 'failed' && atMs >= timing.failure.runElapsedMs) {
      cutoff = Math.min(cutoff, timing.failure.runElapsedMs);
      held = undefined;
      break;
    }
    if (timingStep.barrierMs > atMs) continue;
    if ((timing.kind === 'excluded' || timing.kind === 'blocked') && atMs >= timing.atMs)
      held = result.imageKind === 'neutral' ? null : result.image.path;
    else held = undefined;
  }
  if (held !== undefined) return held;
  const track = motion.tracks[side];
  if (track.status === 'failed' && atMs >= track.failureAtMs) cutoff = Math.min(cutoff, track.failureAtMs);
  let path: string | null = null;
  for (const frame of track.frames) {
    if (frame.runElapsedMs > cutoff) break;
    path = frame.artifact.path;
  }
  return path;
}
function finalMotionBadge(scenario: CaptureBundle['scenarios'][number], motion: MotionScenario, side: Side): string {
  const outcomes = new Set(scenario.steps.map((step) => step[side].status));
  const failures = motion.steps.flatMap((step) => {
    const timing = step[side];
    return timing.kind === 'failed' ? [timing.failure.runElapsedMs] : [];
  });
  const track = motion.tracks[side];
  if (track.status === 'failed') failures.push(track.failureAtMs);
  const statuses = [
    outcomes.has('failed') ? 'FAILED' : '',
    outcomes.has('blocked') ? 'BLOCKED' : '',
    track.status === 'failed' ? 'CAPTURE FAILED' : '',
  ].filter(Boolean);
  if (!statuses.length) statuses.push(outcomes.size === 1 && outcomes.has('ok') ? 'OK' : 'UNVERIFIED PAIR');
  const afterWindow = failures.length > 0 && Math.min(...failures) >= motionPlaybackWindow(motion.timing).endMs;
  return ['FINAL OUTCOME', statuses.join(', '), afterWindow ? 'AFTER SHOWN WINDOW' : ''].filter(Boolean).join(' | ');
}
export function buildPresentation(bundle: CaptureBundle, settings: ComposerSettings): Presentation {
  const incompleteCapture = bundle.scenarios.some((scenario) => scenario.outcome === 'partial');
  const incompleteCoverage =
    settings.coverage.unresolved.length + settings.coverage.omitted.length + settings.coverage.unsupported.length > 0;
  const invalidProvenance = !settings.provenance.before.valid || !settings.provenance.after.valid;
  const caveats = [
    incompleteCapture ? 'CAPTURE INCOMPLETE' : '',
    incompleteCoverage ? 'COVERAGE INCOMPLETE' : '',
    invalidProvenance ? 'PROVENANCE INVALID' : '',
    'STATE PARITY UNVERIFIED',
  ].filter(Boolean);
  const mode = bundle.captureMode.toUpperCase();
  const labels = {
    beforeLabel: presentationText(`BEFORE | ${mode} | ${bundle.labels.before}`),
    afterLabel: presentationText(`AFTER | ${mode} | ${bundle.labels.after}`),
  };
  const model: Presentation = {
    cards: [],
    segments: [],
    selections: [],
    stepBoundaries: [],
    annotations: [],
    totalFrames: 0,
    poster: '',
    posterSelection: { kind: 'incomplete', reason: 'No verified checkpoint pair' },
  };
  const addCard = (card: Omit<RenderCard, 'image'>): string => {
    const image = `composed/${String(model.cards.length).padStart(3, '0')}-${card.kind}.png`;
    model.cards.push({ ...card, image });
    return image;
  };
  let best = -1;
  for (let index = 0; index < bundle.scenarios.length; index++) {
    const scenario = bundle.scenarios[index];
    if (!scenario) continue;
    const common = {
      ...labels,
      title: presentationText(scenario.title),
      route: presentationText(scenario.initialRoute),
    };
    const motion = bundle.captureMode === 'motion' ? bundle.motion[index] : undefined;
    const title = addCard({
      ...common,
      kind: 'title',
      caption: presentationText([mode, ...caveats, scenario.title, scenario.initialRoute].join(' | ')),
      beforeBadge: motion ? finalMotionBadge(scenario, motion, 'before') : '',
      afterBadge: motion ? finalMotionBadge(scenario, motion, 'after') : '',
      beforeImage: null,
      afterImage: null,
    });
    model.segments.push({
      kind: 'title',
      scenarioId: scenario.id,
      stepId: null,
      image: title,
      startFrame: model.totalFrames,
      durationFrames: 30,
    });
    model.totalFrames += 30;
    for (const step of scenario.steps) {
      const checkpoint = addCard({
        ...common,
        kind: 'step',
        caption: presentationText(
          [mode, ...caveats, step.changeRatio === null ? 'UNVERIFIED PAIR' : '', step.caption]
            .filter(Boolean)
            .join(' | '),
        ),
        beforeBadge: badge(step.before.status),
        afterBadge: badge(step.after.status),
        beforeImage: step.before.image.path,
        afterImage: step.after.image.path,
      });
      if (!model.poster) model.poster = checkpoint;
      if (step.changeRatio !== null && step.changeRatio > best) {
        best = step.changeRatio;
        model.poster = checkpoint;
        model.posterSelection = {
          kind: 'checkpoint',
          scenarioId: scenario.id,
          stepId: step.id,
          changeRatio: step.changeRatio,
        };
      }
      if (bundle.captureMode === 'keyframes') {
        const durationFrames = Math.max(6, Math.ceil((step.observeMs * 30) / 1000));
        model.segments.push({
          kind: 'step',
          scenarioId: scenario.id,
          stepId: step.id,
          image: checkpoint,
          startFrame: model.totalFrames,
          durationFrames,
        });
        model.stepBoundaries.push({
          scenarioId: scenario.id,
          stepId: step.id,
          startFrame: model.totalFrames,
          endFrame: model.totalFrames + durationFrames,
        });
        model.totalFrames += durationFrames;
      }
    }
    if (bundle.captureMode === 'keyframes') continue;
    if (!motion) throw new Error('Missing motion');
    const startFrame = model.totalFrames;
    const window = motionPlaybackWindow(motion.timing);
    const { durationFrames } = window;
    const output = (time: number) =>
      startFrame + Math.max(0, Math.min(durationFrames, Math.ceil(((time - window.startMs) * 30) / 1000 - 1e-9)));
    model.segments.push({
      kind: 'motion',
      scenarioId: scenario.id,
      stepId: null,
      startFrame,
      durationFrames,
      sourceStartMs: window.startMs,
      sourceEndMs: window.endMs,
    });
    const visibleInterval = (startMs: number, endMs: number) => {
      const start = Math.max(startMs, window.startMs);
      const end = Math.min(endMs, window.endMs);
      return start < end ? { startFrame: output(start), endFrame: output(end) } : null;
    };
    motion.steps.forEach((step, i) => {
      const interval = visibleInterval(step.barrierMs, motion.steps[i + 1]?.barrierMs ?? motion.timing.observedEndMs);
      if (interval) model.stepBoundaries.push({ scenarioId: scenario.id, stepId: step.id, ...interval });
    });
    for (const annotation of motion.annotations) {
      const interval = visibleInterval(annotation.startMs, annotation.endMs);
      if (interval) model.annotations.push({
        scenarioId: scenario.id,
        stepId: annotation.stepId,
        side: annotation.side,
        kind: annotation.kind,
        ...interval,
      });
    }
    const overlays = new Map<string, string>();
    for (let frame = 0; frame < durationFrames; frame++) {
      const atMs = window.startMs + (frame * 1000) / 30;
      let step: CapturedStep | undefined = scenario.steps[0];
      for (let i = 0; i < motion.steps.length; i++)
        if ((motion.steps[i]?.barrierMs ?? Infinity) <= atMs) step = scenario.steps[i];
      const statuses = { before: '', after: '' };
      for (const side of ['before', 'after'] as const) statuses[side] = badge(motionStatus(motion, side, atMs));
      const key = JSON.stringify([step?.id, statuses.before, statuses.after]);
      let overlay = overlays.get(key);
      if (!overlay) {
        overlay = addCard({
          ...common,
          kind: 'overlay',
          caption: presentationText([mode, ...caveats, step?.caption ?? ''].filter(Boolean).join(' | ')),
          beforeBadge: statuses.before,
          afterBadge: statuses.after,
          beforeImage: null,
          afterImage: null,
        });
        overlays.set(key, overlay);
      }
      model.selections.push({
        frame: startFrame + frame,
        before: selectSource(bundle, index, 'before', atMs),
        after: selectSource(bundle, index, 'after', atMs),
        overlay,
      });
    }
    model.totalFrames += durationFrames;
  }
  return model;
}
export function presentationWarnings(bundle: CaptureBundle, _settings: ComposerSettings): Warning[] {
  const values = [
    bundle.labels.before,
    bundle.labels.after,
    ...bundle.scenarios.flatMap((scenario) => [
      scenario.title,
      scenario.initialRoute,
      ...scenario.steps.map((step) => step.caption),
    ]),
  ];
  return values.some((value) => /[^\x20-\x7e\r\n]/u.test(value))
    ? [
        {
          code: 'FONT_GLYPH_UNSUPPORTED',
          message:
            'Presentation maps characters outside printable ASCII to ?. Source JSON and app images preserve Unicode.',
        },
      ]
    : [];
}
