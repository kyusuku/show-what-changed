#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createPublicWebApp } from './create-public-web-app.mjs';
import { capturePublicAppRun } from './real-app-run.mjs';
import { command, hash, installCandidate, saveJson, sourceState } from './release-harness.mjs';

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
  report.commands = candidate.commands;
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
  await saveJson(join(output, 'caller-original.json'), original);
  report.callerBaselines = { original: { path: 'caller-original.json', sha256: hash(await readFile(join(output, 'caller-original.json'))) } };
  const selection = ['--base', fixture.baseCommit, '--head', fixture.headCommit, '--config', fixture.configPath];
  const captureRun = (name, flow, args, source) => capturePublicAppRun({ name, flow, args, source }, { candidate, fixture, output, report });
  for (const [flow, scenarioPath] of Object.entries(fixture.scenarios)) {
    candidate.schemas.ScenarioSchema.parse(JSON.parse(await readFile(scenarioPath, 'utf8')));
    const planned = await candidate.cli(`plan-${flow}`, ['plan', ...selection, '--scenario', scenarioPath], fixture.repoRoot, 0);
    assert.equal(planned.data.baseCommit, fixture.baseCommit);
    assert.equal(planned.data.headCommit, fixture.headCommit);
  }
  for (let index = 0; index < 3; index++) for (const [flow, scenarioPath] of Object.entries(fixture.scenarios)) {
    await captureRun(`${flow}-${index + 1}`, flow, [...selection, '--scenario', scenarioPath], original);
  }
  const priorFeedback = await readFile(fixture.feedbackPath, 'utf8');
  assert(priorFeedback.includes(fixture.worktreeReplacement.from));
  await writeFile(fixture.feedbackPath, priorFeedback.replace(fixture.worktreeReplacement.from, fixture.worktreeReplacement.to));
  const edited = await sourceState(fixture.repoRoot);
  await saveJson(join(output, 'caller-worktree.json'), edited);
  report.callerBaselines.worktree = { path: 'caller-worktree.json', sha256: hash(await readFile(join(output, 'caller-worktree.json'))) };
  await captureRun('validation-worktree', 'validation-worktree', ['--base', fixture.headCommit, '--head', 'WORKTREE', '--config', fixture.configPath, '--scenario', fixture.scenarios.validation], edited);
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
