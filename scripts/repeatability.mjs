#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { copyFile, cp, mkdir, mkdtemp, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFixture } from './create-fixture.mjs';
import { command, installCandidate, saveJson, sourceState, verifyArtifacts } from './release-harness.mjs';

const [tarballArgument, outputArgument] = process.argv.slice(2);
assert(tarballArgument && outputArgument && process.argv.length === 4, 'Usage: node scripts/repeatability.mjs candidate.tgz output-directory');
const output = resolve(outputArgument);
await mkdir(output, { recursive: true });
const root = await realpath(await mkdtemp(join(tmpdir(), 'swc-repeatability-')));
const report = { status: 'running', scope: 'explicit-keyframes-repeatability', motionAcceptance: false, startedAt: new Date().toISOString(), platform: process.platform, arch: process.arch, node: process.version, root, sourceFrameComparisons: [], encodedFrameComparisons: [] };
const meanError = (left, right) => {
  assert.equal(left.width, right.width); assert.equal(left.height, right.height);
  let sum = 0;
  for (let index = 0; index < left.data.length; index += 4) for (let channel = 0; channel < 3; channel++) sum += Math.abs(left.data[index + channel] - right.data[index + channel]);
  return sum / (left.width * left.height * 3);
};
try {
  const candidate = await installCandidate(resolve(tarballArgument), root, output);
  report.candidate = { path: candidate.tarball, sha256: candidate.sha256 };
  const require = createRequire(join(candidate.packageRoot, 'package.json'));
  const { PNG } = require('pngjs');
  const { default: pixelmatch } = await import(pathToFileURL(require.resolve('pixelmatch')).href);
  const fixture = createFixture(join(root, 'app'));
  report.fixture = fixture;
  const scenario = join(root, 'pricing.scenario.json');
  await copyFile(new URL('../test/fixtures/scenarios/pricing.scenario.json', import.meta.url), scenario);
  const original = await sourceState(fixture.repoRoot);
  const runs = [];
  for (let index = 0; index < 2; index++) {
    const envelope = await candidate.cli(`compare-${index + 1}`, ['compare', '--base', fixture.baseCommit, '--head', fixture.headCommit, '--scenario', scenario, '--allow-exec'], fixture.repoRoot, 0);
    const run = await verifyArtifacts(fixture.repoRoot, envelope, candidate.schemas);
    assert.equal(run.manifest.captureMode, 'keyframes');
    assert.deepEqual(await sourceState(fixture.repoRoot), original);
    const destination = join(output, `run-${index + 1}`);
    await mkdir(destination, { recursive: true });
    for (const file of ['capture.json', 'timeline.json', 'manifest.json', 'compare.mp4', 'poster.png']) await copyFile(join(run.runDir, file), join(destination, file));
    for (const directory of ['frames', 'composed']) await cp(join(run.runDir, directory), join(destination, directory), { recursive: true });
    runs.push({ directory: destination, capture: JSON.parse(await readFile(join(destination, 'capture.json'), 'utf8')), timeline: JSON.parse(await readFile(join(destination, 'timeline.json'), 'utf8')) });
  }
  assert.deepEqual(runs[0].timeline.segments, runs[1].timeline.segments);
  for (let scenarioIndex = 0; scenarioIndex < runs[0].capture.scenarios.length; scenarioIndex++) {
    const first = runs[0].capture.scenarios[scenarioIndex];
    const second = runs[1].capture.scenarios[scenarioIndex];
    assert.equal(first.id, second.id);
    for (let stepIndex = 0; stepIndex < first.steps.length; stepIndex++) for (const side of ['before', 'after']) {
      const a = first.steps[stepIndex][side];
      const b = second.steps[stepIndex][side];
      assert.equal(a.status, b.status);
      const left = PNG.sync.read(await readFile(join(runs[0].directory, a.image.path)));
      const right = PNG.sync.read(await readFile(join(runs[1].directory, b.image.path)));
      const ratio = pixelmatch(left.data, right.data, null, left.width, left.height, { threshold: 0.1, includeAA: false }) / (left.width * left.height);
      report.sourceFrameComparisons.push({ scenarioId: first.id, stepId: first.steps[stepIndex].id, side, ratio });
      assert(ratio <= 0.001, `Unstable masked frame ${first.id}/${first.steps[stepIndex].id}/${side}: ${ratio}`);
    }
  }
  const frames = [...new Set([0, ...runs[0].timeline.segments.flatMap((segment) => [segment.startFrame, segment.startFrame + segment.durationFrames - 1])])];
  for (const frame of frames) {
    const extracted = [];
    for (const run of runs) {
      const outputPath = join(run.directory, `encoded-${frame}.png`);
      await command([process.env.SWC_FFMPEG ?? 'ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', join(run.directory, 'compare.mp4'), '-vf', `select=eq(n\\,${frame})`, '-fps_mode', 'vfr', '-frames:v', '1', outputPath], root, { expectedCode: 0 });
      const image = PNG.sync.read(await readFile(outputPath));
      const segment = run.timeline.segments.find((segment) => frame >= segment.startFrame && frame < segment.startFrame + segment.durationFrames);
      const expected = PNG.sync.read(await readFile(join(run.directory, segment.image)));
      const error = meanError(image, expected);
      assert(error < 3, `Encoded frame ${frame} differs from its scheduled PNG: ${error}`);
      extracted.push({ image, error });
    }
    const betweenRuns = meanError(extracted[0].image, extracted[1].image);
    report.encodedFrameComparisons.push({ frame, againstSource: extracted.map((entry) => entry.error), betweenRuns });
    assert(betweenRuns < 3, `Encoded frame ${frame} is not repeatable within lossy tolerance: ${betweenRuns}`);
  }
  report.commands = candidate.commands;
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = { message: error.message, stack: error.stack, command: error.result };
  process.exitCode = 1;
} finally {
  report.endedAt = new Date().toISOString();
  await saveJson(join(output, 'report.json'), report);
  process.stdout.write(JSON.stringify({ status: report.status, report: join(output, 'report.json'), root }) + '\n');
}
