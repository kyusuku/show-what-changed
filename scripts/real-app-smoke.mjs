#!/usr/bin/env node
import assert from 'node:assert/strict';
import { copyFile, cp, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createPublicWebApp } from './create-public-web-app.mjs';
import { command, hash, installCandidate, saveJson, sourceState, verifyArtifacts } from './release-harness.mjs';

const [tarballArgument, outputArgument] = process.argv.slice(2);
assert(tarballArgument && outputArgument && process.argv.length === 4, 'Usage: node scripts/real-app-smoke.mjs candidate.tgz output-directory');
const output = resolve(outputArgument);
await mkdir(output, { recursive: true });
const root = await realpath(await mkdtemp(join(tmpdir(), 'swc-public-app-')));
const report = {
  status: 'running', scope: 'installed-public-workspace-app', startedAt: new Date().toISOString(),
  platform: process.platform, arch: process.arch, node: process.version, root, runs: [],
  acceptanceComplete: false, pendingAcceptance: ['Independent inner-scroll observation', 'Decoded media and normal-speed visual review'],
  limitations: ['Self-authored MIT public example with local synthetic data.', 'No external providers, accounts, hosted authentication, or production services are exercised.'],
};
try {
  const candidate = await installCandidate(resolve(tarballArgument), root, output);
  report.candidate = { sha256: candidate.sha256, bytes: candidate.bytes };
  const fixture = createPublicWebApp(join(root, 'app'));
  report.fixture = fixture;
  const config = candidate.schemas.ConfigSchema.parse(JSON.parse(await readFile(fixture.configPath, 'utf8')));
  assert.equal(config.capture.mode, 'motion');
  assert.deepEqual(config.capture.viewport, { width: 390, height: 844 });
  const inputPaths = { config: fixture.configPath, ...fixture.scenarios };
  report.inputs = Object.fromEntries(await Promise.all(Object.entries(inputPaths).map(async ([name, path]) => [name, { path, sha256: hash(await readFile(path)) }])));
  await candidate.cli('doctor', ['doctor'], candidate.installRoot, 0);
  await command(['pnpm', 'install', '--frozen-lockfile', '--offline', '--ignore-scripts'], fixture.repoRoot, { expectedCode: 0 });
  await writeFile(join(fixture.repoRoot, 'node_modules/caller-sentinel.txt'), 'Keep existing caller dependencies and workspace links unchanged.\n');
  const original = await sourceState(fixture.repoRoot);
  assert(original.disk.some((entry) => entry.kind === 'symlink' && entry.path.startsWith('apps/web/node_modules/')), 'Caller workspace links must exist before preservation checks');
  assert(original.disk.some((entry) => entry.kind === 'file' && entry.path === 'node_modules/caller-sentinel.txt'));
  const selection = ['--base', fixture.baseCommit, '--head', fixture.headCommit, '--config', fixture.configPath];
  const captureRun = async (name, args, source) => {
    const envelope = await candidate.cli(name, ['compare', ...args, '--allow-exec'], fixture.repoRoot, 0);
    const run = await verifyArtifacts(fixture.repoRoot, envelope, candidate.schemas);
    assert.equal(run.manifest.captureMode, 'motion');
    assert.equal(run.manifest.summary.failedSteps, 0);
    assert(run.manifest.summary.verifiedPairs > 0);
    const capture = candidate.schemas.CaptureBundleSchema.parse(JSON.parse(await readFile(join(run.runDir, 'capture.json'), 'utf8')));
    for (const motion of capture.motion) for (const side of ['before', 'after']) {
      assert.equal(motion.tracks[side].status, 'ok');
      assert(motion.tracks[side].frames.length > 1, 'A motion run must retain multiple source frames');
    }
    assert.deepEqual(await sourceState(fixture.repoRoot), source);
    const destination = join(output, name);
    await mkdir(destination, { recursive: true });
    for (const filename of ['manifest.json', 'capture.json', 'timeline.json', 'compare.mp4', 'poster.png', 'pr.md']) await copyFile(join(run.runDir, filename), join(destination, filename));
    for (const directory of ['frames', 'composed']) await cp(join(run.runDir, directory), join(destination, directory), { recursive: true });
    report.runs.push({ name, runId: run.manifest.runId, summary: run.manifest.summary, comparison: run.manifest.comparisonOutcome, video: run.manifest.artifacts.video, poster: run.manifest.artifacts.poster, captureQuality: run.manifest.captureQuality });
    return run;
  };
  for (const [flow, scenarioPath] of Object.entries(fixture.scenarios)) {
    candidate.schemas.ScenarioSchema.parse(JSON.parse(await readFile(scenarioPath, 'utf8')));
    const planned = await candidate.cli(`plan-${flow}`, ['plan', ...selection, '--scenario', scenarioPath], fixture.repoRoot, 0);
    assert.equal(planned.data.baseCommit, fixture.baseCommit);
    assert.equal(planned.data.headCommit, fixture.headCommit);
  }
  for (let index = 0; index < 3; index++) for (const [flow, scenarioPath] of Object.entries(fixture.scenarios)) {
    const run = await captureRun(`${flow}-${index + 1}`, [...selection, '--scenario', scenarioPath], original);
    if (flow === 'validation') {
      const checkpoint = run.manifest.scenarios[0].steps.find((step) => step.id === 'validation-feedback');
      assert(checkpoint && checkpoint.before.status === 'ok' && checkpoint.after.status === 'ok');
      assert(checkpoint.changeRatio > 0, 'Actual validation feedback must visibly differ');
    }
  }
  const priorFeedback = await readFile(fixture.feedbackPath, 'utf8');
  assert(priorFeedback.includes(fixture.worktreeReplacement.from));
  await writeFile(fixture.feedbackPath, priorFeedback.replace(fixture.worktreeReplacement.from, fixture.worktreeReplacement.to));
  const edited = await sourceState(fixture.repoRoot);
  const worktree = await captureRun('validation-worktree', ['--base', fixture.headCommit, '--head', 'WORKTREE', '--config', fixture.configPath, '--scenario', fixture.scenarios.validation], edited);
  assert.equal(worktree.manifest.sources.after.kind, 'worktree');
  assert(worktree.manifest.summary.changedPairs > 0);
  report.repeatCommands = Object.fromEntries(Object.entries(fixture.scenarios).map(([flow, scenario]) => [flow, [candidate.binary, 'compare', ...selection, '--scenario', scenario, '--allow-exec', '--json']]));
  report.commands = candidate.commands;
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = { message: error.message, stack: error.stack, command: error.result };
  process.exitCode = 1;
} finally {
  report.endedAt = new Date().toISOString();
  await saveJson(join(output, 'report.json'), report);
  process.stdout.write(JSON.stringify({ status: report.status, acceptanceComplete: false, report: join(output, 'report.json'), root }) + '\n');
}
