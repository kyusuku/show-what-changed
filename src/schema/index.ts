import { z } from 'zod';
import { sanitizeText } from './io.js';
import { RecipeSchema, RelativePathSchema, SourceSettingsSchema } from './recipe.js';
export * from './recipe.js';

export const TOOL_VERSION = '0.1.0';
export const FPS = 30;
export const VIEWPORT = { width: 1280, height: 800, deviceScaleFactor: 1 } as const;
export const CANVAS = { width: 1920, height: 686 } as const;
export const MAX_INPUT_BYTES = 1024 * 1024;
export const MAX_PLAN_BYTES = 128 * 1024 * 1024;
export const MAX_METADATA_BYTES = 256 * 1024 * 1024;
export const SCHEMA_VERSION = 2;
export const SideSchema = z.enum(['before', 'after']);
export type Side = z.infer<typeof SideSchema>;
export const IdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const OidSchema = z.string().regex(/^[a-f0-9]{40,64}$/);
export const RunIdSchema = z.string().regex(/^\d{8}T\d{9}Z-[a-f0-9]{16}$/);
export const SafeTextSchema = z.string().regex(/^[^\x00-\x1f\x7f-\x9f]*$/);
export const HumanTextSchema = SafeTextSchema.refine((value) => [...value].length <= 160, 'At most 160 Unicode code points').meta({ maxLength: 160 });
export const AppPathSchema = z.string().max(2048).regex(/^\/(?!\/)[^\x00-\x1f\x7f-\x9f\\]*$/);
export const ArtifactPathSchema = z.string().min(1).max(4096).regex(/^(?!\/|[A-Za-z]:)(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?!.*\/\/)(?!.*\/$)[^\\\x00-\x1f\x7f]+$/);
const MillisecondsSchema = z.number().finite().nonnegative();
const ObserveMsSchema = z.number().int().min(0).max(3000);
const StepTimeoutSchema = z.number().int().min(100).max(30000);
const LocatorTextSchema = z.string().min(1).max(512);
export const AriaRoleSchema = z.enum([
  'alert', 'alertdialog', 'application', 'article', 'banner', 'blockquote', 'button', 'caption', 'cell',
  'checkbox', 'code', 'columnheader', 'combobox', 'complementary', 'contentinfo', 'definition', 'deletion',
  'dialog', 'directory', 'document', 'emphasis', 'feed', 'figure', 'form', 'generic', 'grid', 'gridcell',
  'group', 'heading', 'img', 'insertion', 'link', 'list', 'listbox', 'listitem', 'log', 'main', 'marquee',
  'math', 'meter', 'menu', 'menubar', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'navigation', 'none',
  'note', 'option', 'paragraph', 'presentation', 'progressbar', 'radio', 'radiogroup', 'region', 'row',
  'rowgroup', 'rowheader', 'scrollbar', 'search', 'searchbox', 'separator', 'slider', 'spinbutton', 'status',
  'strong', 'subscript', 'superscript', 'switch', 'tab', 'table', 'tablist', 'tabpanel', 'term', 'textbox',
  'time', 'timer', 'toolbar', 'tooltip', 'tree', 'treegrid', 'treeitem',
]);
export const LocatorSchema = z.union([
  z.strictObject({ role: AriaRoleSchema, name: LocatorTextSchema.optional() }),
  z.strictObject({ label: LocatorTextSchema }), z.strictObject({ text: LocatorTextSchema }),
  z.strictObject({ testId: LocatorTextSchema }), z.strictObject({ css: LocatorTextSchema }),
]);
export type Locator = z.infer<typeof LocatorSchema>;
const StepCommon = {
  id: IdSchema, note: HumanTextSchema.optional(), only: z.enum(['before', 'after', 'both']).default('both'),
  allowMissing: z.array(SideSchema).max(2).meta({ uniqueItems: true }).default([]), timeoutMs: StepTimeoutSchema.optional(), observeMs: ObserveMsSchema.optional(),
};
export const StepSchema = z.discriminatedUnion('op', [
  z.strictObject({ ...StepCommon, op: z.literal('goto'), path: AppPathSchema, allowMissing: z.array(SideSchema).max(0).default([]) }),
  z.strictObject({ ...StepCommon, op: z.literal('click'), target: LocatorSchema }),
  z.strictObject({ ...StepCommon, op: z.literal('fill'), target: LocatorSchema, value: z.string().max(4096) }),
  z.strictObject({ ...StepCommon, op: z.literal('hover'), target: LocatorSchema }),
  z.strictObject({ ...StepCommon, op: z.literal('scrollBy'), target: LocatorSchema.optional(), y: z.number().int().min(-1600).max(1600) }),
  z.strictObject({ ...StepCommon, op: z.literal('expectVisible'), target: LocatorSchema }),
  z.strictObject({ ...StepCommon, op: z.literal('screenshot'), allowMissing: z.array(SideSchema).max(0).default([]) }),
]).superRefine((step, context) => {
  if (new Set(step.allowMissing).size !== step.allowMissing.length) context.addIssue({ code: 'custom', message: 'Duplicate allowMissing side' });
  if (step.allowMissing.length && !('target' in step)) context.addIssue({ code: 'custom', message: 'allowMissing requires a locator operation' });
  if (step.allowMissing.some((side) => step.only !== 'both' && step.only !== side)) context.addIssue({ code: 'custom', message: 'allowMissing side must be included by only' });
});
export type Step = z.infer<typeof StepSchema>;
export const ScenarioSchema = z.strictObject({ schemaVersion: z.literal(2), id: IdSchema, title: HumanTextSchema, steps: z.array(StepSchema).min(1).max(12) })
  .superRefine((scenario, context) => {
    if (scenario.steps[0]?.op !== 'goto') context.addIssue({ code: 'custom', message: 'The first step must be goto' });
    if (new Set(scenario.steps.map((step) => step.id)).size !== scenario.steps.length) context.addIssue({ code: 'custom', message: 'Step IDs must be unique' });
  }).meta({ allOf: [{ properties: { steps: { prefixItems: [{ properties: { op: { const: 'goto' } }, required: ['op'] }] } } }] });
export type Scenario = z.infer<typeof ScenarioSchema>;
export const ViewportInputSchema = z.strictObject({ width: z.number().int().min(320).max(1920), height: z.number().int().min(240).max(1200) })
  .refine((viewport) => viewport.width * viewport.height <= 2073600, 'At most 2073600 source pixels');
export const ViewportSchema = ViewportInputSchema.safeExtend({ deviceScaleFactor: z.literal(1) });
export const MaskRectSchema = z.strictObject({ x: z.number().int().nonnegative(), y: z.number().int().nonnegative(), width: z.number().int().positive(), height: z.number().int().positive() });
const CaptureFields = {
  viewport: ViewportInputSchema.default({ width: 1280, height: 800 }),
  fixedTime: z.iso.datetime({ offset: false }).nullable().default(null),
  stepTimeoutMs: StepTimeoutSchema.default(10000), observeMs: ObserveMsSchema.default(800),
  maxScenarioMs: z.number().int().min(100).max(60000).default(60000),
};
export const CaptureSettingsSchema = z.discriminatedUnion('mode', [
  z.strictObject({ ...CaptureFields, mode: z.literal('motion'), maskRects: z.array(MaskRectSchema).max(20).default([]) }),
  z.strictObject({ ...CaptureFields, mode: z.literal('keyframes'), maskSelectors: z.array(z.string().min(1).max(512)).max(20).default([]) }),
]).superRefine((capture, context) => {
  if (capture.mode === 'motion' && capture.maskRects.some((rect) => rect.x + rect.width > capture.viewport.width || rect.y + rect.height > capture.viewport.height)) context.addIssue({ code: 'custom', message: 'Masks must fit the viewport' });
});
export const ConfigSchema = z.strictObject({
  schemaVersion: z.literal(2), appDir: RelativePathSchema.default('.'), execution: RecipeSchema,
  source: SourceSettingsSchema.prefault({}),
  routes: z.strictObject({ include: z.array(AppPathSchema).max(3).default([]), params: z.record(AppPathSchema, z.array(AppPathSchema).min(1)).default({}) }).prefault({}),
  capture: CaptureSettingsSchema.prefault({ mode: 'motion' }),
});
export type Config = z.infer<typeof ConfigSchema>;
export type RecorderSettings = Config['capture'];
export const WarningSchema = z.strictObject({ code: SafeTextSchema.min(1), message: SafeTextSchema, files: z.array(z.string()).optional() });
export type Warning = z.infer<typeof WarningSchema>;
export const ToolErrorSchema = z.strictObject({ code: SafeTextSchema.min(1), phase: SafeTextSchema.min(1), side: SideSchema.optional(), stepId: IdSchema.optional(), message: SafeTextSchema, hint: SafeTextSchema, logPath: ArtifactPathSchema.optional() });
export type ToolError = z.infer<typeof ToolErrorSchema>;
export const ChangedFileSchema = z.strictObject({ status: z.enum(['A', 'M', 'D', 'T']), oldPath: z.string().nullable(), newPath: z.string().nullable() });
export const RouteCandidateSchema = z.strictObject({ path: z.string(), reason: z.string(), via: z.array(z.string()), nonselectionReason: z.string().optional() });
export const CoverageSchema = z.strictObject({
  selected: z.array(RouteCandidateSchema).max(3), unresolved: z.array(RouteCandidateSchema), omitted: z.array(RouteCandidateSchema), unsupported: z.array(RouteCandidateSchema), complete: z.boolean(),
});
export type Coverage = z.infer<typeof CoverageSchema>;
export const SourcePathSchema = z.string().min(1).max(4096).regex(/^(?!\/)(?![\s\S]*(?:^|\/)\.{1,2}(?:\/|$))(?![\s\S]*\/\/)(?![\s\S]*\/$)[^\\\x00]+$/);
export const InventoryEntrySchema = z.union([
  z.strictObject({ path: SourcePathSchema, exists: z.literal(true), executable: z.boolean(), byteLength: z.number().int().nonnegative().max(512 * 1024 * 1024), sha256: Sha256Schema }),
  z.strictObject({ path: SourcePathSchema, exists: z.literal(false) }),
]);
export const SourceInventorySchema = z.array(InventoryEntrySchema).max(200000);
export const SourceStatsSchema = z.strictObject({ files: z.number().int().nonnegative().max(200000), bytes: z.number().int().nonnegative().max(2 * 1024 ** 3), fingerprint: Sha256Schema });
export const BoundDocumentSchema = z.strictObject({ path: z.string().min(1), rawSha256: Sha256Schema });
export const BoundRecipeInputSchema = z.strictObject({ id: IdSchema, path: z.string().min(1), sha256: Sha256Schema, byteLength: z.number().int().nonnegative().max(8 * 1024 * 1024), executable: z.boolean(), extension: z.string().max(128).regex(/^(?:|\.[A-Za-z0-9._-]+)$/) });
export const ExecutionSchema = z.strictObject({
  sourceFileCounts: z.strictObject({ before: z.number().int().nonnegative(), after: z.number().int().nonnegative() }),
  sourceBytes: z.strictObject({ before: z.number().int().nonnegative(), after: z.number().int().nonnegative() }),
  estimatedSnapshotBytes: z.number().int().nonnegative(), environmentReferences: z.array(z.string()), notice: z.string(),
});
export const PlanSchema = z.strictObject({
  schemaVersion: z.literal(2), planId: Sha256Schema, generatedAt: z.iso.datetime(), repoRoot: z.string().min(1),
  requestedBase: z.string().min(1), requestedHead: z.string().min(1), baseCommit: OidSchema, headCommit: OidSchema,
  baseResolution: z.enum(['exact', 'merge-base']), headKind: z.enum(['commit', 'worktree']), sourceFingerprint: Sha256Schema.nullable(),
  configDigest: Sha256Schema, configSource: BoundDocumentSchema.nullable(), scenarioSources: z.array(BoundDocumentSchema).max(3), scenarioDigest: Sha256Schema,
  inputs: z.array(BoundRecipeInputSchema).max(16), inventories: z.strictObject({ before: SourceInventorySchema, after: SourceInventorySchema }),
  sourceStats: z.strictObject({ before: SourceStatsSchema, after: SourceStatsSchema }),
  config: ConfigSchema, scenarios: z.array(ScenarioSchema).min(1).max(3), changedFiles: z.array(ChangedFileSchema), coverage: CoverageSchema,
  execution: ExecutionSchema, warnings: z.array(WarningSchema),
}).superRefine((plan, context) => {
  if (new Set(plan.scenarios.map((scenario) => scenario.id)).size !== plan.scenarios.length) context.addIssue({ code: 'custom', message: 'Scenario IDs must be unique' });
  if ((plan.headKind === 'worktree') !== (plan.sourceFingerprint !== null)) context.addIssue({ code: 'custom', message: 'WORKTREE requires sourceFingerprint and commit mode forbids it' });
  if (plan.inputs.reduce((sum, input) => sum + input.byteLength, 0) > 8 * 1024 * 1024) context.addIssue({ code: 'custom', message: 'Recipe inputs exceed 8 MiB' });
  if (new Set(plan.inputs.map((input) => input.id)).size !== plan.inputs.length) context.addIssue({ code: 'custom', message: 'Bound input IDs must be unique' });
});
export type Plan = z.infer<typeof PlanSchema>;
export const ArtifactSchema = z.strictObject({ path: ArtifactPathSchema, sha256: Sha256Schema, bytes: z.number().int().nonnegative() });
export type Artifact = z.infer<typeof ArtifactSchema>;
export const ImageSanitizationSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('rectangles'), maskDigest: Sha256Schema }),
  z.strictObject({ kind: z.literal('selectors'), selectorCount: z.number().int().nonnegative().max(20) }),
  z.strictObject({ kind: z.literal('neutral') }),
]);
export const SideResultSchema = z.strictObject({
  status: z.enum(['ok', 'expected_absent', 'skipped_by_side', 'failed', 'blocked']), reasonCode: z.string().nullable(),
  image: ArtifactSchema, imageKind: z.enum(['checkpoint', 'held', 'neutral']), sanitization: ImageSanitizationSchema, heldFromStepId: IdSchema.nullable(), elapsedMs: MillisecondsSchema,
}).refine((side) => side.status !== 'ok' || side.heldFromStepId === null && side.imageKind === 'checkpoint', 'Successful steps must have a new checkpoint')
.refine((side) => (side.imageKind === 'held') === (side.heldFromStepId !== null), 'Held images identify the source step')
.refine((side) => side.imageKind !== 'neutral' || side.sanitization.kind === 'neutral', 'Neutral images have explicit safe provenance')
.meta({ allOf: [{ if: { properties: { status: { const: 'ok' } } }, then: { properties: { heldFromStepId: { type: 'null' } } } }] });
export type SideResult = z.infer<typeof SideResultSchema>;
export const CapturedStepSchema = z.strictObject({
  id: IdSchema, op: z.enum(['goto', 'click', 'fill', 'hover', 'scrollBy', 'expectVisible', 'screenshot']), caption: HumanTextSchema,
  observeMs: ObserveMsSchema, before: SideResultSchema, after: SideResultSchema, changeRatio: z.number().finite().min(0).max(1).nullable(),
}).superRefine((step, context) => {
  const verified = step.before.status === 'ok' && step.after.status === 'ok';
  if (verified !== (step.changeRatio !== null)) context.addIssue({ code: 'custom', message: 'Only verified pairs have a changeRatio' });
}).meta({ allOf: [{ if: { properties: { before: { properties: { status: { const: 'ok' } } }, after: { properties: { status: { const: 'ok' } } } } }, then: { properties: { changeRatio: { type: 'number' } } }, else: { properties: { changeRatio: { type: 'null' } } } }] });
export type CapturedStep = z.infer<typeof CapturedStepSchema>;
export const CapturedScenarioSchema = z.strictObject({ id: IdSchema, title: HumanTextSchema, initialRoute: AppPathSchema, outcome: z.enum(['ok', 'partial']), errors: z.array(ToolErrorSchema).default([]), steps: z.array(CapturedStepSchema).min(1).max(12) }).superRefine((scenario, context) => {
  if (new Set(scenario.steps.map((step) => step.id)).size !== scenario.steps.length) context.addIssue({ code: 'custom', message: 'Captured step IDs must be unique' });
  const partial = scenario.errors.length > 0 || scenario.steps.some((step) => [step.before, step.after].some((side) => side.status === 'failed' || side.status === 'blocked'));
  if ((scenario.outcome === 'partial') !== partial) context.addIssue({ code: 'custom', message: 'Scenario outcome must describe its step states' });
});
export const SourceIdentitySchema = z.strictObject({ requested: HumanTextSchema, commit: OidSchema, kind: z.enum(['commit', 'worktree']), materializedHash: Sha256Schema.nullable() });
export type SourceIdentity = z.infer<typeof SourceIdentitySchema>;
const SourcePairSchema = z.strictObject({ before: SourceIdentitySchema, after: SourceIdentitySchema });
export const ClockSampleSchema = z.strictObject({ sourceSeconds: MillisecondsSchema, hostBeforeMs: MillisecondsSchema, hostAfterMs: MillisecondsSchema });
export const ClockMappingRecordSchema = z.strictObject({
  rate: z.literal(1), offsetMs: z.number().finite(), uncertaintyMs: MillisecondsSchema, maxDriftMs: MillisecondsSchema, errorBoundMs: MillisecondsSchema,
  samples: z.array(ClockSampleSchema).min(1).max(128),
});
export const ClockMappingSchema = ClockMappingRecordSchema.superRefine((clock, context) => {
  if (clock.errorBoundMs > 40) context.addIssue({ code: 'custom', message: 'A successful source clock must stay within 40 ms' });
  if (clock.errorBoundMs < clock.uncertaintyMs + clock.maxDriftMs) context.addIssue({ code: 'custom', message: 'Clock error bound must cover uncertainty and drift' });
  for (const sample of clock.samples) {
    const mapped = sample.sourceSeconds * 1000 + clock.offsetMs;
    if (sample.hostAfterMs < sample.hostBeforeMs || mapped < sample.hostBeforeMs - clock.errorBoundMs || mapped > sample.hostAfterMs + clock.errorBoundMs) context.addIssue({ code: 'custom', message: 'Clock sample contradicts the fixed mapping' });
  }
});
export const MotionFrameSchema = z.strictObject({
  artifact: ArtifactSchema, sequence: z.number().int().nonnegative(), sourceMonotonicSeconds: MillisecondsSchema,
  sourceEpochSeconds: MillisecondsSchema.nullable(), runElapsedMs: MillisecondsSchema, receivedMs: MillisecondsSchema,
  width: z.number().int().min(320).max(1920), height: z.number().int().min(240).max(1200),
  deviceScaleFactor: z.literal(1), pageScaleFactor: z.literal(1), offsetTop: z.literal(0), scrollOffsetX: z.number().finite(), scrollOffsetY: z.number().finite(), maskDigest: Sha256Schema,
});
export type MotionFrame = z.infer<typeof MotionFrameSchema>;
export const TrackStatsSchema = z.strictObject({
  receivedFrames: z.number().int().nonnegative(), persistedFrames: z.number().int().nonnegative(), acknowledgedFrames: z.number().int().nonnegative(), rejectedFrames: z.number().int().nonnegative(),
  maxQueueDepth: z.number().int().nonnegative().max(2), sourceDroppedFrames: z.null(), maxGapMs: MillisecondsSchema,
});
const TrackFields = { frames: z.array(MotionFrameSchema).max(12000), stats: TrackStatsSchema, gaps: z.array(z.strictObject({ fromSourceSeconds: MillisecondsSchema, toSourceSeconds: MillisecondsSchema, durationMs: MillisecondsSchema })).max(12000) };
export const MotionTrackSchema = z.discriminatedUnion('status', [
  z.strictObject({ ...TrackFields, status: z.literal('ok'), clock: ClockMappingSchema, error: z.null() }),
  z.strictObject({ ...TrackFields, status: z.literal('failed'), clock: ClockMappingRecordSchema.nullable(), error: ToolErrorSchema, failureAtMs: MillisecondsSchema }),
]).superRefine((track, context) => {
  for (let i = 0; i < track.frames.length; i++) {
    const frame = track.frames[i];
    const previous = track.frames[i - 1];
    if (!frame) continue;
    if (previous && (frame.sequence <= previous.sequence || frame.sourceMonotonicSeconds <= previous.sourceMonotonicSeconds || frame.runElapsedMs <= previous.runElapsedMs)) context.addIssue({ code: 'custom', message: 'Motion frames must have increasing source clocks and sequences' });
    if (!track.clock || Math.abs(frame.runElapsedMs - (1000 * frame.sourceMonotonicSeconds + track.clock.offsetMs)) > 0.001) context.addIssue({ code: 'custom', message: 'Motion frames must use the fixed session clock mapping' });
  }
  if (track.stats.persistedFrames !== track.frames.length || track.stats.receivedFrames < track.stats.persistedFrames + track.stats.rejectedFrames || track.stats.acknowledgedFrames > track.stats.receivedFrames) context.addIssue({ code: 'custom', message: 'Track counters must match observed work' });
  if (track.status === 'ok' && (!track.frames.length || track.stats.rejectedFrames !== 0 || track.stats.acknowledgedFrames !== track.stats.receivedFrames || track.stats.persistedFrames !== track.stats.receivedFrames)) context.addIssue({ code: 'custom', message: 'Successful motion needs actual frames and complete observed processing' });
});
export const SourceMarkerSchema = z.strictObject({
  kind: z.literal('source'), sourceSeconds: MillisecondsSchema, hostBeforeMs: MillisecondsSchema, hostAfterMs: MillisecondsSchema,
  runElapsedMs: MillisecondsSchema, uncertaintyMs: MillisecondsSchema.max(40),
}).refine((marker) => marker.hostAfterMs >= marker.hostBeforeMs && marker.runElapsedMs >= marker.hostBeforeMs - marker.uncertaintyMs && marker.runElapsedMs <= marker.hostAfterMs + marker.uncertaintyMs, 'Source markers need bounded host brackets');
export const FailureMarkerSchema = z.union([
  SourceMarkerSchema,
  z.strictObject({ kind: z.literal('host'), runElapsedMs: MillisecondsSchema, reason: z.literal('source-clock-unavailable') }),
]);
export const StepTimingSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('executed'), dispatch: SourceMarkerSchema, completion: SourceMarkerSchema, observationEnd: SourceMarkerSchema }),
  z.strictObject({ kind: z.literal('failed'), dispatch: SourceMarkerSchema.nullable(), failure: FailureMarkerSchema }),
  z.strictObject({ kind: z.literal('excluded'), atMs: MillisecondsSchema }),
  z.strictObject({ kind: z.literal('blocked'), atMs: MillisecondsSchema }),
]);
export const MotionAnnotationSchema = z.strictObject({ side: SideSchema, stepId: IdSchema, kind: z.enum(['waiting', 'expected_absent', 'skipped_by_side', 'failed', 'blocked']), startMs: MillisecondsSchema, endMs: MillisecondsSchema });
export const MotionScenarioSchema = z.strictObject({
  id: IdSchema, startMs: MillisecondsSchema, endMs: MillisecondsSchema,
  tracks: z.strictObject({ before: MotionTrackSchema, after: MotionTrackSchema }),
  steps: z.array(z.strictObject({ id: IdSchema, barrierMs: MillisecondsSchema, before: StepTimingSchema, after: StepTimingSchema })).min(1).max(12),
  annotations: z.array(MotionAnnotationSchema).max(144),
}).superRefine((scenario, context) => {
  if (scenario.endMs <= scenario.startMs || scenario.endMs - scenario.startMs > 60000) context.addIssue({ code: 'custom', message: 'Motion scenario duration must be positive and at most 60 seconds' });
  for (const annotation of scenario.annotations) if (annotation.startMs < scenario.startMs || annotation.endMs > scenario.endMs || annotation.endMs < annotation.startMs) context.addIssue({ code: 'custom', message: 'Annotation must lie within its scenario' });
  for (const step of scenario.steps) for (const side of ['before', 'after'] as const) {
    const timing = step[side];
    const markers = timing.kind === 'executed' ? [timing.dispatch, timing.completion, timing.observationEnd] : timing.kind === 'failed' ? [...(timing.dispatch ? [timing.dispatch] : []), timing.failure] : [];
    const times = markers.length ? markers.map((marker) => marker.runElapsedMs) : 'atMs' in timing ? [timing.atMs] : [];
    if (step.barrierMs < scenario.startMs || times.some((time, index) => time < step.barrierMs || time > scenario.endMs || index > 0 && time < (times[index - 1] ?? 0))) context.addIssue({ code: 'custom', message: 'Step markers must respect barrier and scenario order' });
    for (const marker of markers) if (marker.kind === 'source') {
      const clock = scenario.tracks[side].clock;
      if (!clock || Math.abs(marker.runElapsedMs - (1000 * marker.sourceSeconds + clock.offsetMs)) > 0.001) context.addIssue({ code: 'custom', message: 'Action markers must use the fixed track clock mapping' });
    }
  }
});
export type MotionScenario = z.infer<typeof MotionScenarioSchema>;
const CaptureBundleFields = {
  schemaVersion: z.literal(2), runId: RunIdSchema, toolVersion: z.literal(TOOL_VERSION), browserVersion: z.string().min(1), viewport: ViewportSchema,
  sources: SourcePairSchema, labels: z.strictObject({ before: HumanTextSchema, after: HumanTextSchema }),
  scenarios: z.array(CapturedScenarioSchema).min(1).max(3), warnings: z.array(WarningSchema),
};
export const CaptureBundleSchema = z.discriminatedUnion('captureMode', [
  z.strictObject({ ...CaptureBundleFields, captureMode: z.literal('keyframes'), settings: z.strictObject({ fixedTime: z.iso.datetime().nullable() }) }),
  z.strictObject({ ...CaptureBundleFields, captureMode: z.literal('motion'), settings: z.strictObject({ fixedTime: z.iso.datetime().nullable(), maskRects: z.array(MaskRectSchema).max(20) }), motion: z.array(MotionScenarioSchema).min(1).max(3) }),
]).superRefine((bundle, context) => {
  if (new Set(bundle.scenarios.map((scenario) => scenario.id)).size !== bundle.scenarios.length) context.addIssue({ code: 'custom', message: 'Captured scenario IDs must be unique' });
  if (bundle.captureMode !== 'motion') return;
  if (bundle.motion.length !== bundle.scenarios.length || bundle.motion.some((scenario, i) => scenario.id !== bundle.scenarios[i]?.id || scenario.steps.some((step, j) => step.id !== bundle.scenarios[i]?.steps[j]?.id) || scenario.steps.length !== bundle.scenarios[i]?.steps.length)) context.addIssue({ code: 'custom', message: 'Motion and checkpoint scenarios and steps must match' });
  const frames = bundle.motion.flatMap((scenario) => [...scenario.tracks.before.frames, ...scenario.tracks.after.frames]);
  const artifacts = [...frames.map((frame) => frame.artifact), ...bundle.scenarios.flatMap((scenario) => scenario.steps.flatMap((step) => [step.before.image, step.after.image]))];
  const unique = new Map<string, Artifact>();
  for (const artifact of artifacts) {
    const prior = unique.get(artifact.path);
    if (prior && (prior.sha256 !== artifact.sha256 || prior.bytes !== artifact.bytes)) context.addIssue({ code: 'custom', message: 'One artifact path cannot have conflicting identities' });
    unique.set(artifact.path, artifact);
  }
  if (unique.size > 12000 || [...unique.values()].reduce((sum, artifact) => sum + artifact.bytes, 0) > 10 * 1024 ** 3) context.addIssue({ code: 'custom', message: 'Motion and checkpoint storage limit exceeded' });
  if (bundle.motion.some((motion, index) => [motion.tracks.before, motion.tracks.after].some((track) => track.status === 'failed') && bundle.scenarios[index]?.outcome !== 'partial')) context.addIssue({ code: 'custom', message: 'Capture track faults must remain partial' });
  if (frames.some((frame) => frame.width !== bundle.viewport.width || frame.height !== bundle.viewport.height)) context.addIssue({ code: 'custom', message: 'Motion dimensions must match the viewport' });
  if (bundle.settings.maskRects.some((rect) => rect.x + rect.width > bundle.viewport.width || rect.y + rect.height > bundle.viewport.height)) context.addIssue({ code: 'custom', message: 'Capture mask escapes viewport' });
});
export type CaptureBundle = z.infer<typeof CaptureBundleSchema>;
const SegmentCommon = { scenarioId: IdSchema, startFrame: z.number().int().nonnegative() };
export const SegmentSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...SegmentCommon, image: ArtifactPathSchema, kind: z.literal('title'), stepId: z.null(), durationFrames: z.literal(30) }),
  z.strictObject({ ...SegmentCommon, image: ArtifactPathSchema, kind: z.literal('step'), stepId: IdSchema, durationFrames: z.number().int().min(6).max(90) }),
  z.strictObject({ ...SegmentCommon, kind: z.literal('motion'), stepId: z.null(), durationFrames: z.number().int().min(1).max(1800), sourceStartMs: MillisecondsSchema, sourceEndMs: MillisecondsSchema }),
]);
export type TimelineSegment = z.infer<typeof SegmentSchema>;
export const FrameSelectionSchema = z.strictObject({ frame: z.number().int().nonnegative(), before: ArtifactPathSchema.nullable(), after: ArtifactPathSchema.nullable(), overlay: ArtifactPathSchema });
export const TimelineSchema = z.strictObject({
  schemaVersion: z.literal(2), runId: RunIdSchema, captureMode: z.enum(['motion', 'keyframes']), fps: z.literal(30), templateVersion: z.literal(2), width: z.literal(1920), height: z.literal(686),
  captureSha256: Sha256Schema,
  stepBoundaries: z.array(z.strictObject({ scenarioId: IdSchema, stepId: IdSchema, startFrame: z.number().int().nonnegative(), endFrame: z.number().int().nonnegative() })).max(36),
  annotations: z.array(z.strictObject({ scenarioId: IdSchema, stepId: IdSchema, side: SideSchema, kind: z.enum(['waiting', 'expected_absent', 'skipped_by_side', 'failed', 'blocked']), startFrame: z.number().int().nonnegative(), endFrame: z.number().int().nonnegative() })).max(432),
  posterSelection: z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('checkpoint'), scenarioId: IdSchema, stepId: IdSchema, changeRatio: z.number().min(0).max(1) }), z.strictObject({ kind: z.literal('incomplete'), reason: SafeTextSchema.min(1) })]),
  viewport: ViewportSchema, totalFrames: z.number().int().positive().max(5490), segments: z.array(SegmentSchema).min(1).max(39), poster: ArtifactPathSchema,
  images: z.array(ArtifactSchema).min(1).max(13000), selections: z.array(FrameSelectionSchema).max(5400),
}).superRefine((timeline, context) => {
  let end = 0;
  let currentScenario: string | null = null;
  let stepCount = 0;
  const scenarios = new Set<string>();
  const stepIds = new Set<string>();
  const paths = new Set(timeline.images.map((image) => image.path));
  const motionFrameNumbers = new Set<number>();
  for (const segment of timeline.segments) {
    if (segment.startFrame !== end) context.addIssue({ code: 'custom', message: 'Timeline boundaries must be cumulative' });
    if (segment.kind === 'title') {
      if (currentScenario !== null && stepCount === 0) context.addIssue({ code: 'custom', message: 'Every title requires content' });
      if (scenarios.has(segment.scenarioId)) context.addIssue({ code: 'custom', message: 'Titles require unique scenario IDs' });
      scenarios.add(segment.scenarioId); currentScenario = segment.scenarioId; stepCount = 0; stepIds.clear();
    } else {
      if (currentScenario === null || segment.scenarioId !== currentScenario) context.addIssue({ code: 'custom', message: 'Content must follow its scenario title' });
      if (segment.kind === 'step') {
        if (timeline.captureMode !== 'keyframes' || stepIds.has(segment.stepId)) context.addIssue({ code: 'custom', message: 'Keyframe step IDs must be unique and keyframe-only' });
        stepIds.add(segment.stepId);
      } else {
        if (timeline.captureMode !== 'motion' || stepCount !== 0 || segment.sourceEndMs <= segment.sourceStartMs || segment.durationFrames !== Math.ceil((segment.sourceEndMs - segment.sourceStartMs) * 30 / 1000)) context.addIssue({ code: 'custom', message: 'Motion scenario must retain its measured duration' });
        for (let frame = segment.startFrame; frame < segment.startFrame + segment.durationFrames; frame++) motionFrameNumbers.add(frame);
      }
      stepCount++;
      if (stepCount > 12) context.addIssue({ code: 'custom', message: 'At most twelve steps per scenario' });
    }
    if ('image' in segment && !paths.has(segment.image)) context.addIssue({ code: 'custom', message: 'Every rendered image needs a hash entry' });
    end += segment.durationFrames;
  }
  if (stepCount === 0 || scenarios.size > 3 || end !== timeline.totalFrames) context.addIssue({ code: 'custom', message: 'Timeline must have complete contiguous scenarios' });
  if (paths.size !== timeline.images.length || !paths.has(timeline.poster)) context.addIssue({ code: 'custom', message: 'Image identities must be unique and include the poster' });
  for (const boundary of [...timeline.stepBoundaries, ...timeline.annotations]) if (!scenarios.has(boundary.scenarioId) || boundary.startFrame > boundary.endFrame || boundary.endFrame > timeline.totalFrames) context.addIssue({ code: 'custom', message: 'Step and annotation boundaries must fit their timeline' });
  if (timeline.selections.length !== motionFrameNumbers.size || new Set(timeline.selections.map((selection) => selection.frame)).size !== timeline.selections.length) context.addIssue({ code: 'custom', message: 'Every motion output frame requires exactly one source selection' });
  for (const selection of timeline.selections) if (!motionFrameNumbers.has(selection.frame) || [selection.before, selection.after, selection.overlay].some((path) => path !== null && !paths.has(path))) context.addIssue({ code: 'custom', message: 'Selections must use hashed sanitized artifacts at motion frame indices' });
});
export type Timeline = z.infer<typeof TimelineSchema>;
export const OutcomeSchema = z.enum(['pending', 'ok', 'partial', 'failed']);
export const ProvenanceSideSchema = z.strictObject({ valid: z.boolean(), actualHash: Sha256Schema.nullable(), errors: z.array(ToolErrorSchema) });
export const ProvenanceSchema = z.strictObject({ before: ProvenanceSideSchema, after: ProvenanceSideSchema });
export type Provenance = z.infer<typeof ProvenanceSchema>;
export const CleanupOutcomeSchema = z.strictObject({ status: z.enum(['pending', 'ok', 'failed']), errors: z.array(ToolErrorSchema) });
export type CleanupOutcome = z.infer<typeof CleanupOutcomeSchema>;
export const ComparisonOutcomeSchema = z.strictObject({ status: OutcomeSchema, capture: OutcomeSchema, coverage: z.enum(['complete', 'explicit', 'incomplete']), provenance: ProvenanceSchema });
export const EncodingOutcomeSchema = z.strictObject({ status: z.enum(['pending', 'ok', 'failed']), errors: z.array(ToolErrorSchema) });
export const MediaSchema = z.strictObject({ video: ArtifactSchema, poster: ArtifactSchema, ffmpegVersion: z.string(), ffprobeVersion: z.string() });
export type Media = z.infer<typeof MediaSchema>;
export const ResultStatusSchema = z.enum(['ok', 'partial', 'failed', 'nothing', 'cancelled']);
export const RunStateSchema = z.enum(['validating', 'preparing', 'starting', 'recording', 'rendering', 'encoding', 'cleaning', 'terminal']);
export const SummarySchema = z.strictObject({ verifiedPairs: z.number().int().nonnegative(), changedPairs: z.number().int().nonnegative(), expectedAbsences: z.number().int().nonnegative(), exclusions: z.number().int().nonnegative(), failedSteps: z.number().int().nonnegative(), blockedSteps: z.number().int().nonnegative(), coverageOmissions: z.number().int().nonnegative() });
const RuntimeProvenanceFields = {
  state: z.enum(['stateless', 'isolated', 'external-read-only']), seedId: IdSchema.nullable(),
  dependencyReproducibility: z.enum(['declared', 'none', 'unverified']),
  services: z.array(z.strictObject({ id: IdSchema, kind: z.enum(['process', 'container']), identity: z.string().min(1), imageId: z.string().nullable() })).max(4),
};
export const RuntimeSideProvenanceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...RuntimeProvenanceFields, kind: z.literal('process'), buildArtifacts: z.literal('unverified') }),
  z.strictObject({ ...RuntimeProvenanceFields, kind: z.literal('container'), imageId: z.string().min(1), dockerfileSha256: Sha256Schema, baseImages: z.array(z.string()).max(64) }),
]);
export type RuntimeSideProvenance = z.infer<typeof RuntimeSideProvenanceSchema>;
export const ManifestSchema = z.strictObject({
  schemaVersion: z.literal(2), toolVersion: z.literal(TOOL_VERSION), runId: RunIdSchema, state: RunStateSchema, status: ResultStatusSchema, exitCode: z.number().int().min(0).max(255), captureMode: z.enum(['motion', 'keyframes']), specRevision: z.literal('0.3'),
  startedAt: z.iso.datetime(), endedAt: z.iso.datetime().nullable(), sources: z.strictObject({ before: SourceIdentitySchema, after: SourceIdentitySchema, baseResolution: z.enum(['exact', 'merge-base']) }),
  versions: z.strictObject({ node: z.string(), browser: z.string().nullable(), ffmpeg: z.string().nullable(), ffprobe: z.string().nullable() }),
  publicRecipeDigest: Sha256Schema.nullable(), publicScenarioDigest: Sha256Schema.nullable(), viewport: ViewportSchema, dataParity: z.enum(['stateless-declared', 'isolated-declared', 'external-unverified']), coverage: CoverageSchema,
  execution: z.strictObject({ before: RuntimeSideProvenanceSchema, after: RuntimeSideProvenanceSchema }).nullable(),
  captureQuality: z.array(z.strictObject({ scenarioId: IdSchema, side: SideSchema, stats: TrackStatsSchema, clockErrorBoundMs: MillisecondsSchema.nullable(), maxDriftMs: MillisecondsSchema.nullable(), failureAtMs: MillisecondsSchema.nullable() })).max(6),
  scenarios: z.array(CapturedScenarioSchema), summary: SummarySchema,
  timeline: z.strictObject({ fps: z.literal(30), totalFrames: z.number().int().positive(), templateVersion: z.literal(2), width: z.literal(1920), height: z.literal(686) }).nullable(),
  artifacts: z.strictObject({ video: ArtifactSchema.nullable(), poster: ArtifactSchema.nullable(), capture: ArtifactSchema.nullable(), timeline: ArtifactSchema.nullable(), pr: ArtifactSchema.nullable() }),
  comparisonOutcome: ComparisonOutcomeSchema, cleanupOutcome: CleanupOutcomeSchema, encodingOutcome: EncodingOutcomeSchema,
  warnings: z.array(WarningSchema), errors: z.array(ToolErrorSchema), errorHistory: z.array(ToolErrorSchema), phaseTimings: z.partialRecord(RunStateSchema, MillisecondsSchema),
});
export type Manifest = z.infer<typeof ManifestSchema>;
export const CapabilitySchema = z.strictObject({ name: z.string(), available: z.boolean(), version: z.string().nullable(), message: z.string(), setupCommand: z.string().nullable() });
export const DoctorReportSchema = z.strictObject({ schemaVersion: z.literal(2), platform: z.string(), capabilities: z.array(CapabilitySchema), abandonedRuns: z.array(z.strictObject({ runId: z.string(), state: z.string(), hint: z.string() })) });
export type DoctorReport = z.infer<typeof DoctorReportSchema>;
export const CleanReportSchema = z.strictObject({ schemaVersion: z.literal(2), runId: RunIdSchema, removed: z.boolean() });
export type CleanReport = z.infer<typeof CleanReportSchema>;
export function resultSchema<T extends z.ZodType>(dataSchema: T) {
  return z.strictObject({ schemaVersion: z.literal(2), command: z.enum(['plan', 'compare', 'compose', 'doctor', 'clean']), status: ResultStatusSchema, exitCode: z.number().int().min(0).max(255), data: dataSchema.nullable(), error: ToolErrorSchema.nullable(), warnings: z.array(WarningSchema) });
}
export const ResultSchema = resultSchema(z.union([PlanSchema, ManifestSchema, DoctorReportSchema, CleanReportSchema]));
export type Result<T> = Omit<z.infer<typeof ResultSchema>, 'data'> & { data: T | null };
export function parseConfig(value: unknown): Config {
  return ConfigSchema.parse(value);
}
export function parseScenario(value: unknown): Scenario {
  if (typeof value !== 'object' || value === null) return ScenarioSchema.parse(value);
  const copy = { ...value };
  if ('title' in copy && typeof copy.title === 'string') copy.title = sanitizeText(copy.title);
  if ('steps' in copy && Array.isArray(copy.steps)) copy.steps = copy.steps.map((step: unknown) => {
    if (typeof step !== 'object' || step === null || !('note' in step) || typeof step.note !== 'string') return step;
    return { ...step, note: sanitizeText(step.note) };
  });
  return ScenarioSchema.parse(copy);
}
export const DOCUMENT_SCHEMAS = { config: ConfigSchema, scenario: ScenarioSchema, plan: PlanSchema, capture: CaptureBundleSchema, timeline: TimelineSchema, manifest: ManifestSchema, result: ResultSchema };
