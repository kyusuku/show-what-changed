import { execFileSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { compatibilityProfiles, compatibilitySelection, compatibilitySmoke, compatibilitySummary, prepareCompatibilityFixture, runCompatibilityRow } from '../../scripts/compatibility-smoke.mjs';
import { assertNoOwnedActivity, command, hash, sourceState, verifyArtifacts } from '../../scripts/release-harness.mjs';
import { gitEnvironment } from '../../scripts/git-env.mjs';
import { ResultSchema } from '../../src/schema/index.js';

const docker = compatibilityProfiles.find((profile) => profile.name === 'docker');
const runId = '20261103T010203004Z-0123456789abcdef';
const digest = 'a'.repeat(64);
const roots = [];

async function temporary(run) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'swc-compatibility-test-')));
  try { await run(root); }
  finally {
    await rm(root, { recursive: true, force: true });
    for (const owned of roots.splice(0)) await rm(owned, { recursive: true, force: true });
  }
}

function fakeCandidate(options = {}) {
  const state = { environments: [] };
  const candidate = {
    schemas: { ResultSchema }, installRoot: '', sha256: digest, bytes: 1234,
    cli: vi.fn(async (name, args, repo, code, env = {}) => {
      state.environments.push(env);
      if (name === 'doctor') return { exitCode: 0, data: { capabilities: [{ name: 'docker', available: options.dockerAvailable !== false, version: '29.0.0' }, { name: 'buildx', available: true, version: '0.30.0' }] } };
      if (args[0] === 'plan') {
        return { exitCode: 0, data: { baseCommit: args[2], headCommit: args[4], headKind: 'commit', execution: { environmentReferences: Object.keys(env) }, planId: digest, configDigest: digest, scenarioDigest: digest, sourceStats: {} } };
      }
      const runDir = join(repo, '.show-what-changed/runs', runId);
      state.runDir = runDir;
      await mkdir(join(runDir, 'frames'), { recursive: true });
      await mkdir(join(runDir, 'composed'), { recursive: true });
      const video = Buffer.from('Mock media is not real acceptance.');
      const side = (identity) => ({ kind: 'container', services: [{ id: 'db', kind: 'container', identity }] });
      const manifest = {
        runId, captureMode: 'motion', summary: { verifiedPairs: 2, changedPairs: 1 },
        execution: { before: side('b'.repeat(64)), after: side('c'.repeat(64)) },
        versions: { node: 'v24.0.0', browser: '142.0.0', ffmpeg: '8.0', ffprobe: '8.0' },
        artifacts: { video: { path: 'compare.mp4', sha256: hash(video), bytes: video.length } },
      };
      state.run = { runDir, manifest };
      await writeFile(join(runDir, 'manifest.json'), JSON.stringify(manifest));
      await writeFile(join(runDir, 'compare.mp4'), video);
      if (options.mutateCaller) await writeFile(join(repo, 'caller-state.txt'), 'Unexpected caller mutation.\n');
      if (options.compareFailure) throw options.compareFailure;
      if (options.compareError) throw Object.assign(new Error(`${repo} ${env.SWC_FIXTURE_DB_PASSWORD} ${env.SWC_FIXTURE_LOG_CANARY}`), { result: { code: 6, timedOut: false, stderr: repo } });
      return { exitCode: code, data: manifest };
    }),
  };
  const checks = {
    verifyArtifacts: vi.fn(async (_repo, _envelope, _schemas, canaries) => {
      state.canaries = canaries;
      if (options.artifactError) throw new Error(`${state.runDir} ${canaries.join(' ')}`);
      return state.run;
    }),
    assertNoOwnedActivity: vi.fn(async () => {
      if (options.cleanupError) throw new Error('Private cleanup response must remain private.');
      return { processLedgers: options.processLedgers ?? 2, dockerIdentities: options.dockerIdentities ?? 12 };
    }),
  };
  return { candidate, checks, state };
}

test('default, combined, and Docker-only modes select the declared matrix and reject ambiguous options', () => {
  expect(compatibilitySelection(['candidate.tgz', 'output']).profiles.map(({ name }) => name)).toEqual(['static', 'npm', 'pnpm', 'python']);
  expect(compatibilitySelection(['--docker', 'candidate.tgz', 'output']).profiles.map(({ name }) => name)).toEqual(['static', 'npm', 'pnpm', 'python', 'docker']);
  expect(compatibilitySelection(['candidate.tgz', 'output', '--docker-only']).profiles.map(({ name }) => name)).toEqual(['docker']);
  for (const args of [[], ['candidate.tgz'], ['--unknown', 'candidate.tgz', 'output'], ['--docker', '--docker-only', 'candidate.tgz', 'output'], ['--docker', '--docker', 'candidate.tgz', 'output'], ['candidate.tgz', 'output', 'extra']]) expect(() => compatibilitySelection(args)).toThrow('Usage:');
});

test('Docker source preparation commits exactly the reviewed visible change and leaves caller preservation inputs', async () => {
  await temporary(async (root) => {
    const fixture = await prepareCompatibilityFixture(docker, root);
    const git = (...args) => execFileSync('git', args, { cwd: fixture.repo, env: gitEnvironment(), encoding: 'utf8' });
    expect(git('diff', '--name-only', fixture.base, fixture.head).trim()).toBe('index.html');
    expect(git('show', `${fixture.base}:index.html`)).toContain('<h1>Container source</h1>');
    expect(git('show', `${fixture.head}:index.html`)).toContain('<h1>Updated container source</h1>');
    expect(git('status', '--porcelain')).toContain('MM caller-state.txt');
    expect(git('status', '--porcelain')).toContain('?? caller-untracked.txt');
    expect(await readFile(join(fixture.repo, 'node_modules/caller-sentinel.txt'), 'utf8')).toContain('Preserve existing');
    expect(fixture.sourceChange).toEqual({ path: 'index.html', beforeSha256: hash(git('show', `${fixture.base}:index.html`)), afterSha256: hash(git('show', `${fixture.head}:index.html`)) });
  });
});

test('the Docker row passes synthetic-only canaries through the installed CLI and artifact verifier, preserves caller state, and exports public evidence', async () => {
  await temporary(async (root) => {
    const fixture = await prepareCompatibilityFixture(docker, root);
    const before = await sourceState(fixture.repo);
    const { candidate, checks, state } = fakeCandidate();
    const output = join(root, 'evidence');
    const row = await runCompatibilityRow(docker, fixture, candidate, output, checks);
    expect(row.status).toBe('passed');
    expect(row.artifactRedaction).toBe('passed');
    expect(state.environments).toHaveLength(2);
    expect(state.environments[1]).toEqual(state.environments[0]);
    expect(state.environments[0]).toEqual({ SWC_FIXTURE_DB_PASSWORD: expect.stringMatching(/^SYNTHETIC_DB_[a-f0-9]{32}$/), SWC_FIXTURE_LOG_CANARY: expect.stringMatching(/^SYNTHETIC_LOG_[a-f0-9]{32}$/) });
    expect(state.canaries).toEqual(Object.values(state.environments[0]));
    expect(checks.assertNoOwnedActivity).toHaveBeenCalledWith(state.runDir);
    expect(row.cleanup).toEqual({ status: 'ok', runs: [{ runId, processLedgers: 2, dockerIdentities: 12, workspacesAbsent: true }] });
    expect(row.callerPreserved).toBe(true);
    expect(await sourceState(fixture.repo)).toEqual(before);
    expect(row.commands.map(({ argv, actualExit }) => ({ argv: argv.slice(0, 2), actualExit }))).toEqual([{ argv: ['show-what-changed', 'plan'], actualExit: 0 }, { argv: ['show-what-changed', 'compare'], actualExit: 0 }]);
    expect(row.commands[0].cwd).toBe('docker');
    expect(row.commands[0].argv).toContain('../docker.scenario.json');
    const publicText = JSON.stringify(row) + await readFile(join(output, 'docker/manifest.json'), 'utf8');
    expect(publicText).not.toContain(root);
    for (const canary of state.canaries) expect(publicText).not.toContain(canary);
    expect(row.artifacts.video.path).toBe('docker/compare.mp4');
    expect(hash(await readFile(join(output, row.artifacts.video.path)))).toBe(row.artifacts.video.sha256);
    expect(await readdir(join(output, 'docker'))).toEqual(['compare.mp4', 'composed', 'frames', 'manifest.json']);
  });
});

test.each([{ compareError: true, stage: 'compare' }, { artifactError: true, stage: 'artifacts' }])('independent cleanup and preservation still run after a failure at $stage without exposing the raw error', async (options) => {
  await temporary(async (root) => {
    const fixture = await prepareCompatibilityFixture(docker, root);
    const { candidate, checks, state } = fakeCandidate(options);
    const output = join(root, 'evidence');
    const row = await runCompatibilityRow(docker, fixture, candidate, output, checks);
    expect(row.status).toBe('failed');
    expect(row.error).toEqual({ code: 'COMPATIBILITY_ROW_FAILED', stage: options.stage });
    expect(row.cleanup.status).toBe('ok');
    expect(row.callerPreserved).toBe(true);
    expect(checks.assertNoOwnedActivity).toHaveBeenCalledWith(state.runDir);
    expect(JSON.stringify(row)).not.toContain(root);
    for (const canary of Object.values(state.environments[0])) expect(JSON.stringify(row)).not.toContain(canary);
    await expect(access(output)).rejects.toMatchObject({ code: 'ENOENT' });
    if (options.compareError) expect(row.commands.at(-1).actualExit).toBe(6);
  });
});

test('a failed command retains validated error identifiers in its row and CLI summary without exposing private output', async () => {
  await temporary(async (root) => {
    const fixture = await prepareCompatibilityFixture(docker, root);
    const privateText = `${root} https://private.example/SECRET_ONLY SECRET_ONLY`;
    const envelope = ResultSchema.parse({ schemaVersion: 2, command: 'compare', status: 'failed', exitCode: 6, data: null, error: { code: 'PAGE_ERROR', phase: 'recording', message: privateText, hint: privateText, logPath: 'private/SECRET_ONLY.log' }, warnings: [] });
    let compareFailure;
    try {
      await command([process.execPath, '-e', 'process.stdout.write(process.argv[1]); process.stderr.write(process.argv[2]); process.exit(6)', JSON.stringify(envelope), privateText], root, { expectedCode: 0 });
    } catch (error) { compareFailure = error; }
    expect(compareFailure.result.code).toBe(6);
    const { candidate, checks } = fakeCandidate({ compareFailure });
    const row = await runCompatibilityRow(docker, fixture, candidate, join(root, 'evidence'), checks);
    expect(row.diagnosis).toEqual({ status: 'failed', exitCode: 6, code: 'PAGE_ERROR', phase: 'recording', errors: [] });
    const summary = compatibilitySummary({ status: 'failed', error: { code: 'COMPATIBILITY_ACCEPTANCE_FAILED', stage: 'comparison' }, rows: [row] });
    expect(summary.failedRows).toEqual([{ application: 'docker', stage: 'compare', code: 'COMPATIBILITY_ROW_FAILED', commands: [{ actualExit: 0, timedOut: false, overflow: false }, { actualExit: 6, timedOut: false, overflow: false }], diagnosis: row.diagnosis }]);
    for (const value of [root, 'SECRET_ONLY', 'private.example', 'stderr', 'message', 'hint', 'logPath']) expect(JSON.stringify(row) + JSON.stringify(summary)).not.toContain(value);
    expect(row.cleanup.status).toBe('ok');
    expect(row.callerPreserved).toBe(true);
  });
});

test.each(['malformed', 'invalid-schema', 'unsafe-identifiers', 'oversized-identifiers', 'mismatched-exit'])('failure diagnostics omit private or invalid command payloads for %s', async (kind) => {
  await temporary(async (root) => {
    const fixture = await prepareCompatibilityFixture(docker, root);
    const envelope = { schemaVersion: 2, command: 'compare', status: 'failed', exitCode: kind === 'mismatched-exit' ? 5 : 6, data: null, error: { code: kind === 'unsafe-identifiers' ? `PRIVATE_ONLY/${root}` : 'PAGE_ERROR', phase: kind === 'unsafe-identifiers' ? 'https://PRIVATE_ONLY.example' : 'recording', message: root, hint: 'PRIVATE_ONLY' }, warnings: [] };
    if (kind === 'invalid-schema') envelope.status = 'PRIVATE_ONLY';
    if (kind === 'oversized-identifiers') { envelope.error.code = 'P'.repeat(81); envelope.error.phase = 'p'.repeat(41); }
    const stdout = kind === 'malformed' ? `PRIVATE_ONLY ${root}` : JSON.stringify(envelope);
    const compareFailure = Object.assign(new Error(`PRIVATE_ONLY ${root}`), { result: { code: 6, timedOut: true, overflow: true, stdout, stderr: `PRIVATE_ONLY ${root}` } });
    const { candidate, checks } = fakeCandidate({ compareFailure });
    const row = await runCompatibilityRow(docker, fixture, candidate, join(root, 'evidence'), checks);
    expect(row.diagnosis).toEqual(['unsafe-identifiers', 'oversized-identifiers'].includes(kind) ? { status: 'failed', exitCode: 6, code: null, phase: null, errors: [] } : null);
    expect(row.commands.at(-1)).toMatchObject({ actualExit: 6, timedOut: true, overflow: true });
    const summary = compatibilitySummary({ status: 'failed', error: { code: 'COMPATIBILITY_ACCEPTANCE_FAILED', stage: 'comparison' }, rows: [row] });
    expect(JSON.stringify(row) + JSON.stringify(summary)).not.toContain(root);
    expect(JSON.stringify(row) + JSON.stringify(summary)).not.toContain('PRIVATE_ONLY');
  });
});

test('validated manifest error identifiers are bounded to eight entries without exposing their private guidance', async () => {
  await temporary(async (root) => {
    const fixture = await prepareCompatibilityFixture(docker, root);
    const detail = { code: 'PAGE_ERROR', phase: 'recording', message: `PRIVATE_ONLY ${root}`, hint: 'https://PRIVATE_ONLY.example' };
    const provenance = { valid: false, actualHash: null, errors: [] };
    const data = {
      schemaVersion: 2, toolVersion: '0.1.2', specRevision: '0.3', runId, state: 'terminal', status: 'failed', exitCode: 6, captureMode: 'motion', startedAt: '2026-11-06T00:00:00.000Z', endedAt: null,
      sources: { before: { requested: 'main', commit: digest.slice(0, 40), kind: 'commit', materializedHash: null }, after: { requested: 'HEAD', commit: digest.slice(0, 40), kind: 'commit', materializedHash: null }, baseResolution: 'exact' },
      versions: { node: 'v24.22.2', browser: null, ffmpeg: null, ffprobe: null }, publicRecipeDigest: null, publicScenarioDigest: null, viewport: { width: 1280, height: 800, deviceScaleFactor: 1 }, dataParity: 'stateless-declared',
      coverage: { selected: [], omitted: [], unsupported: [], unresolved: [], complete: true }, execution: null, captureQuality: [], scenarios: [], summary: { verifiedPairs: 0, changedPairs: 0, expectedAbsences: 0, exclusions: 0, failedSteps: 0, blockedSteps: 0, coverageOmissions: 0 }, timeline: null,
      artifacts: { video: null, poster: null, capture: null, timeline: null, pr: null }, comparisonOutcome: { status: 'pending', capture: 'pending', coverage: 'explicit', provenance: { before: provenance, after: provenance } }, cleanupOutcome: { status: 'ok', errors: [] }, encodingOutcome: { status: 'pending', errors: [] }, warnings: [], errors: Array.from({ length: 12 }, () => detail), errorHistory: [], phaseTimings: {},
    };
    const envelope = ResultSchema.parse({ schemaVersion: 2, command: 'compare', status: 'failed', exitCode: 6, data, error: detail, warnings: [] });
    const compareFailure = Object.assign(new Error(root), { result: { code: 6, stdout: JSON.stringify(envelope) } });
    const { candidate, checks } = fakeCandidate({ compareFailure });
    const row = await runCompatibilityRow(docker, fixture, candidate, join(root, 'evidence'), checks);
    expect(row.diagnosis.errors).toEqual(Array.from({ length: 8 }, () => ({ code: 'PAGE_ERROR', phase: 'recording' })));
    expect(JSON.stringify(row)).not.toContain(root);
    expect(JSON.stringify(row)).not.toContain('PRIVATE_ONLY');
  });
});

test.each(['install', 'doctor'])('top-level %s failures retain their stage and process flags without guessing an exception cause', async (stage) => {
  await temporary(async (root) => {
    const { candidate, checks } = fakeCandidate();
    const envelope = ResultSchema.parse({ schemaVersion: 2, command: 'doctor', status: 'failed', exitCode: 8, data: null, error: { code: 'ENVIRONMENT_INCOMPLETE', phase: 'doctor', message: root, hint: 'PRIVATE_ONLY' }, warnings: [] });
    const commandError = Object.assign(new Error(root), { result: { code: 8, timedOut: true, overflow: false, stdout: JSON.stringify(envelope), stderr: 'PRIVATE_ONLY' } });
    if (stage === 'doctor') candidate.cli = vi.fn(async () => { throw commandError; });
    const selection = compatibilitySelection(['candidate.tgz', join(root, 'evidence')]);
    const report = await compatibilitySmoke(selection, { ...checks, installCandidate: async (_tarball, owned) => { roots.push(owned); if (stage === 'install') throw commandError; candidate.installRoot = owned; return candidate; } });
    expect(report.error).toEqual({ code: 'COMPATIBILITY_ACCEPTANCE_FAILED', stage });
    expect(report.commandFailure).toEqual({ actualExit: 8, timedOut: true, overflow: false });
    expect(report.diagnosis).toEqual(stage === 'doctor' ? { status: 'failed', exitCode: 8, code: 'ENVIRONMENT_INCOMPLETE', phase: 'doctor', errors: [] } : null);
    const summary = compatibilitySummary(report);
    expect(summary.failedRows).toEqual([]);
    expect(summary.error).toEqual(report.error);
    expect(summary.commandFailure).toEqual(report.commandFailure);
    expect(summary.diagnosis).toEqual(report.diagnosis);
    expect(JSON.stringify(summary)).not.toContain(root);
    expect(JSON.stringify(summary)).not.toContain('PRIVATE_ONLY');
  });
});

test.each([{ processLedgers: 1 }, { dockerIdentities: 0 }, { cleanupError: true }])('a missing independent Docker cleanup requirement cannot pass or export evidence', async (options) => {
  await temporary(async (root) => {
    const fixture = await prepareCompatibilityFixture(docker, root);
    const { candidate, checks } = fakeCandidate(options);
    const output = join(root, 'evidence');
    const row = await runCompatibilityRow(docker, fixture, candidate, output, checks);
    expect(row.status).toBe('failed');
    expect(row.cleanup.status).toBe('failed');
    expect(row.error).toEqual({ code: 'COMPATIBILITY_CLEANUP_FAILED', stage: 'cleanup' });
    expect(row.callerPreserved).toBe(true);
    await expect(access(output)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

test('caller mutation fails even if artifacts and independent cleanup pass', async () => {
  await temporary(async (root) => {
    const fixture = await prepareCompatibilityFixture(docker, root);
    const { candidate, checks } = fakeCandidate({ mutateCaller: true });
    const row = await runCompatibilityRow(docker, fixture, candidate, join(root, 'evidence'), checks);
    expect(row.status).toBe('failed');
    expect(row.callerPreserved).toBe(false);
    expect(row.error).toEqual({ code: 'COMPATIBILITY_CALLER_CHANGED', stage: 'preservation' });
    expect(row.cleanup.status).toBe('ok');
  });
});

test.each([null, 'SWC_FIXTURE_DB_PASSWORD', 'SWC_FIXTURE_LOG_CANARY'])('the actual artifact verifier and two-ledger cleanup handle public canary %s using exact mock Docker identities', async (leak) => {
  await temporary(async (root) => {
    const socket = join(root, 'engine.sock');
    const requests = [];
    const server = createServer((request, response) => { requests.push({ method: request.method, path: request.url }); response.writeHead(404); response.end('{}'); });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
    try {
      const fixture = await prepareCompatibilityFixture(docker, root);
      const { candidate, state } = fakeCandidate();
      const parse = (value) => value;
      candidate.schemas = { ResultSchema: { parse }, ManifestSchema: { parse }, CaptureBundleSchema: { parse }, TimelineSchema: { parse } };
      const cli = candidate.cli;
      candidate.cli = async (...args) => {
        const envelope = await cli(...args);
        if (args[1][0] !== 'compare') return envelope;
        const privateDir = join(state.runDir, 'private');
        await mkdir(join(privateDir, 'docker-cleanup'), { recursive: true });
        await writeFile(join(privateDir, 'processes.json'), '[]');
        await writeFile(join(privateDir, 'docker-cleanup/processes.json'), '[]');
        const resources = ['before', 'after'].map((side, index) => {
          const nonce = String(index + 1).repeat(32);
          return { kind: 'network', side, name: `swc-${side}-${nonce}`, id: String(index + 1).repeat(64), labels: { 'io.show-what-changed.run': runId, 'io.show-what-changed.side': side, 'io.show-what-changed.nonce': nonce } };
        });
        await writeFile(join(privateDir, 'docker.json'), JSON.stringify({ schemaVersion: 2, runId, endpoint: `unix://${socket}`, configRelative: 'docker-client', pendingCreates: [], resources }));
        Object.assign(state.run.manifest, { specRevision: '0.3', cleanupOutcome: { status: 'ok' }, comparisonOutcome: { provenance: { before: { valid: true }, after: { valid: true } } } });
        await writeFile(join(state.runDir, 'manifest.json'), JSON.stringify(state.run.manifest));
        await writeFile(join(state.runDir, 'capture.json'), JSON.stringify({ runId, captureMode: 'motion' }));
        await writeFile(join(state.runDir, 'timeline.json'), JSON.stringify({ runId, captureMode: 'motion', templateVersion: 2 }));
        await writeFile(join(state.runDir, 'pr.md'), leak ? args[4][leak] : 'Synthetic public result.');
        return envelope;
      };
      const output = join(root, 'evidence');
      const row = await runCompatibilityRow(docker, fixture, candidate, output, { verifyArtifacts, assertNoOwnedActivity });
      expect(row.status).toBe(leak ? 'failed' : 'passed');
      expect(row.cleanup).toEqual({ status: 'ok', runs: [{ runId, processLedgers: 2, dockerIdentities: 2, workspacesAbsent: true }] });
      expect(row.callerPreserved).toBe(true);
      expect(requests).toEqual(Array.from({ length: leak ? 1 : 2 }, () => [
        { method: 'GET', path: `/networks/${'1'.repeat(64)}` }, { method: 'GET', path: `/networks/${'2'.repeat(64)}` },
      ]).flat());
      for (const value of Object.values(state.environments[0])) expect(JSON.stringify(row)).not.toContain(value);
      if (leak) {
        expect(row.artifactRedaction).toBe('pending');
        expect(row.error).toEqual({ code: 'COMPATIBILITY_ROW_FAILED', stage: 'artifacts' });
        await expect(access(output)).rejects.toMatchObject({ code: 'ENOENT' });
      }
    } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  });
});

test.each(['host', 'docker-only', 'docker'])('mode %s records only its completed rows and never claims the full release gate', async (mode) => {
  await temporary(async (root) => {
    const { candidate, checks } = fakeCandidate();
    const output = join(root, 'evidence');
    const selection = compatibilitySelection([...(mode === 'host' ? [] : [`--${mode}`]), 'candidate.tgz', output]);
    const install = vi.fn(async (_tarball, owned, reportDir) => { roots.push(owned); expect(reportDir).toBe(join(owned, 'private-evidence')); candidate.installRoot = join(owned, 'installed'); return candidate; });
    const report = await compatibilitySmoke(selection, { ...checks, installCandidate: install });
    expect(report.status).toBe('passed');
    expect(compatibilitySummary(report)).toEqual({ status: 'passed', gateComplete: false, report: 'report.json' });
    expect(report.gateComplete).toBe(false);
    expect(report.releaseAcceptance).toContain('pending');
    expect(report.rows.map(({ application }) => application)).toEqual(selection.profiles.map(({ name }) => name));
    expect(report.pending).toEqual(mode === 'host' ? ['docker installed-package acceptance'] : mode === 'docker-only' ? ['static installed-package acceptance', 'npm installed-package acceptance', 'pnpm installed-package acceptance', 'python installed-package acceptance'] : []);
    expect(JSON.parse(await readFile(join(output, 'report.json'), 'utf8'))).toEqual(report);
    expect(await readdir(output)).not.toContain('install.json');
    expect(JSON.stringify(report)).not.toContain(root);
    for (const env of stateEnvironments(candidate)) for (const value of Object.values(env)) expect(JSON.stringify(report)).not.toContain(value);
  });
});

function stateEnvironments(candidate) { return candidate.cli.mock.calls.flatMap((call) => call[4] ? [call[4]] : []); }

test('Docker mode fails before any comparison when doctor cannot verify Docker', async () => {
  await temporary(async (root) => {
    const { candidate, checks } = fakeCandidate({ dockerAvailable: false });
    const selection = compatibilitySelection(['--docker-only', 'candidate.tgz', join(root, 'evidence')]);
    const report = await compatibilitySmoke(selection, { ...checks, installCandidate: async (_tarball, owned) => { roots.push(owned); candidate.installRoot = owned; return candidate; } });
    expect(report.status).toBe('failed');
    expect(report.error).toEqual({ code: 'COMPATIBILITY_ACCEPTANCE_FAILED', stage: 'doctor' });
    expect(report.rows).toEqual([]);
    expect(candidate.cli).toHaveBeenCalledTimes(1);
    expect(report.gateComplete).toBe(false);
  });
});
