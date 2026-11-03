import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { chromium } from 'playwright';
import { z } from 'zod';
import { loadSavedPlan, plan, validateSavedPlan } from '../planner/index.js';
import { prepare, verify } from '../workspace/index.js';
import { start } from '../runtime/index.js';
import { lsofCapability, LSOF_SETUP } from '../runtime/lsof.js';
import { cleanupRun, createRunContext, releaseRunOwnership, reopenRunContext } from '../runtime/context.js';
import { artifactInfo, readRunFile, writeRunFile } from '../runtime/files.js';
import { capture } from '../recorder/index.js';
import { checkMediaCapabilities, encode, presentationWarnings, render, validateTimelineCapture } from '../composer/index.js';
import { CaptureBundleSchema, MAX_METADATA_BYTES, ManifestSchema, TimelineSchema } from '../schema/index.js';
import type { CaptureBundle, Manifest, Plan, Result } from '../schema/index.js';
import type { CleanupOutcome, CommandContext, CompareRequest, RunContext, WorkspacePair } from '../schema/contracts.js';
import { cancellation, checkCancelled, failure, ToolFailure } from '../schema/errors.js';
import { comparisonOutcome, captureErrors, reduceOutcome, summarize, validateCompletedComparison } from './outcomes.js';
import { digest, sha256 } from '../schema/io.js';
import { publicError } from '../schema/public.js';
import { initialManifest, persistManifest, writePublicArtifacts } from './artifacts.js';

export function normalizeFailure(error: unknown, phase: string): ToolFailure {
  if (error instanceof ToolFailure) return error;
  if (error instanceof z.ZodError) return failure(phase === 'validating' ? 2 : 9, 'INVALID_DOCUMENT', phase, 'A document failed its versioned validation.', 'Regenerate the input or inspect the retained run artifacts.');
  if (phase === 'validating' && (error instanceof SyntaxError || error instanceof Error && 'code' in error && ['ENOENT', 'ENOTDIR', 'EISDIR', 'ELOOP', 'EACCES'].includes(String(error.code)))) return failure(2, 'INVALID_INPUT', phase, 'An input path or JSON document is missing, unreadable, or invalid.', 'Provide an intact regular input file or an owned run directory.');
  return failure(1, 'INTERNAL_ERROR', phase, 'An unexpected internal error interrupted the command.', 'Keep the run ID and report this failure without sharing private logs or plans.');
}
async function finishCleanup(run: RunContext): Promise<CleanupOutcome> {
  try { return await cleanupRun(run); }
  catch { return { status: 'failed', errors: [{ code: 'CLEANUP_FAILED', phase: 'cleanup', message: 'Owned resource cleanup did not complete.', hint: 'Inspect the retained run and remaining resources with doctor.' }] }; }
}
export function failureResult<T>(command: Result<T>['command'], error: ToolFailure): Result<T> {
  return { schemaVersion: 2, command, status: [10, 130, 143].includes(error.exitCode) ? 'cancelled' : error.exitCode === 4 ? 'nothing' : 'failed', exitCode: error.exitCode, data: null, error: publicError(error.detail), warnings: [] };
}
function deadline(context: CommandContext): { signal: AbortSignal; remaining: () => number; close: () => void } {
  const controller = new AbortController();
  const deadlineMs = performance.now() + context.timeoutMs;
  const timer = setTimeout(() => controller.abort(failure(10, 'DEADLINE_EXCEEDED', 'execution', 'The overall command deadline was reached.', 'Use a longer bounded timeout or simplify the scenario.')), context.timeoutMs);
  timer.unref();
  return { signal: AbortSignal.any([context.signal, controller.signal]), remaining: () => Math.max(1, deadlineMs - performance.now()), close: () => clearTimeout(timer) };
}
async function executionConsent(plan: Plan, context: CommandContext): Promise<void> {
  if (context.consent.kind === 'allow-exec') return;
  if (context.consent.kind === 'interactive' && await context.consent.confirm(plan, context.signal)) return;
  throw failure(7, 'EXECUTION_CONSENT_REQUIRED', 'consent', 'This comparison needs permission to execute the declared setup, services, application, and bootstrap commands.', 'Review the plan, then rerun with --allow-exec for this invocation.');
}
async function compareCapabilities(run: RunContext): Promise<void> {
  if (!/^v24\./.test(process.version)) throw failure(8, 'NODE_VERSION_UNSUPPORTED', 'capabilities', 'This release requires Node 24.x.', 'Use Node 24, then run doctor.');
  for (const argv of [['lsof', '-v'], ['ps', '-p', String(process.pid), '-o', 'pid=']]) {
    const child = await run.supervisor.spawn({ argv, cwd: run.paths.runDir, purpose: 'probe', captureStdout: true, timeoutMs: 10000 });
    const result = await child.exited;
    checkCancelled(run.signal);
    if (result.code !== 0 || result.spawnError) throw failure(8, 'PROCESS_CAPABILITY_UNAVAILABLE', 'capabilities', 'lsof or ps is unavailable.', 'Install the documented system prerequisites, then run doctor.');
    if (argv[0] === 'lsof') {
      const output = child.output();
      if (!lsofCapability(`${output.stdout}\n${output.stderr}`).supported) throw failure(8, 'LSOF_VERSION_UNSUPPORTED', 'capabilities', 'Linux requires lsof 4.99.7 or newer for reliable listener ownership checks.', LSOF_SETUP);
    }
  }
  try {
    await access(chromium.executablePath(), constants.X_OK);
    const font = await readFile(new URL('../../assets/fonts/Inter-Regular.woff2', import.meta.url));
    if (font.subarray(0, 4).toString('ascii') !== 'wOF2') throw new Error('Invalid font asset');
  } catch { throw failure(8, 'CAPTURE_CAPABILITY_UNAVAILABLE', 'capabilities', 'The pinned Chromium or bundled font is unavailable.', 'Run doctor. Install Chromium with npx playwright@1.64.1 install chromium or reinstall the package.'); }
  await checkMediaCapabilities(run);
}
function uniqueErrors(errors: Manifest['errors']): Manifest['errors'] {
  const seen = new Set<string>();
  return errors.filter((error) => { const key = JSON.stringify(error); if (seen.has(key)) return false; seen.add(key); return true; });
}
async function finalize(run: RunContext, manifest: Manifest, command: 'compare' | 'compose', fatal: ToolFailure | null, signal: AbortSignal): Promise<Result<Manifest>> {
  let stopped = cancellation(signal) ?? cancellation(run.signal);
  const outputFailure = failure(9, 'OUTPUT_WRITE_FAILED', 'terminal', 'The final public artifacts could not be written.', 'Inspect output permissions and retained run files.');
  const decide = () => {
    stopped ??= cancellation(signal) ?? cancellation(run.signal);
    manifest.errors = uniqueErrors([...manifest.errors, ...manifest.cleanupOutcome.errors, ...(fatal ? [fatal.detail] : []), ...(stopped ? [stopped.detail] : [])].map(publicError));
    const decision = reduceOutcome({ comparison: manifest.comparisonOutcome, encoding: manifest.encodingOutcome, cleanup: manifest.cleanupOutcome, fatal, cancelled: stopped, errors: manifest.errors });
    manifest.status = decision.status; manifest.exitCode = decision.exitCode;
    return { ...decision, error: decision.error ? publicError(decision.error) : null };
  };
  Object.assign(manifest, { state: 'terminal', endedAt: new Date().toISOString() });
  const terminal: { persistence: 'pending' | 'committed' | 'failed' } = { persistence: 'pending' };
  const persistTerminal = async (release?: () => void): Promise<void> => {
    terminal.persistence = 'pending';
    for (let attempt = 0; attempt < 3; attempt++) {
      decide();
      const writtenCancellation = stopped;
      try { await writePublicArtifacts(run, manifest); }
      catch (error) {
        fatal ??= outputFailure;
        manifest.errors = uniqueErrors([...manifest.errors, outputFailure.detail, ...(error instanceof ToolFailure ? [error.detail] : [])]);
        continue;
      }
      decide();
      if (stopped !== writtenCancellation) continue;
      terminal.persistence = 'committed';
      release?.();
      return;
    }
    terminal.persistence = 'failed';
    decide();
    throw outputFailure;
  };
  const released = await releaseRunOwnership(run, persistTerminal);
  if (released.status !== 'ok') {
    manifest.cleanupOutcome = { status: 'failed', errors: uniqueErrors([...manifest.cleanupOutcome.errors, ...released.errors]) };
    manifest.errors = uniqueErrors([...manifest.errors, ...released.errors]);
    if (released.ownership === 'uncertain') return { schemaVersion: 2, command, ...decide(), data: null, warnings: [...manifest.warnings, { code: 'OWNERSHIP_UNCERTAIN', message: 'Terminal metadata could not be updated because run ownership became uncertain. Inspect the run manually.' }] };
    if (terminal.persistence !== 'failed') await persistTerminal().catch(() => {});
  }
  const decision = decide();
  if (terminal.persistence !== 'committed') return { schemaVersion: 2, command, ...decision, data: null, warnings: [...manifest.warnings, { code: 'OUTPUT_WRITE_FAILED', message: `Terminal artifacts for run ${run.runId} could not be committed. The repository lock is retained, and saved files may show an earlier result. Inspect the run manually.` }] };
  return { schemaVersion: 2, command, ...decision, data: ManifestSchema.parse(manifest), warnings: manifest.warnings };
}
export async function compare(request: CompareRequest, context: CommandContext): Promise<Result<Manifest>> {
  const clock = deadline(context);
  let run: RunContext | undefined;
  let manifest: Manifest | undefined;
  let workspaces: WorkspacePair | undefined;
  let bundle: CaptureBundle | null = null;
  let fatal: ToolFailure | null = null;
  let phase = 'validating';
  let phaseStarted = performance.now();
  try {
    checkCancelled(clock.signal);
    const selected = request.kind === 'saved' ? await loadSavedPlan(request.path, context.invocationDir, clock.signal) : await plan(request.request, clock.signal);
    await executionConsent(selected, { ...context, signal: clock.signal });
    checkCancelled(clock.signal);
    run = await createRunContext({ repoRoot: selected.repoRoot, timeoutMs: clock.remaining(), signal: clock.signal, diagnostics: context.diagnostics, retainOwnership: true });
    run.redactions.add(selected.scenarios.flatMap((scenario) => scenario.steps.flatMap((step) => step.op === 'fill' ? [step.value] : [])));
    manifest = initialManifest(selected, run);
    await writeRunFile(run, 'private/plan.json', JSON.stringify(selected, null, 2) + '\n');
    await persistManifest(run, manifest);
    const enter = async (next: Manifest['state']): Promise<void> => {
      checkCancelled(clock.signal);
      if (manifest && run) {
        manifest.phaseTimings[manifest.state] = (manifest.phaseTimings[manifest.state] ?? 0) + performance.now() - phaseStarted;
        phaseStarted = performance.now(); phase = next; manifest.state = next;
        await persistManifest(run, manifest);
      }
    };
    await validateSavedPlan(selected, context.invocationDir, clock.signal);
    await compareCapabilities(run);
    await enter('preparing');
    workspaces = await prepare(selected, run);
    manifest.sources.before.materializedHash = workspaces.before.materializedHash;
    manifest.sources.after.materializedHash = workspaces.after.materializedHash;
    await enter('starting');
    const runtime = await start(workspaces, selected, run);
    manifest.execution = runtime.provenance;
    const preparedProvenance = await verify(workspaces, run);
    manifest.comparisonOutcome.provenance = preparedProvenance;
    if (!preparedProvenance.before.valid || !preparedProvenance.after.valid) throw failure(5, 'SOURCE_MUTATED', 'preparing', 'Setup or bootstrap changed source inputs.', 'Correct the recipe or generated-directory declaration and recreate the comparison.');
    await enter('recording');
    bundle = await capture(runtime.servers, selected.scenarios, selected.config.capture, run);
    const provenance = await verify(workspaces, run);
    manifest.comparisonOutcome = comparisonOutcome(bundle, selected.coverage, provenance);
    manifest.scenarios = bundle.scenarios; manifest.versions.browser = bundle.browserVersion;
    manifest.captureQuality = bundle.captureMode === 'motion' ? bundle.motion.flatMap((scenario) => (['before', 'after'] as const).map((side) => ({ scenarioId: scenario.id, side, stats: scenario.tracks[side].stats, clockErrorBoundMs: scenario.tracks[side].clock?.errorBoundMs ?? null, maxDriftMs: scenario.tracks[side].clock?.maxDriftMs ?? null, failureAtMs: scenario.tracks[side].status === 'failed' ? scenario.tracks[side].failureAtMs : null }))) : [];
    manifest.summary = summarize(bundle, selected.coverage);
    manifest.errors.push(...captureErrors(bundle), ...provenance.before.errors, ...provenance.after.errors);
    manifest.warnings.push(...bundle.warnings);
    manifest.artifacts.capture = await artifactInfo(run.paths.runDir, 'capture.json');
    const settings = { coverage: selected.coverage, provenance };
    manifest.warnings.push(...presentationWarnings(bundle, settings));
    await enter('rendering');
    const timeline = await render(bundle, settings, run);
    validateTimelineCapture(timeline, bundle);
    manifest.timeline = { fps: 30, totalFrames: timeline.totalFrames, templateVersion: 2, width: 1920, height: 686 };
    manifest.artifacts.timeline = await artifactInfo(run.paths.runDir, 'timeline.json');
    manifest.artifacts.poster = await artifactInfo(run.paths.runDir, 'poster.png');
    await enter('encoding');
    const media = await encode(timeline, run);
    manifest.artifacts.video = media.video; manifest.artifacts.poster = media.poster;
    manifest.versions.ffmpeg = media.ffmpegVersion; manifest.versions.ffprobe = media.ffprobeVersion;
    manifest.encodingOutcome = { status: 'ok', errors: [] };
  } catch (error) {
    fatal = cancellation(clock.signal) ?? normalizeFailure(error, phase);
    if (manifest && phase === 'encoding') manifest.encodingOutcome = { status: 'failed', errors: [fatal.detail] };
    if (manifest && workspaces && run && !bundle) {
      manifest.comparisonOutcome.provenance = await verify(workspaces, run);
      manifest.comparisonOutcome.status = 'failed'; manifest.comparisonOutcome.capture = 'failed';
    }
  } finally {
    if (run && manifest) {
      manifest.phaseTimings[manifest.state] = (manifest.phaseTimings[manifest.state] ?? 0) + performance.now() - phaseStarted;
      phaseStarted = performance.now(); manifest.state = 'cleaning';
      await persistManifest(run, manifest).catch(() => {});
      manifest.cleanupOutcome = await finishCleanup(run);
      manifest.phaseTimings.cleaning = performance.now() - phaseStarted;
    } else if (run) await finishCleanup(run);
  }
  try {
    if (run && manifest) return await finalize(run, manifest, 'compare', fatal, clock.signal);
    if (run) await releaseRunOwnership(run, async (release) => release());
    return failureResult('compare', cancellation(clock.signal) ?? fatal ?? failure(1, 'INTERNAL_ERROR', 'validating', 'No run outcome was produced.', 'Report this failure.'));
  } finally { clock.close(); }
}
export async function compose(runDir: string, context: CommandContext): Promise<Result<Manifest>> {
  const clock = deadline(context);
  let run: RunContext | undefined;
  let manifest: Manifest | undefined;
  let fatal: ToolFailure | null = null;
  try {
    run = await reopenRunContext({ runDir, timeoutMs: clock.remaining(), signal: clock.signal, diagnostics: context.diagnostics, retainOwnership: true });
    const candidate = ManifestSchema.parse(JSON.parse((await readRunFile(run.paths.runDir, 'manifest.json', MAX_METADATA_BYTES)).toString('utf8')));
    const timelineBytes = await readRunFile(run.paths.runDir, 'timeline.json', MAX_METADATA_BYTES);
    const timeline = TimelineSchema.parse(JSON.parse(timelineBytes.toString('utf8')));
    if (candidate.runId !== run.runId || timeline.runId !== run.runId || !['ok', 'partial'].includes(candidate.comparisonOutcome.status)) throw failure(2, 'INVALID_RUN', 'validating', 'This run has no completed comparison to re-encode.', 'Create a complete composed timeline with compare first.');
    validateCompletedComparison(candidate);
    const captureBytes = await readRunFile(run.paths.runDir, 'capture.json', MAX_METADATA_BYTES);
    const savedCapture = CaptureBundleSchema.parse(JSON.parse(captureBytes.toString('utf8')));
    if (candidate.artifacts.capture?.path !== 'capture.json' || candidate.artifacts.capture.sha256 !== sha256(captureBytes) || candidate.artifacts.capture.bytes !== captureBytes.length || savedCapture.runId !== run.runId || savedCapture.captureMode !== candidate.captureMode || digest(savedCapture.scenarios) !== digest(candidate.scenarios) || digest(savedCapture.sources) !== digest({ before: candidate.sources.before, after: candidate.sources.after })) throw failure(9, 'CAPTURE_HASH_MISMATCH', 'encoding', 'Saved capture identity or outcomes do not match this run.', 'Restore the original capture and manifest or create a new comparison.');
    validateTimelineCapture(timeline, savedCapture);
    if (candidate.artifacts.timeline?.path !== 'timeline.json' || candidate.artifacts.timeline.bytes !== timelineBytes.length || candidate.artifacts.timeline.sha256 !== sha256(timelineBytes)
      || digest(candidate.timeline) !== digest({ fps: timeline.fps, totalFrames: timeline.totalFrames, templateVersion: timeline.templateVersion, width: timeline.width, height: timeline.height })) throw failure(9, 'TIMELINE_HASH_MISMATCH', 'encoding', 'The saved timeline does not match its manifest.', 'Restore the original timeline and manifest or create a new comparison.');
    manifest = candidate;
    manifest.errorHistory = uniqueErrors([...manifest.errorHistory, ...manifest.encodingOutcome.errors]);
    const oldEncodingErrors = new Set(manifest.encodingOutcome.errors.map((error) => JSON.stringify(error)));
    manifest.errors = manifest.errors.filter((error) => !oldEncodingErrors.has(JSON.stringify(error)));
    manifest.state = 'encoding'; manifest.encodingOutcome = { status: 'pending', errors: [] };
    await persistManifest(run, manifest);
    const media = await encode(timeline, run);
    manifest.artifacts.video = media.video; manifest.artifacts.poster = media.poster;
    manifest.artifacts.timeline = await artifactInfo(run.paths.runDir, 'timeline.json');
    manifest.versions.ffmpeg = media.ffmpegVersion; manifest.versions.ffprobe = media.ffprobeVersion;
    manifest.encodingOutcome = { status: 'ok', errors: [] };
  } catch (error) {
    fatal = cancellation(clock.signal) ?? normalizeFailure(error, manifest ? 'encoding' : 'validating');
    if (manifest) manifest.encodingOutcome = { status: 'failed', errors: [fatal.detail] };
  } finally {
    if (run) {
      const cleanup = await finishCleanup(run);
      if (manifest && cleanup.status !== 'ok') manifest.cleanupOutcome = { status: 'failed', errors: uniqueErrors([...manifest.cleanupOutcome.errors, ...cleanup.errors]) };
    }
  }
  try {
    if (run && manifest) return await finalize(run, manifest, 'compose', fatal, clock.signal);
    if (run) await releaseRunOwnership(run, async (release) => release());
    return failureResult('compose', cancellation(clock.signal) ?? fatal ?? failure(1, 'INTERNAL_ERROR', 'compose', 'No composition outcome was produced.', 'Report this failure.'));
  } finally { clock.close(); }
}
