import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { capturePublicAppRun } from './real-app-run.mjs';

const runId = '20261103T010203004Z-0123456789abcdef';
const secondRunId = '20261103T010203005Z-fedcba9876543210';
const olderRunId = '20261103T010203003Z-abcdef0123456789';
const parse = (value) => value;

async function temporary(run) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'swc-public-app-run-test-')));
  try { await run(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

async function controlled(root, options = {}) {
  const repoRoot = join(root, 'fixture');
  await mkdir(repoRoot);
  const caller = join(repoRoot, 'caller.txt');
  await writeFile(caller, options.baseline ?? 'Original caller and dependency links.\n');
  const output = join(root, 'evidence');
  const report = { runs: [] };
  const runDir = join(repoRoot, '.show-what-changed/runs', runId);
  const observed = { activity: [], caller: 0, artifacts: 0, compares: 0 };
  const manifest = {
    runId, captureMode: 'motion', summary: { failedSteps: 0, verifiedPairs: 1, changedPairs: 1 },
    sources: { after: { kind: options.afterKind ?? 'worktree' } },
    scenarios: [{ steps: [{ id: 'validation-feedback', before: { status: 'ok' }, after: { status: 'ok' }, changeRatio: options.changeRatio ?? 0.2 }] }],
    artifacts: { video: {}, poster: {} }, comparisonOutcome: {}, captureQuality: {},
  };
  const run = { runDir, manifest };
  const source = { caller: await readFile(caller, 'utf8') };
  const candidate = { binary: 'controlled-no-cli', schemas: { ResultSchema: { parse }, CaptureBundleSchema: { parse } }, commands: [] };
  const context = { candidate, fixture: { repoRoot }, output, report };
  const caseInput = { name: 'validation-1', flow: 'validation', args: ['--scenario', 'controlled.json'], source };
  const checks = {
    command: async (argv, cwd, commandOptions) => {
      observed.compares++;
      assert.equal(cwd, repoRoot);
      assert.deepEqual(argv, ['controlled-no-cli', 'compare', '--scenario', 'controlled.json', '--allow-exec', '--json']);
      assert.equal(commandOptions.expectedCode, 0);
      if (!options.noRun) {
        await mkdir(join(runDir, 'private'), { recursive: true });
        await mkdir(join(runDir, 'frames'));
        await mkdir(join(runDir, 'composed'));
        const tracks = Object.fromEntries(['before', 'after'].map((side) => [side, { status: options.badMotion ? 'failed' : 'ok', frames: [1, 2] }]));
        await writeFile(join(runDir, 'capture.json'), JSON.stringify(options.capture ?? { motion: [{ tracks }] }));
        for (const filename of ['manifest.json', 'timeline.json', 'compare.mp4', 'poster.png', 'pr.md']) await writeFile(join(runDir, filename), 'Synthetic test evidence.');
        if (options.leftWorkspace) await mkdir(join(runDir, 'private/workspaces'));
        if (options.danglingWorkspace) await symlink(join(root, 'missing'), join(runDir, 'private/workspaces'));
        if (options.secondRun) await mkdir(join(repoRoot, '.show-what-changed/runs', secondRunId, 'private'), { recursive: true });
        await options.afterArtifacts?.(runDir);
      }
      if (options.mutateCaller) await writeFile(caller, 'Unexpected caller mutation.\n');
      if (options.redirectInventory) {
        await rm(join(repoRoot, '.show-what-changed/runs'), { recursive: true });
        await mkdir(join(root, 'foreign'));
        await symlink(join(root, 'foreign'), join(repoRoot, '.show-what-changed/runs'));
      }
      const result = { code: options.exit ?? 0, signal: null, elapsedMs: 1, timedOut: false, stdout: options.invalidJson ? '{' : JSON.stringify({ exitCode: 0, data: manifest }), stderr: '' };
      if (options.compareError) throw Object.assign(options.compareError, { result });
      return result;
    },
    verifyArtifacts: async () => { observed.artifacts++; if (options.artifactError) throw options.artifactError; return run; },
    assertNoOwnedActivity: async (path) => { observed.activity.push(path); if (options.activityError) throw options.activityError; return { processLedgers: 1, dockerIdentities: 0 }; },
    sourceState: async () => { observed.caller++; if (options.callerReadError) throw options.callerReadError; return { caller: await readFile(caller, 'utf8') }; },
  };
  return { context, caseInput, checks, observed, run, caller };
}

test('a successful comparison records the real exit, one newly owned run, cleanup, workspace absence, and exact caller preservation', async () => temporary(async (root) => {
  const f = await controlled(root);
  await mkdir(join(f.context.fixture.repoRoot, '.show-what-changed/runs', olderRunId, 'private/workspaces'), { recursive: true });
  assert.equal(await capturePublicAppRun(f.caseInput, f.context, f.checks), f.run);
  const row = f.context.report.runs[0];
  assert.equal(row.status, 'passed');
  assert.equal(row.command.actualExit, 0);
  assert.deepEqual(row.runIds, [runId]);
  assert.deepEqual(row.cleanup, { status: 'ok', runs: [{ runId, activity: 'ok', workspacesAbsent: true, processLedgers: 1, dockerIdentities: 0 }] });
  assert.equal(row.callerPreserved, true);
  assert.equal(row.currentCallerStateSha256, row.callerStateSha256);
  assert.deepEqual(f.observed.activity, [f.run.runDir]);
  assert.equal(f.observed.caller, 1);
  assert.equal(await readFile(join(f.context.output, 'validation-1/compare.mp4'), 'utf8'), 'Synthetic test evidence.');
}));

test('an unexpected exit preserves the primary failure while detecting a retained workspace and caller mutation', async () => temporary(async (root) => {
  const original = new Error('Controlled compare failed.');
  const f = await controlled(root, { exit: 6, compareError: original, leftWorkspace: true, mutateCaller: true });
  await assert.rejects(capturePublicAppRun(f.caseInput, f.context, f.checks), (error) => error === original);
  const row = f.context.report.runs[0];
  assert.equal(row.status, 'failed');
  assert.equal(row.error.message, original.message);
  assert.equal(row.command.actualExit, 6);
  assert.deepEqual(row.runIds, [runId]);
  assert.equal(row.cleanup.status, 'failed');
  assert.equal(row.cleanup.runs[0].workspacesAbsent, false);
  assert.equal(row.callerPreserved, false);
  assert.deepEqual(row.verificationErrors.map((error) => error.stage), ['workspaces', 'caller-preservation']);
  assert.equal(f.observed.artifacts, 0);
  assert.deepEqual(f.observed.activity, [f.run.runDir]);
  await access(join(f.run.runDir, 'private/workspaces'));
  assert.equal(await readFile(f.caller, 'utf8'), 'Unexpected caller mutation.\n');
  assert.equal(JSON.parse(await readFile(join(f.context.output, 'validation-1.json'), 'utf8')).code, 6);
}));

test('an exit 3 preserves the original failed clock samples and sanitized artifacts before the fixture disappears', async () => temporary(async (root) => {
  const original = new Error('Controlled CAPTURE_CLOCK_DRIFT exit.');
  const clock = { rate: 1, offsetMs: -10000, uncertaintyMs: 27, maxDriftMs: 18, errorBoundMs: 45, samples: [
    { sourceSeconds: 12, hostBeforeMs: 1999, hostAfterMs: 2001 },
    { sourceSeconds: 13, hostBeforeMs: 2991, hostAfterMs: 3045 },
  ] };
  const capture = { motion: [{ tracks: { after: { status: 'failed', clock, failureAtMs: 3045.1 } } }] };
  const f = await controlled(root, { exit: 3, compareError: original, capture, afterArtifacts: async (runDir) => {
    await writeFile(join(runDir, 'frames', 'after-00000.png'), 'Sanitized source PNG.');
    await writeFile(join(runDir, 'composed', '000-overlay.png'), 'Sanitized composed PNG.');
    await writeFile(join(runDir, 'private', 'secret.txt'), 'Never export private state.');
  } });
  await assert.rejects(capturePublicAppRun(f.caseInput, f.context, f.checks), (error) => error === original);
  const row = f.context.report.runs[0];
  const destination = join(f.context.output, f.caseInput.name);
  await rm(f.context.fixture.repoRoot, { recursive: true });
  assert.deepEqual(JSON.parse(await readFile(join(destination, 'capture.json'), 'utf8')), capture);
  for (const filename of ['manifest.json', 'timeline.json', 'compare.mp4', 'poster.png', 'pr.md', 'frames/after-00000.png', 'composed/000-overlay.png']) await access(join(destination, filename));
  await assert.rejects(access(join(destination, 'private')), { code: 'ENOENT' });
  assert.equal(row.error.message, original.message);
  assert.equal(row.command.actualExit, 3);
  assert.equal(row.status, 'failed');
  assert.equal(row.cleanup.status, 'ok');
  assert.equal(row.callerPreserved, true);
}));

test('a failed comparison retains available clock evidence when optional media and frame directories are absent', async () => temporary(async (root) => {
  const original = new Error('Controlled partial capture.');
  const f = await controlled(root, { exit: 3, compareError: original, afterArtifacts: async (runDir) => {
    for (const name of ['timeline.json', 'compare.mp4', 'poster.png', 'pr.md', 'frames', 'composed']) await rm(join(runDir, name), { recursive: true });
  } });
  await assert.rejects(capturePublicAppRun(f.caseInput, f.context, f.checks), (error) => error === original);
  const row = f.context.report.runs[0];
  await access(join(f.context.output, f.caseInput.name, 'capture.json'));
  await access(join(f.context.output, f.caseInput.name, 'manifest.json'));
  assert.deepEqual(row.verificationErrors, []);
  assert.equal(row.status, 'failed');
  assert.equal(row.command.actualExit, 3);
  assert.deepEqual(row.artifactEvidence[0].missing.sort(), ['timeline.json', 'compare.mp4', 'poster.png', 'pr.md', 'frames', 'composed'].sort());
}));

for (const artifact of ['manifest.json', 'capture.json', 'timeline.json', 'compare.mp4', 'poster.png', 'pr.md', 'frames', 'composed']) {
  test(`a successful comparison cannot pass when expected ${artifact} evidence is absent`, async () => temporary(async (root) => {
    const f = await controlled(root, { afterArtifacts: async (runDir) => {
      await rm(join(runDir, artifact), { recursive: true });
    } });
    await assert.rejects(capturePublicAppRun(f.caseInput, f.context, f.checks));
    const row = f.context.report.runs[0];
    assert.equal(row.command.actualExit, 0);
    assert.equal(row.status, 'failed');
    assert(row.artifactEvidence[0].missing.includes(artifact));
    assert.equal(row.cleanup.status, 'ok');
    assert.equal(row.callerPreserved, true);
  }));
}

test('a failure before artifact creation records absence without inventing capture evidence', async () => temporary(async (root) => {
  const original = new Error('Controlled failure before artifacts.');
  const f = await controlled(root, { exit: 3, compareError: original, afterArtifacts: async (runDir) => {
    for (const name of ['manifest.json', 'capture.json', 'timeline.json', 'compare.mp4', 'poster.png', 'pr.md', 'frames', 'composed']) await rm(join(runDir, name), { recursive: true });
  } });
  await assert.rejects(capturePublicAppRun(f.caseInput, f.context, f.checks), (error) => error === original);
  const row = f.context.report.runs[0];
  assert.deepEqual(row.artifactEvidence[0].copied, []);
  assert.equal(row.artifactEvidence[0].missing.length, 8);
  assert.deepEqual(row.verificationErrors, []);
  assert.equal(row.cleanup.status, 'ok');
  assert.equal(row.status, 'failed');
}));

test('failure retention rejects artifact and frame symlinks while preserving other safe evidence and the primary error', async () => temporary(async (root) => {
  const original = new Error('Controlled failed comparison.');
  const foreign = join(root, 'private-foreign.txt');
  await writeFile(foreign, 'Do not export this foreign file.');
  const f = await controlled(root, { exit: 3, compareError: original, afterArtifacts: async (runDir) => {
    await rm(join(runDir, 'manifest.json'));
    await symlink(foreign, join(runDir, 'manifest.json'));
    await symlink(foreign, join(runDir, 'frames', 'foreign.png'));
  } });
  await assert.rejects(capturePublicAppRun(f.caseInput, f.context, f.checks), (error) => error === original);
  const destination = join(f.context.output, f.caseInput.name);
  await access(join(destination, 'capture.json'));
  await assert.rejects(access(join(destination, 'manifest.json')), { code: 'ENOENT' });
  await assert.rejects(access(join(destination, 'frames', 'foreign.png')), { code: 'ENOENT' });
  assert(f.context.report.runs[0].verificationErrors.some((error) => error.stage === 'artifact-evidence'));
  assert.equal(f.context.report.runs[0].status, 'failed');
}));

test('failure retention cannot traverse an image-directory symlink or a destination symlink', async () => temporary(async (root) => {
  const original = new Error('Controlled failed comparison.');
  const foreign = join(root, 'foreign');
  await mkdir(foreign);
  await writeFile(join(foreign, 'private.png'), 'Never export this foreign image.');
  const f = await controlled(root, { exit: 3, compareError: original, afterArtifacts: async (runDir) => {
    await rm(join(runDir, 'frames'), { recursive: true });
    await symlink(foreign, join(runDir, 'frames'));
  } });
  await assert.rejects(capturePublicAppRun(f.caseInput, f.context, f.checks), (error) => error === original);
  const destination = join(f.context.output, f.caseInput.name);
  await access(join(destination, 'capture.json'));
  await assert.rejects(access(join(destination, 'frames')), { code: 'ENOENT' });
  assert(f.context.report.runs[0].verificationErrors.some((error) => error.stage === 'artifact-evidence'));

  await mkdir(join(root, 'second'));
  const g = await controlled(join(root, 'second'), { exit: 3, compareError: original });
  await mkdir(g.context.output);
  await symlink(foreign, join(g.context.output, g.caseInput.name));
  await assert.rejects(capturePublicAppRun(g.caseInput, g.context, g.checks), (error) => error === original);
  await assert.rejects(access(join(foreign, 'capture.json')), { code: 'ENOENT' });
  assert.equal(g.context.report.runs[0].cleanup.status, 'ok');
  assert.equal(g.context.report.runs[0].status, 'failed');
}));

for (const [label, options] of [
  ['artifact assertion', { artifactError: new Error('Controlled artifact failure.') }],
  ['motion assertion', { badMotion: true }],
  ['validation feedback assertion', { changeRatio: 0 }],
  ['malformed command output', { invalidJson: true }],
  ['nonzero exit returned by controlled command', { exit: 6 }],
]) test(`${label} still independently inspects cleanup and caller preservation`, async () => temporary(async (root) => {
  const f = await controlled(root, options);
  await assert.rejects(capturePublicAppRun(f.caseInput, f.context, f.checks));
  const row = f.context.report.runs[0];
  assert.equal(row.status, 'failed');
  assert.equal(row.command.actualExit, options.exit ?? 0);
  assert.equal(row.cleanup.status, 'ok');
  assert.equal(row.callerPreserved, true);
  assert.deepEqual(f.observed.activity, [f.run.runDir]);
}));

test('the WORKTREE case uses the saved edited baseline and retains its original source assertion', async () => temporary(async (root) => {
  const f = await controlled(root, { baseline: 'Intentional WORKTREE feedback edit.\n', afterKind: 'commit' });
  f.caseInput.flow = 'validation-worktree';
  await assert.rejects(capturePublicAppRun(f.caseInput, f.context, f.checks), /worktree/);
  assert.equal(f.context.report.runs[0].callerPreserved, true);
  assert.equal(f.context.report.runs[0].cleanup.status, 'ok');
}));

test('an activity inspection failure does not skip the independent workspace and caller checks', async () => temporary(async (root) => {
  const original = new Error('Controlled compare failed.');
  const f = await controlled(root, { compareError: original, activityError: new Error('Controlled activity inspection failed.') });
  await assert.rejects(capturePublicAppRun(f.caseInput, f.context, f.checks), (error) => error === original);
  const row = f.context.report.runs[0];
  assert.equal(row.cleanup.status, 'failed');
  assert.equal(row.cleanup.runs[0].activity, 'failed');
  assert.equal(row.cleanup.runs[0].workspacesAbsent, true);
  assert.equal(row.callerPreserved, true);
}));

test('every newly owned run is inspected before the extra-run failure blocks acceptance', async () => temporary(async (root) => {
  const f = await controlled(root, { secondRun: true, activityError: new Error('Controlled activity inspection failed.') });
  await assert.rejects(capturePublicAppRun(f.caseInput, f.context, f.checks));
  assert.deepEqual(f.context.report.runs[0].runIds, [runId, secondRunId]);
  assert.equal(f.observed.activity.length, 2);
  assert(f.context.report.runs[0].cleanup.runs.every((run) => run.workspacesAbsent));
  assert(f.context.report.runs[0].verificationErrors.some((error) => error.stage === 'run-inventory'));
  await access(join(f.context.output, f.caseInput.name, runId, 'capture.json'));
  assert.deepEqual(f.context.report.runs[0].artifactEvidence.map((entry) => entry.directory), [join(f.caseInput.name, runId), join(f.caseInput.name, secondRunId)]);
}));

test('no registered run cannot be reported as verified cleanup', async () => temporary(async (root) => {
  const f = await controlled(root, { noRun: true, compareError: new Error('Failed before run registration.') });
  await assert.rejects(capturePublicAppRun(f.caseInput, f.context, f.checks));
  const row = f.context.report.runs[0];
  assert.equal(row.cleanup.status, 'failed');
  assert.deepEqual(row.cleanup.runs, []);
  assert.equal(row.callerPreserved, true);
  assert.deepEqual(row.artifactEvidence, []);
}));

test('an unreadable or redirected inventory cannot claim workspace absence or inspect a foreign directory', async () => temporary(async (root) => {
  const f = await controlled(root, { redirectInventory: true });
  await assert.rejects(capturePublicAppRun(f.caseInput, f.context, f.checks));
  const row = f.context.report.runs[0];
  assert.equal(row.cleanup.status, 'failed');
  assert.deepEqual(row.cleanup.runs, []);
  assert.deepEqual(f.observed.activity, []);
  assert.equal(row.callerPreserved, true);
}));

test('a dangling workspace symlink counts as residue', async () => temporary(async (root) => {
  const f = await controlled(root, { danglingWorkspace: true });
  await assert.rejects(capturePublicAppRun(f.caseInput, f.context, f.checks));
  assert.equal(f.context.report.runs[0].cleanup.runs[0].workspacesAbsent, false);
  assert.equal(f.context.report.runs[0].status, 'failed');
}));

test('an unreadable caller snapshot cannot claim caller preservation', async () => temporary(async (root) => {
  const f = await controlled(root, { callerReadError: new Error('Controlled unreadable caller state.') });
  await assert.rejects(capturePublicAppRun(f.caseInput, f.context, f.checks));
  assert.equal(f.context.report.runs[0].callerPreserved, false);
  assert.equal(f.context.report.runs[0].cleanup.status, 'ok');
}));


test('artifact evidence copy failure still records independent checks and remains the primary error', async () => temporary(async (root) => {
  const f = await controlled(root);
  await mkdir(f.context.output);
  await writeFile(join(f.context.output, f.caseInput.name), 'Block the evidence directory.');
  await assert.rejects(capturePublicAppRun(f.caseInput, f.context, f.checks), { code: 'EEXIST' });
  const row = f.context.report.runs[0];
  assert.equal(row.error.code, 'EEXIST');
  assert.equal(row.command.actualExit, 0);
  assert.equal(row.cleanup.status, 'ok');
  assert.equal(row.callerPreserved, true);
}));

test('an unsafe pre-comparison inventory blocks execution and cannot claim cleanup', async () => temporary(async (root) => {
  const f = await controlled(root);
  await mkdir(join(root, 'foreign'));
  await symlink(join(root, 'foreign'), join(f.context.fixture.repoRoot, '.show-what-changed'));
  await assert.rejects(capturePublicAppRun(f.caseInput, f.context, f.checks));
  const row = f.context.report.runs[0];
  assert.equal(row.command.attempted, false);
  assert.equal(row.command.actualExit, null);
  assert.equal(row.cleanup.status, 'pending');
  assert.deepEqual(row.cleanup.runs, []);
  assert.equal(f.observed.compares, 0);
  assert.equal(row.callerPreserved, true);
}));
