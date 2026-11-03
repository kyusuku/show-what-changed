import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { CaptureBundleSchema } from '../../src/schema/index.js';
import type { Manifest } from '../../src/schema/index.js';
import { failure } from '../../src/schema/errors.js';
import { comparisonOutcome, reduceOutcome, summarize, validateCompletedComparison } from '../../src/runner/outcomes.js';
const provenance = { before: { valid: true, actualHash: 'a'.repeat(64), errors: [] }, after: { valid: true, actualHash: 'b'.repeat(64), errors: [] } };
const comparison: Manifest['comparisonOutcome'] = { status: 'ok', capture: 'ok', coverage: 'explicit', provenance };
const valid = { comparison, encoding: { status: 'ok' as const, errors: [] }, cleanup: { status: 'ok' as const, errors: [] }, fatal: null, cancelled: null, errors: [] };

describe('T07 and T14 outcome precedence', () => {
  it('allows explicit bounded selection to succeed', () => expect(reduceOutcome(valid)).toMatchObject({ status: 'ok', exitCode: 0 }));
  it('preserves comparison partial after successful encoding', () => expect(reduceOutcome({ ...valid, comparison: { ...comparison, status: 'partial', capture: 'partial' } })).toMatchObject({ status: 'partial', exitCode: 3 }));
  it('does not clear cleanup failure after re-encoding', () => expect(reduceOutcome({ ...valid, cleanup: { status: 'failed', errors: [] } })).toMatchObject({ status: 'partial', exitCode: 3 }));
  it('gives fatal encode failure priority over partial', () => expect(reduceOutcome({ ...valid, comparison: { ...comparison, status: 'partial' }, fatal: failure(9, 'ENCODE_FAILED', 'encoding', 'Encoding failed.', 'Retry compose.') })).toMatchObject({ status: 'failed', exitCode: 9 }));
  it('gives cancellation before terminal priority over earlier failure', () => expect(reduceOutcome({ ...valid, fatal: failure(9, 'ENCODE_FAILED', 'encoding', 'Encoding failed.', 'Retry compose.'), cancelled: failure(130, 'SIGINT', 'execution', 'Interrupted.', 'Retry.') })).toMatchObject({ status: 'cancelled', exitCode: 130 }));
  it.each([
    [130, 'SIGINT'],
    [143, 'SIGTERM'],
    [10, 'DEADLINE_EXCEEDED'],
  ] as const)('recipe setup failure retains cancellation exit %i', (exitCode, code) => {
    expect(reduceOutcome({ ...valid, fatal: failure(5, 'SETUP_FAILED', 'starting', 'Setup failed.', 'Correct the recipe.'), cancelled: failure(exitCode, code, 'execution', 'Cancelled.', 'Retry.') })).toMatchObject({ status: 'cancelled', exitCode, error: { code } });
  });
  it('cannot report an incomplete encoding as success', () => expect(reduceOutcome({ ...valid, encoding: { status: 'pending', errors: [] } })).toMatchObject({ status: 'failed', exitCode: 1 }));
});

describe('saved comparison consistency', () => {
  it('rejects a persisted success claim for captured failed steps and a corrupted summary', async () => {
    const bundle = CaptureBundleSchema.parse(JSON.parse(await readFile(new URL('../fixtures/capture.json', import.meta.url), 'utf8')));
    const scenario = bundle.scenarios[0];
    const step = scenario?.steps[0];
    if (!scenario || !step) throw new Error('Fixture needs one step');
    scenario.outcome = 'partial';
    step.before = { ...step.before, status: 'failed', reasonCode: 'PAGE_ERROR' };
    step.changeRatio = null;
    const coverage = { selected: [], omitted: [], unsupported: [], unresolved: [], complete: true };
    const manifest = { scenarios: bundle.scenarios, coverage, summary: summarize(bundle, coverage), comparisonOutcome: comparisonOutcome(bundle, coverage, provenance), cleanupOutcome: valid.cleanup, encodingOutcome: valid.encoding };
    expect(() => validateCompletedComparison(manifest)).not.toThrow();
    expect(() => validateCompletedComparison({ ...manifest, comparisonOutcome: { ...manifest.comparisonOutcome, status: 'ok' } })).toThrow(expect.objectContaining({ exitCode: 2, detail: expect.objectContaining({ code: 'INCONSISTENT_MANIFEST' }) }));
    expect(() => validateCompletedComparison({ ...manifest, summary: { ...manifest.summary, failedSteps: 0 } })).toThrow();
  });
});
