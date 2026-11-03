import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertNoOwnedActivity, command, hash, saveJson, sourceState, verifyArtifacts } from './release-harness.mjs';

async function ownedRuns(repoRoot) {
  assert.equal(await realpath(repoRoot), repoRoot, 'Fixture root must be canonical');
  for (const directory of [repoRoot, join(repoRoot, '.show-what-changed'), join(repoRoot, '.show-what-changed/runs')]) {
    let info;
    try { info = await lstat(directory); }
    catch (error) { if (error.code === 'ENOENT' && directory !== repoRoot) return []; throw error; }
    assert(info.isDirectory() && !info.isSymbolicLink(), 'Comparison inventory must contain real directories');
  }
  const entries = await readdir(join(repoRoot, '.show-what-changed/runs'), { withFileTypes: true });
  assert(entries.every((entry) => entry.isDirectory() && /^\d{8}T\d{9}Z-[a-f0-9]{16}$/.test(entry.name)), 'Unexpected comparison run directory');
  return entries.map((entry) => entry.name).sort();
}

const failure = (error) => ({ name: error.name, message: error.message, ...(error.code ? { code: error.code } : {}) });

async function retainPublicArtifacts(runDir, output, name, runId, multiple) {
  const directory = multiple ? join(name, runId) : name;
  const evidence = { runId, directory, copied: [], missing: [] };
  const failures = [];
  const reject = (artifact, error) => failures.push({ artifact, error });
  let destination;
  try {
    assert(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name), 'Evidence name must be one path segment');
    assert.equal(await realpath(output), output, 'Evidence output must be canonical');
    destination = output;
    for (const segment of multiple ? [name, runId] : [name]) {
      destination = join(destination, segment);
      await mkdir(destination, { recursive: true });
      assert.equal(await realpath(destination), destination, 'Evidence directory must not be a symlink');
    }
  } catch (error) { reject(null, error); return { evidence, failures }; }
  const retainFile = async (artifact) => {
    let source;
    try {
      const path = join(runDir, artifact);
      const info = await lstat(path);
      assert(info.isFile() && !info.isSymbolicLink(), 'Public artifact must be a regular file');
      assert.equal(await realpath(path), path, 'Public artifact must stay in its owned run');
      source = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      assert((await source.stat()).isFile(), 'Public artifact must remain a regular file');
      await writeFile(join(destination, artifact), await source.readFile(), { flag: 'wx', mode: 0o600 });
      evidence.copied.push(artifact);
    } catch (error) {
      if (error.code === 'ENOENT') evidence.missing.push(artifact);
      else reject(artifact, error);
    } finally {
      try { await source?.close(); }
      catch (error) { reject(artifact, error); }
    }
  };
  for (const artifact of ['manifest.json', 'capture.json', 'timeline.json', 'compare.mp4', 'poster.png', 'pr.md']) await retainFile(artifact);
  for (const directory of ['frames', 'composed']) {
    try {
      const path = join(runDir, directory);
      const info = await lstat(path);
      assert(info.isDirectory() && !info.isSymbolicLink(), 'Public image directory must be a real directory');
      assert.equal(await realpath(path), path, 'Public image directory must stay in its owned run');
      await mkdir(join(destination, directory));
      for (const entry of await readdir(path, { withFileTypes: true })) {
        const artifact = join(directory, entry.name);
        if (!entry.name.endsWith('.png') || !entry.isFile()) {
          reject(artifact, new Error('Public image evidence must be a regular PNG file'));
          continue;
        }
        await retainFile(artifact);
      }
    } catch (error) {
      if (error.code === 'ENOENT') evidence.missing.push(directory);
      else reject(directory, error);
    }
  }
  return { evidence, failures };
}

export async function capturePublicAppRun({ name, flow, args, source }, { candidate, fixture, output, report }, checks = {}) {
  const compare = checks.command ?? command;
  const verify = checks.verifyArtifacts ?? verifyArtifacts;
  const inspectCleanup = checks.assertNoOwnedActivity ?? assertNoOwnedActivity;
  const inspectCaller = checks.sourceState ?? sourceState;
  const row = {
    name, status: 'running', command: { expectedExit: 0, actualExit: null, attempted: false }, runIds: [],
    cleanup: { status: 'pending', runs: [] }, artifactEvidence: [], callerPreserved: false, callerStateSha256: hash(JSON.stringify(source)), verificationErrors: [],
  };
  report.runs.push(row);
  let existingRuns;
  let run;
  let result;
  let primaryError;
  try {
    existingRuns = await ownedRuns(fixture.repoRoot);
    row.command.attempted = true;
    result = await compare([candidate.binary, 'compare', ...args, '--allow-exec', '--json'], fixture.repoRoot, { expectedCode: 0 });
    row.command.actualExit = result.code;
    row.command.signal = result.signal;
    await saveJson(join(output, name + '.json'), result);
    assert.equal(result.code, 0);
    const envelope = JSON.parse(result.stdout);
    candidate.schemas.ResultSchema.parse(envelope);
    assert.equal(envelope.exitCode, 0);
    candidate.commands.push({ name, args: ['compare', ...args, '--allow-exec'], code: result.code, elapsedMs: result.elapsedMs });
    run = await verify(fixture.repoRoot, envelope, candidate.schemas);
    assert.equal(run.manifest.captureMode, 'motion');
    assert.equal(run.manifest.summary.failedSteps, 0);
    assert(run.manifest.summary.verifiedPairs > 0);
    const capture = candidate.schemas.CaptureBundleSchema.parse(JSON.parse(await readFile(join(run.runDir, 'capture.json'), 'utf8')));
    for (const motion of capture.motion) for (const side of ['before', 'after']) {
      assert.equal(motion.tracks[side].status, 'ok');
      assert(motion.tracks[side].frames.length > 1, 'A motion run must retain multiple source frames');
    }
    if (flow === 'validation') {
      const checkpoint = run.manifest.scenarios[0].steps.find((step) => step.id === 'validation-feedback');
      assert(checkpoint && checkpoint.before.status === 'ok' && checkpoint.after.status === 'ok');
      assert(checkpoint.changeRatio > 0, 'Actual validation feedback must visibly differ');
    }
    if (flow === 'validation-worktree') {
      assert.equal(run.manifest.sources.after.kind, 'worktree');
      assert(run.manifest.summary.changedPairs > 0);
    }
    Object.assign(row, { runId: run.manifest.runId, summary: run.manifest.summary, comparison: run.manifest.comparisonOutcome, video: run.manifest.artifacts.video, poster: run.manifest.artifacts.poster, captureQuality: run.manifest.captureQuality });
  } catch (error) {
    primaryError = error;
    row.error = failure(error);
    result ??= error.result;
    row.command.actualExit = result?.code ?? null;
    row.command.signal = result?.signal ?? null;
    row.command.timedOut = result?.timedOut === true;
    if (result) {
      try { await saveJson(join(output, name + '.json'), result); }
      catch (saveError) { row.verificationErrors.push({ stage: 'command-evidence', ...failure(saveError) }); }
    }
  } finally {
    if (row.command.attempted) {
      try {
        row.runIds = (await ownedRuns(fixture.repoRoot)).filter((runId) => !existingRuns.includes(runId));
        for (const runId of row.runIds) {
          const runDir = join(fixture.repoRoot, '.show-what-changed/runs', runId);
          const cleanup = { runId, activity: 'pending', workspacesAbsent: false };
          row.cleanup.runs.push(cleanup);
          try {
            assert.equal(await realpath(runDir), runDir, 'Owned run directory must be canonical');
            assert((await lstat(join(runDir, 'private'))).isDirectory(), 'Owned private directory must exist');
            assert.equal(await realpath(join(runDir, 'private')), join(runDir, 'private'), 'Owned private directory must be canonical');
          } catch (error) { row.verificationErrors.push({ stage: 'run-path', runId, ...failure(error) }); continue; }
          const retained = await retainPublicArtifacts(runDir, output, name, runId, row.runIds.length > 1);
          row.artifactEvidence.push(retained.evidence);
          if (!primaryError) for (const artifact of retained.evidence.missing) {
            retained.failures.push({ artifact, error: new Error('Successful comparison must retain every expected public artifact') });
          }
          for (const { artifact, error } of retained.failures) {
            row.verificationErrors.push({ stage: 'artifact-evidence', runId, artifact, ...failure(error) });
            primaryError ??= error;
            row.error ??= failure(error);
          }
          try { Object.assign(cleanup, await inspectCleanup(runDir), { activity: 'ok' }); }
          catch (error) { cleanup.activity = 'failed'; row.verificationErrors.push({ stage: 'activity', runId, ...failure(error) }); }
          try {
            await assert.rejects(lstat(join(runDir, 'private/workspaces')), { code: 'ENOENT' });
            assert.equal(await realpath(join(runDir, 'private')), join(runDir, 'private'), 'Owned private directory must remain canonical');
            cleanup.workspacesAbsent = true;
          } catch (error) { row.verificationErrors.push({ stage: 'workspaces', runId, ...failure(error) }); }
        }
        assert.equal(row.runIds.length, 1, 'One comparison run must be independently inspected');
        if (run) assert.deepEqual(row.runIds, [run.manifest.runId], 'Artifact run must match the new owned run');
        row.cleanup.status = row.cleanup.runs.every((entry) => entry.activity === 'ok' && entry.workspacesAbsent) ? 'ok' : 'failed';
      } catch (error) { row.cleanup.status = 'failed'; row.verificationErrors.push({ stage: 'run-inventory', ...failure(error) }); }
    }
    try {
      const current = await inspectCaller(fixture.repoRoot);
      row.currentCallerStateSha256 = hash(JSON.stringify(current));
      assert.deepEqual(current, source);
      row.callerPreserved = true;
    } catch (error) { row.verificationErrors.push({ stage: 'caller-preservation', ...failure(error) }); }
  }
  row.status = primaryError || row.verificationErrors.length ? 'failed' : 'passed';
  if (primaryError) throw primaryError;
  assert.equal(row.status, 'passed', `Public app run ${name} failed independent verification`);
  return run;
}
