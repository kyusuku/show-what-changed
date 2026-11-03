import type { CaptureBundle, CleanupOutcome, Manifest, Plan, Provenance, Result, ToolError } from '../schema/index.js';
import type { ToolFailure } from '../schema/errors.js';
import { failure } from '../schema/errors.js';
import { digest } from '../schema/io.js';

export function summarize(bundle: Pick<CaptureBundle, 'scenarios'> | null, coverage: Plan['coverage']): Manifest['summary'] {
  const summary = { verifiedPairs: 0, changedPairs: 0, expectedAbsences: 0, exclusions: 0, failedSteps: 0, blockedSteps: 0, coverageOmissions: coverage.unresolved.length + coverage.omitted.length + coverage.unsupported.length };
  for (const scenario of bundle?.scenarios ?? []) for (const step of scenario.steps) {
    if (step.changeRatio !== null) { summary.verifiedPairs++; if (step.changeRatio >= 0.001) summary.changedPairs++; }
    for (const side of [step.before, step.after]) {
      if (side.status === 'expected_absent') summary.expectedAbsences++;
      if (side.status === 'skipped_by_side') summary.exclusions++;
      if (side.status === 'failed') summary.failedSteps++;
      if (side.status === 'blocked') summary.blockedSteps++;
    }
  }
  return summary;
}
export function comparisonOutcome(bundle: Pick<CaptureBundle, 'scenarios'>, coverage: Plan['coverage'], provenance: Provenance): Manifest['comparisonOutcome'] {
  const capture = bundle.scenarios.some((scenario) => scenario.outcome === 'partial') ? 'partial' : 'ok';
  const coverageState = coverage.selected.some((route) => route.reason === 'EXPLICIT_SELECTION') ? 'explicit' : coverage.complete ? 'complete' : 'incomplete';
  return { status: capture === 'partial' || coverageState === 'incomplete' || !provenance.before.valid || !provenance.after.valid ? 'partial' : 'ok', capture, coverage: coverageState, provenance };
}
export function validateCompletedComparison(manifest: Pick<Manifest, 'scenarios' | 'summary' | 'comparisonOutcome' | 'coverage' | 'cleanupOutcome' | 'encodingOutcome'>): void {
  const expected = comparisonOutcome(manifest, manifest.coverage, manifest.comparisonOutcome.provenance);
  const valid = manifest.scenarios.length >= 1 && manifest.scenarios.length <= 3
    && new Set(manifest.scenarios.map((scenario) => scenario.id)).size === manifest.scenarios.length
    && digest(expected) === digest(manifest.comparisonOutcome)
    && digest(summarize(manifest, manifest.coverage)) === digest(manifest.summary)
    && !(manifest.cleanupOutcome.status === 'ok' && manifest.cleanupOutcome.errors.length)
    && !(manifest.encodingOutcome.status === 'ok' && manifest.encodingOutcome.errors.length);
  if (!valid) throw failure(2, 'INCONSISTENT_MANIFEST', 'validating', 'The saved manifest outcomes do not match its captured steps and coverage.', 'Restore the original manifest or create a new comparison.');
}
export function captureErrors(bundle: CaptureBundle): ToolError[] {
  return bundle.scenarios.flatMap((scenario) => [...scenario.errors, ...scenario.steps.flatMap((step) => (['before', 'after'] as const).flatMap((side) => step[side].status === 'failed' ? [{ code: step[side].reasonCode ?? 'STEP_FAILED', phase: 'recording', side, stepId: step.id, message: `A required ${side.toUpperCase()} step failed.`, hint: 'Inspect the masked frames and correct the app or scenario. Do not make a required failure optional to pass.' }] : []))]);
}
export function reduceOutcome(input: {
  comparison: Manifest['comparisonOutcome']; encoding: Manifest['encodingOutcome']; cleanup: CleanupOutcome;
  fatal: ToolFailure | null; cancelled: ToolFailure | null; errors: readonly ToolError[];
}): Pick<Result<unknown>, 'status' | 'exitCode' | 'error'> {
  if (input.cancelled) return { status: 'cancelled', exitCode: input.cancelled.exitCode, error: input.cancelled.detail };
  if (input.fatal) return { status: input.fatal.exitCode === 4 ? 'nothing' : 'failed', exitCode: input.fatal.exitCode, error: input.fatal.detail };
  if (input.encoding.status !== 'ok' || input.comparison.status === 'pending' || input.comparison.status === 'failed' || input.cleanup.status === 'pending') return {
    status: 'failed', exitCode: 1, error: { code: 'INCOMPLETE_RUN', phase: 'terminal', message: 'Required run outcomes are incomplete.', hint: 'Inspect this run with doctor and rerun the comparison.' },
  };
  if (input.comparison.status === 'partial' || input.cleanup.status === 'failed') return { status: 'partial', exitCode: 3, error: input.errors[0] ?? input.cleanup.errors[0] ?? null };
  return { status: 'ok', exitCode: 0, error: null };
}
