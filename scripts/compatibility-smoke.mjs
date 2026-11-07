#!/usr/bin/env node
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { access, copyFile, cp, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertNoOwnedActivity, command, hash, installCandidate, saveJson, sourceState, verifyArtifacts } from './release-harness.mjs';

const usage = 'Usage: node scripts/compatibility-smoke.mjs [--docker | --docker-only] candidate.tgz output-directory';
export const compatibilityProfiles = [
  { name: 'static', file: 'index.html', from: '<h1>Static source</h1>', to: '<h1>Updated static source</h1>' },
  { name: 'npm', file: 'index.html', from: '<h1>Static source</h1>', to: '<h1>Updated npm source</h1>' },
  { name: 'pnpm', file: 'packages/shared/index.js', from: 'Shared workspace source', to: 'Updated shared workspace source' },
  { name: 'python', file: 'server.py', from: '<h1>Python source</h1>', to: '<h1>Updated Python source</h1>' },
  { name: 'docker', file: 'index.html', from: '<h1>Container source</h1>', to: '<h1>Updated container source</h1>' },
];

export function compatibilitySelection(args) {
  const flags = args.filter((arg) => arg.startsWith('--'));
  const positional = args.filter((arg) => !arg.startsWith('--'));
  assert(positional.length === 2 && flags.length <= 1 && flags.every((arg) => ['--docker', '--docker-only'].includes(arg)), usage);
  const mode = flags[0]?.slice(2) ?? 'host';
  return { mode, tarball: resolve(positional[0]), output: resolve(positional[1]), profiles: compatibilityProfiles.filter((profile) => mode === 'docker' || (profile.name === 'docker') === (mode === 'docker-only')) };
}

export async function prepareCompatibilityFixture(profile, root) {
  const repo = join(root, profile.name);
  await cp(fileURLToPath(new URL(`../fixtures/general-app/${profile.name}`, import.meta.url)), repo, { recursive: true });
  await writeFile(join(repo, '.gitignore'), '.show-what-changed/\nnode_modules/\n__pycache__/\n');
  await writeFile(join(repo, 'caller-state.txt'), 'Caller baseline.\n');
  const gitEnv = {
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Public Compatibility Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Public Compatibility Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    GIT_AUTHOR_DATE: '2026-01-15T10:00:00+00:00', GIT_COMMITTER_DATE: '2026-01-15T10:00:00+00:00',
  };
  const git = async (...args) => (await command(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgSign=false', ...args], repo, { expectedCode: 0, env: gitEnv })).stdout.trim();
  await git('init', '--initial-branch=main', '--object-format=sha1', '--template=');
  await git('add', '--all');
  await git('commit', '--no-verify', '-m', 'Public compatibility baseline');
  const base = await git('rev-parse', 'HEAD');
  const sourcePath = join(repo, profile.file);
  const before = await readFile(sourcePath, 'utf8');
  assert.equal(before.split(profile.from).length, 2, `Missing unique reviewed source change in ${profile.name}`);
  const after = before.replace(profile.from, profile.to);
  await writeFile(sourcePath, after);
  await git('add', '--all');
  await git('commit', '--no-verify', '-m', 'Public visible source change');
  const head = await git('rev-parse', 'HEAD');
  await writeFile(join(repo, 'caller-state.txt'), 'Preserve this staged caller input.\n');
  await git('add', 'caller-state.txt');
  await writeFile(join(repo, 'caller-state.txt'), 'Preserve this unstaged caller input.\n');
  await writeFile(join(repo, 'caller-untracked.txt'), 'Preserve this untracked caller input.\n');
  await mkdir(join(repo, 'node_modules'), { recursive: true });
  await writeFile(join(repo, 'node_modules/caller-sentinel.txt'), 'Preserve existing caller dependencies.\n');
  const scenarioPath = join(root, `${profile.name}.scenario.json`);
  await saveJson(scenarioPath, { schemaVersion: 2, id: 'shared-flow', title: 'Declared web application', steps: [{ id: 'open', op: 'goto', path: '/' }, { id: 'source-change', op: 'screenshot', observeMs: 200 }] });
  return { repo, base, head, scenarioPath, sourceChange: { path: profile.file, beforeSha256: hash(before), afterSha256: hash(after) } };
}

async function runDirectories(repo) {
  try {
    const entries = await readdir(join(repo, '.show-what-changed/runs'), { withFileTypes: true });
    assert(entries.every((entry) => entry.isDirectory() && /^\d{8}T\d{9}Z-[a-f0-9]{16}$/.test(entry.name)), 'Unexpected comparison run directory');
    return entries.map((entry) => entry.name).sort();
  } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

function failureProcess(error) {
  const result = error?.result;
  return {
    actualExit: Number.isInteger(result?.code) && result.code >= 0 && result.code <= 255 ? result.code : null,
    timedOut: result?.timedOut === true, overflow: result?.overflow === true,
  };
}

function failureDiagnosis(error, schemas) {
  try {
    const envelope = schemas.ResultSchema.parse(JSON.parse(error.result.stdout));
    if (envelope.exitCode !== error.result.code) return null;
    const identifiers = (detail) => ({
      code: typeof detail?.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(detail.code) ? detail.code : null,
      phase: typeof detail?.phase === 'string' && /^[a-z][a-z0-9-]{0,39}$/.test(detail.phase) ? detail.phase : null,
    });
    return {
      status: envelope.status, exitCode: envelope.exitCode, ...identifiers(envelope.error),
      errors: (envelope.data?.errors ?? []).slice(0, 8).map(identifiers),
    };
  } catch { return null; }
}

export function compatibilitySummary(report) {
  const summary = { status: report.status, gateComplete: false, report: 'report.json' };
  if (report.status !== 'passed') {
    summary.error = report.error;
    summary.commandFailure = report.commandFailure ?? null;
    summary.diagnosis = report.diagnosis ?? null;
    summary.failedRows = report.rows.filter((row) => row.status !== 'passed').map((row) => ({
      application: row.application, stage: row.error.stage, code: row.error.code,
      commands: row.commands.map(({ actualExit, timedOut, overflow }) => ({ actualExit, timedOut: timedOut === true, overflow: overflow === true })),
      diagnosis: row.diagnosis ?? null,
    }));
  }
  return summary;
}

export async function runCompatibilityRow(profile, fixture, candidate, output, checks = {}) {
  const verify = checks.verifyArtifacts ?? verifyArtifacts;
  const inspectCleanup = checks.assertNoOwnedActivity ?? assertNoOwnedActivity;
  const { repo, base, head, scenarioPath } = fixture;
  const env = profile.name === 'docker' ? {
    SWC_FIXTURE_DB_PASSWORD: `SYNTHETIC_DB_${randomBytes(16).toString('hex')}`,
    SWC_FIXTURE_LOG_CANARY: `SYNTHETIC_LOG_${randomBytes(16).toString('hex')}`,
  } : {};
  const row = {
    application: profile.name, fixture: `fixtures/general-app/${profile.name}`, status: 'running', base, head, sourceChange: fixture.sourceChange,
    configSha256: hash(await readFile(join(repo, 'show-what-changed.config.json'))), scenarioSha256: hash(await readFile(scenarioPath)),
    environmentReferences: Object.keys(env).sort(), commands: [], artifactRedaction: 'pending',
    callerPreserved: false, cleanup: { status: 'pending', runs: [] },
  };
  const original = await sourceState(repo);
  const existingRuns = await runDirectories(repo);
  let stage = 'plan';
  let comparisonAttempted = false;
  let comparisonCompleted = false;
  let run;
  const cli = async (name, args) => {
    const entry = { cwd: profile.name, argv: ['show-what-changed', ...args.map((arg) => arg === scenarioPath ? `../${profile.name}.scenario.json` : arg), '--json'], expectedExit: 0, actualExit: null };
    row.commands.push(entry);
    try {
      const envelope = await candidate.cli(`${name}-${profile.name}`, args, repo, 0, env);
      entry.actualExit = envelope.exitCode;
      return envelope;
    } catch (error) {
      Object.assign(entry, failureProcess(error));
      throw error;
    }
  };
  try {
    const planned = await cli('plan', ['plan', '--base', base, '--head', head, '--scenario', scenarioPath]);
    assert.equal(planned.data.baseCommit, base);
    assert.equal(planned.data.headCommit, head);
    assert.equal(planned.data.headKind, 'commit');
    assert.deepEqual([...planned.data.execution.environmentReferences].sort(), row.environmentReferences);
    row.plan = { planId: planned.data.planId, configDigest: planned.data.configDigest, scenarioDigest: planned.data.scenarioDigest, sourceStats: planned.data.sourceStats };
    stage = 'compare';
    comparisonAttempted = true;
    const envelope = await cli('compare', ['compare', '--plan', '.show-what-changed/plan.json', '--allow-exec']);
    comparisonCompleted = true;
    stage = 'artifacts';
    run = await verify(repo, envelope, candidate.schemas, Object.values(env));
    assert.equal(run.manifest.captureMode, 'motion');
    assert.equal(run.manifest.summary.verifiedPairs, 2);
    assert(run.manifest.summary.changedPairs > 0);
    if (profile.name === 'docker') {
      for (const side of ['before', 'after']) {
        assert.equal(run.manifest.execution[side].kind, 'container');
        assert.equal(run.manifest.execution[side].services.length, 1);
        assert.equal(run.manifest.execution[side].services[0].id, 'db');
        assert.equal(run.manifest.execution[side].services[0].kind, 'container');
      }
      assert.notEqual(run.manifest.execution.before.services[0].identity, run.manifest.execution.after.services[0].identity);
    }
    row.runId = run.manifest.runId;
    row.execution = run.manifest.execution;
    row.versions = run.manifest.versions;
    row.summary = run.manifest.summary;
    row.artifactRedaction = 'passed';
  } catch (error) {
    row.error = { code: 'COMPATIBILITY_ROW_FAILED', stage };
    row.diagnosis = failureDiagnosis(error, candidate.schemas);
  } finally {
    try {
      const createdRuns = (await runDirectories(repo)).filter((runId) => !existingRuns.includes(runId));
      if (comparisonAttempted) assert.equal(createdRuns.length, 1, 'One comparison run must be independently inspected');
      if (run) assert.deepEqual(createdRuns, [run.manifest.runId]);
      for (const runId of createdRuns) {
        const runDir = join(repo, '.show-what-changed/runs', runId);
        const verification = await inspectCleanup(runDir);
        if (profile.name === 'docker' && comparisonCompleted) {
          assert.equal(verification.processLedgers, 2, 'Docker execution and cleanup process ledgers are required');
          assert(verification.dockerIdentities > 0, 'Recorded Docker identities require independent absence checks');
        }
        await assert.rejects(access(join(runDir, 'private/workspaces')), { code: 'ENOENT' });
        row.cleanup.runs.push({ runId, ...verification, workspacesAbsent: true });
      }
      row.cleanup.status = 'ok';
    } catch { row.cleanup.status = 'failed'; row.error ??= { code: 'COMPATIBILITY_CLEANUP_FAILED', stage: 'cleanup' }; }
    try {
      const current = await sourceState(repo);
      assert.deepEqual(current, original);
      row.callerPreserved = true;
      row.callerStateSha256 = hash(JSON.stringify(original));
    } catch { row.error ??= { code: 'COMPATIBILITY_CALLER_CHANGED', stage: 'preservation' }; }
  }
  if (!row.error) {
    try {
      const destination = join(output, profile.name);
      await mkdir(destination, { recursive: true });
      await copyFile(join(run.runDir, 'manifest.json'), join(destination, 'manifest.json'));
      row.artifacts = {};
      for (const [name, artifact] of Object.entries(run.manifest.artifacts)) {
        if (!artifact) continue;
        await mkdir(resolve(destination, artifact.path, '..'), { recursive: true });
        await copyFile(join(run.runDir, artifact.path), join(destination, artifact.path));
        row.artifacts[name] = { ...artifact, path: `${profile.name}/${artifact.path}` };
      }
      for (const directory of ['frames', 'composed']) await cp(join(run.runDir, directory), join(destination, directory), { recursive: true });
    } catch { row.error = { code: 'COMPATIBILITY_ARTIFACT_COPY_FAILED', stage: 'evidence' }; }
  }
  row.status = row.error ? 'failed' : 'passed';
  return row;
}

export async function compatibilitySmoke(selection, dependencies = {}) {
  const output = selection.output;
  await mkdir(output, { recursive: true });
  const root = await realpath(await mkdtemp(join(tmpdir(), 'swc-compatibility-')));
  const report = {
    status: 'running', scope: `installed-${selection.mode}-recipe-matrix`, mode: selection.mode, gateComplete: false,
    pending: compatibilityProfiles.map((profile) => `${profile.name} installed-package acceptance`),
    releaseAcceptance: 'pending independent final-candidate platform, repetition, motion, security, and release gates',
    privateEvidence: { temporaryDirectory: basename(root), reportDirectory: 'private-evidence' },
    startedAt: new Date().toISOString(), platform: process.platform, arch: process.arch, node: process.version, rows: [],
  };
  let stage = 'install';
  let candidate;
  try {
    candidate = await (dependencies.installCandidate ?? installCandidate)(selection.tarball, root, join(root, 'private-evidence'));
    report.candidate = { sha256: candidate.sha256, bytes: candidate.bytes };
    report.fixtureLicense = { spdx: 'MIT', path: 'LICENSE', sha256: hash(await readFile(new URL('../LICENSE', import.meta.url))) };
    stage = 'doctor';
    report.doctor = { cwd: 'installed', argv: ['show-what-changed', 'doctor', '--json'], expectedExit: 0, actualExit: null };
    let doctor;
    try {
      doctor = await candidate.cli('doctor', ['doctor'], candidate.installRoot, 0);
      report.doctor.actualExit = doctor.exitCode;
    } catch (error) { Object.assign(report.doctor, failureProcess(error)); throw error; }
    report.tools = doctor.data.capabilities.map(({ name, available, version }) => ({ name, available, version: version && !/[\/\\\r\n]/.test(version) ? version : null }));
    if (selection.mode !== 'host') for (const name of ['docker', 'buildx']) assert(doctor.data.capabilities.some((capability) => capability.name === name && capability.available), 'Docker mode requires Docker Engine and buildx');
    for (const profile of selection.profiles) {
      stage = 'fixture';
      const fixture = await prepareCompatibilityFixture(profile, root);
      stage = 'comparison';
      const row = await runCompatibilityRow(profile, fixture, candidate, output, dependencies);
      report.rows.push(row);
      if (row.status !== 'passed') throw new Error('Compatibility row failed');
      report.pending = report.pending.filter((pending) => pending !== `${profile.name} installed-package acceptance`);
    }
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed';
    report.error = { code: 'COMPATIBILITY_ACCEPTANCE_FAILED', stage };
    report.commandFailure = failureProcess(error);
    report.diagnosis = failureDiagnosis(error, candidate?.schemas);
  } finally {
    report.endedAt = new Date().toISOString();
    await saveJson(join(output, 'report.json'), report);
  }
  return report;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const report = await compatibilitySmoke(compatibilitySelection(process.argv.slice(2)));
    process.stdout.write(JSON.stringify(compatibilitySummary(report)) + '\n');
    if (report.status !== 'passed') process.exitCode = 1;
  } catch {
    process.stderr.write(usage + '\n');
    process.exitCode = 2;
  }
}
