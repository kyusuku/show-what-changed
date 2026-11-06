import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { ResultSchema } from '../../src/schema/index.js';
import { releaseFailureSummary } from '../../scripts/release-smoke-diagnostics.mjs';

const secret = 'PRIVATE_IDENTIFIER_SHAPED_SECRET';
const envelope = (code = 'BROWSER_UNAVAILABLE', phase = 'browser') => ({ schemaVersion: 2, command: 'compare', status: 'failed', exitCode: 6, data: null, error: { code, phase, message: secret, hint: secret, logPath: 'private/' + secret }, warnings: [] });
const report = (value = envelope()) => ({ stage: 'acceptance', root: secret, commands: [{ name: 'compare-success', args: [secret], code: 0, validationStage: 'process' }], error: { commandName: 'compare-success', validationStage: 'process', message: secret, stack: secret, command: { argv: [secret], cwd: secret, code: 6, signal: 'SIGTERM', timedOut: true, overflow: false, stdout: JSON.stringify(value), stderr: secret } } });

test('failure projection emits only known process and schema identifiers without private command data', () => {
  const summary = releaseFailureSummary(report(), { ResultSchema });
  expect(summary.command).toEqual({ id: 'compare-success', context: 'failed-command', validationStage: 'process', expectedExit: 0, actualExit: 6, signal: 'SIGTERM', timedOut: true, overflow: false });
  expect(summary.diagnosis).toEqual({ status: 'failed', exitCode: 6, runId: null, code: 'BROWSER_UNAVAILABLE', phase: 'browser', errors: [] });
  expect(JSON.stringify(summary)).not.toContain(secret);
  const unknown = report(envelope(secret, secret));
  unknown.stage = unknown.error.commandName = unknown.error.validationStage = unknown.error.command.signal = secret;
  unknown.error.command.code = Infinity;
  const safe = releaseFailureSummary(unknown, { ResultSchema });
  expect(safe).toMatchObject({ stage: null, command: { id: null, validationStage: null, actualExit: null, signal: null }, diagnosis: null });
  unknown.error.command.code = 6;
  expect(releaseFailureSummary(unknown, { ResultSchema }).diagnosis).toMatchObject({ code: null, phase: null });
  expect(JSON.stringify(releaseFailureSummary(unknown, { ResultSchema }))).not.toContain(secret);
});

test('diagnosis requires a bounded schema-valid matching envelope and limits error details', () => {
  expect(releaseFailureSummary(report()).diagnosis).toBeNull();
  const input = report();
  for (const stdout of ['PRIVATE_NOT_JSON', '{}', 'x'.repeat(16 * 1024 * 1024 + 1), JSON.stringify({ ...envelope(), exitCode: 0 })]) {
    input.error.command.stdout = stdout;
    expect(releaseFailureSummary(input, { ResultSchema }).diagnosis).toBeNull();
  }
  const parsed = { ...envelope(), data: { runId: secret, errors: Array.from({ length: 50 }, () => ({ code: secret, phase: secret, message: secret })) } };
  const summary = releaseFailureSummary(report(parsed), { ResultSchema: { parse: (value) => value } });
  expect(summary.diagnosis.errors).toHaveLength(8);
  expect(summary.diagnosis.errors.every((detail) => detail.code === null && detail.phase === null)).toBe(true);
  expect(JSON.stringify(summary)).not.toContain(secret);
});

test('a post-command assertion reports only its exact local callsite and labels the last command as context', () => {
  const input = { stage: 'acceptance', commands: [{ name: 'compare-success', code: 0, actualExit: 0, validationStage: 'complete' }], error: { code: 'ERR_ASSERTION', message: secret, actual: secret, expected: secret, stack: `AssertionError: ${secret}\n    at ${new URL('../../scripts/release-smoke.mjs', import.meta.url).href}:42:7\n    at ${secret}:2:3` } };
  expect(releaseFailureSummary(input)).toMatchObject({ command: { context: 'last-command', validationStage: 'complete' }, diagnosis: null, assertionSite: { file: 'scripts/release-smoke.mjs', line: 42, column: 7 } });
  input.error.stack = `AssertionError\n    at file:///private/${secret}/release-smoke.mjs:42:7`;
  expect(releaseFailureSummary(input).assertionSite).toBeNull();
  expect(JSON.stringify(releaseFailureSummary(input))).not.toContain(secret);
});

test('a later non-CLI command failure does not replace the last successful CLI process metadata', () => {
  const input = { stage: 'acceptance', commands: [{ name: 'compare-success', code: 0, actualExit: 0, validationStage: 'complete', signal: null, timedOut: false, overflow: false }], error: { command: { argv: ['git'], code: 128, signal: 'SIGTERM', timedOut: true, overflow: true, stdout: secret, stderr: secret } } };
  expect(releaseFailureSummary(input).command).toEqual({ id: 'compare-success', context: 'last-command', validationStage: 'complete', expectedExit: 0, actualExit: 0, signal: null, timedOut: false, overflow: false });
});

test('the release smoke executable prints one safe failure object while retaining raw tar failure privately', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'swc-release-summary-')));
  try {
    const archive = join(root, secret + '.tgz');
    await writeFile(archive, 'Not a tar archive.\n');
    let failure;
    try { execFileSync(process.execPath, [new URL('../../scripts/release-smoke.mjs', import.meta.url).pathname, archive, join(root, 'reports')], { encoding: 'utf8', stdio: 'pipe' }); }
    catch (error) { failure = error; }
    expect(failure.status).toBe(1);
    expect(failure.stderr).toBe('');
    const summary = JSON.parse(failure.stdout);
    expect(summary).toMatchObject({ status: 'failed', stage: 'install', command: { id: 'tar-list', validationStage: 'process' } });
    expect(failure.stdout).not.toContain(secret);
    expect(failure.stdout).not.toContain(root);
    const evidence = JSON.parse(await readFile(join(root, 'reports/tar-list.json'), 'utf8'));
    expect(evidence.argv).toContain(archive);
    expect(JSON.parse(await readFile(join(root, 'reports/report.json'), 'utf8')).error.command).toEqual(evidence);
  } finally { await rm(root, { recursive: true, force: true }); }
});
