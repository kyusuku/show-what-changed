import { ManifestSchema, TOOL_VERSION } from '../schema/index.js';
import type { Manifest, Plan } from '../schema/index.js';
import type { RunContext } from '../schema/contracts.js';
import { sanitizeText } from '../schema/io.js';
import { artifactInfo, writeRunFile } from '../runtime/files.js';
import { summarize } from './outcomes.js';
import { publicError, publicRecipeDigest, publicRoute, publicScenarioDigest, publicWarning } from '../schema/public.js';

function shortText(value: string): string { return [...sanitizeText(value)].slice(0, 160).join(''); }
export function initialManifest(plan: Plan, run: RunContext): Manifest {
  const pending = () => ({ valid: false, actualHash: null, errors: [] });
  return ManifestSchema.parse({
    schemaVersion: 2, specRevision: '0.3', toolVersion: TOOL_VERSION, runId: run.runId, state: 'validating', status: 'failed', exitCode: 1, captureMode: plan.config.capture.mode, startedAt: run.startedAt, endedAt: null,
    sources: {
      before: { requested: shortText(plan.requestedBase), commit: plan.baseCommit, kind: 'commit', materializedHash: null },
      after: { requested: shortText(plan.requestedHead), commit: plan.headCommit, kind: plan.headKind, materializedHash: null }, baseResolution: plan.baseResolution,
    },
    versions: { node: process.version, browser: null, ffmpeg: null, ffprobe: null }, publicRecipeDigest: publicRecipeDigest(plan.config), publicScenarioDigest: publicScenarioDigest(plan.scenarios), viewport: { ...plan.config.capture.viewport, deviceScaleFactor: 1 }, dataParity: plan.config.execution.state.kind === 'stateless' ? 'stateless-declared' : plan.config.execution.state.kind === 'isolated' ? 'isolated-declared' : 'external-unverified', coverage: { ...plan.coverage, selected: plan.coverage.selected.map((candidate) => ({ ...candidate, path: publicRoute(candidate.path), via: [] })), unresolved: plan.coverage.unresolved.map((candidate) => ({ ...candidate, path: publicRoute(candidate.path), via: [] })), omitted: plan.coverage.omitted.map((candidate) => ({ ...candidate, path: publicRoute(candidate.path), via: [] })), unsupported: plan.coverage.unsupported.map((candidate) => ({ ...candidate, path: publicRoute(candidate.path), via: [] })) },
    execution: null, captureQuality: [], scenarios: [], summary: summarize(null, plan.coverage), timeline: null,
    artifacts: { video: null, poster: null, capture: null, timeline: null, pr: null },
    comparisonOutcome: { status: 'pending', capture: 'pending', coverage: plan.coverage.selected.some((route) => route.reason === 'EXPLICIT_SELECTION') ? 'explicit' : plan.coverage.complete ? 'complete' : 'incomplete', provenance: { before: pending(), after: pending() } },
    cleanupOutcome: { status: 'pending', errors: [] }, encodingOutcome: { status: 'pending', errors: [] }, warnings: plan.warnings, errors: [], errorHistory: [], phaseTimings: {},
  });
}
export async function persistManifest(run: RunContext, manifest: Manifest): Promise<void> {
  manifest.errors = manifest.errors.map(publicError);
  manifest.errorHistory = manifest.errorHistory.map(publicError);
  manifest.warnings = manifest.warnings.map(publicWarning);
  manifest.cleanupOutcome.errors = manifest.cleanupOutcome.errors.map(publicError);
  manifest.encodingOutcome.errors = manifest.encodingOutcome.errors.map(publicError);
  manifest.comparisonOutcome.provenance.before.errors = manifest.comparisonOutcome.provenance.before.errors.map(publicError);
  manifest.comparisonOutcome.provenance.after.errors = manifest.comparisonOutcome.provenance.after.errors.map(publicError);
  await writeRunFile(run, 'manifest.json', JSON.stringify(ManifestSchema.parse(manifest), null, 2) + '\n');
}
export async function writePublicArtifacts(run: RunContext, manifest: Manifest): Promise<void> {
  const root = `.show-what-changed/runs/${manifest.runId}`;
  const lines = [
    '# UI comparison', '', `Status: ${manifest.status}. Exit code: ${manifest.exitCode}.`, '',
    manifest.captureMode === 'motion' ? 'This records actual browser motion at original speed. It is not an application performance benchmark.' : 'This is an explicit keyframe replay with held checkpoints.', '',
    `State declaration: ${manifest.dataParity}. Source identity does not prove backend data or generated host-build parity.`, '',
    `BEFORE: ${manifest.sources.before.commit}.`, `AFTER: ${manifest.sources.after.commit}${manifest.sources.after.kind === 'worktree' ? ' plus a filesystem snapshot' : ''}.`, '',
    `Verified pairs: ${manifest.summary.verifiedPairs}. Visually changed pairs: ${manifest.summary.changedPairs}.`,
    `Expected absences: ${manifest.summary.expectedAbsences}. Side exclusions: ${manifest.summary.exclusions}.`,
    `Failed side steps: ${manifest.summary.failedSteps}. Blocked side steps: ${manifest.summary.blockedSteps}. Coverage gaps: ${manifest.summary.coverageOmissions}.`, '',
    `Coverage: ${manifest.comparisonOutcome.coverage}. Cleanup: ${manifest.cleanupOutcome.status}.`, '',
  ];
  if (manifest.artifacts.video) lines.push(`Local video: \`${root}/${manifest.artifacts.video.path}\`.`, '');
  if (manifest.artifacts.poster) lines.push(`Local poster: \`${root}/${manifest.artifacts.poster.path}\`.`, '');
  lines.push('Review the video, poster and manifest before attaching them manually to a pull request. These are local paths, not uploaded or playable remote URLs. Do not share the private plan or process logs.', '');
  await writeRunFile(run, 'pr.md', lines.join('\n'));
  manifest.artifacts.pr = await artifactInfo(run.paths.runDir, 'pr.md');
  await persistManifest(run, manifest);
}
