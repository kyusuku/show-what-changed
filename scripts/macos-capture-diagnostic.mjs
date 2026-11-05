import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { arch, availableParallelism, cpus, freemem, loadavg, totalmem } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { executeCase, loadInstalled } from './revision-0.3-motion-check.mjs';

const [installedRoot, outputDir, archive] = process.argv.slice(2);
assert.equal(process.platform, 'darwin', 'This diagnostic samples native macOS processes.');
assert(/^v24\./.test(process.version), 'Use the published Node 24 runtime contract.');
assert([installedRoot, outputDir, archive].every(value => typeof value === 'string' && isAbsolute(value)));
await mkdir(outputDir, { mode: 0o700 });
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const archiveSha256 = sha256(await readFile(archive));
assert.equal(archiveSha256, '0ca52c4395e27c9282489375ffd5c1924c718f829d65818c2284c367cdb9ed31');
const api = await loadInstalled(installedRoot);
const report = {
  diagnosticOnly: true, releaseAcceptance: 'not-evaluated', status: 'incomplete',
  purpose: 'Locate guest CPU, process, I/O, and recorder-thread activity during one published desktop capture.',
  limitations: ['One profiled case cannot estimate reliability or a performance difference.', 'Guest counters cannot observe contention outside the VM.', 'Native sampling adds observer cost. No source cadence pass is release acceptance.'],
  originalCriteria: { sourceDistinctPositions: 60, knownMovingGapMs: 200, sourcePulseCount: 3, sourcePulseAlignmentMs: 80, clockErrorBoundMs: 40 },
  sourceCommit: process.env.GITHUB_SHA ?? null, archiveSha256, installedPackage: api.identity,
  host: { architecture: arch(), node: process.version, parallelism: availableParallelism(), cpuModels: [...new Set(cpus().map(cpu => cpu.model))], totalMemoryBytes: totalmem(), loadAverage: loadavg() },
  samplers: [], cpuSamples: [], capture: null,
};
const controller = new AbortController();
const interrupt = () => controller.abort(new Error('Diagnostic interrupted'));
process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
const samplers = [];
async function startSampler(name, executable, args, reportPath = null) {
  const path = join(outputDir, `${name}.txt`);
  const file = await open(path, 'wx', 0o600);
  const child = spawn(executable, args, { stdio: ['ignore', file.fd, file.fd] });
  const entry = { name, executable, args, startedEpochMs: Date.now(), pid: child.pid ?? null, error: null, code: null, signal: null, outputPath: path, reportPath };
  const finished = new Promise(resolve => {
    child.once('error', error => { entry.error = { code: error.code ?? null, message: error.message }; });
    child.once('close', (code, signal) => { Object.assign(entry, { code, signal, completedEpochMs: Date.now() }); resolve(); });
  });
  samplers.push({ child, entry, finished, file });
  report.samplers.push(entry);
}
function cpuSnapshot() {
  return { atMs: performance.now(), epochMs: Date.now(), cores: cpus().map(cpu => cpu.times), recorder: process.cpuUsage() };
}
let previous = cpuSnapshot();
function sampleCpu() {
  const current = cpuSnapshot();
  const elapsedMs = current.atMs - previous.atMs;
  const coreDeltas = current.cores.map((times, index) => {
    const prior = previous.cores[index];
    const deltas = Object.fromEntries(Object.entries(times).map(([key, value]) => [key, value - (prior?.[key] ?? value)]));
    const total = Object.values(deltas).reduce((sum, value) => sum + value, 0);
    return { busyPercent: total > 0 ? 100 * (total - deltas.idle) / total : null, timesMs: deltas };
  });
  report.cpuSamples.push({ startedMonotonicMs: previous.atMs, completedMonotonicMs: current.atMs, epochMs: current.epochMs, elapsedMs, coreDeltas, recorderCpuPercentOfOneCore: 100 * ((current.recorder.user - previous.recorder.user) + (current.recorder.system - previous.recorder.system)) / (elapsedMs * 1000), freeMemoryBytes: freemem() });
  previous = current;
}
const timer = setInterval(sampleCpu, 250);
try {
  await startSampler('top', '/usr/bin/top', ['-l', '60', '-s', '1', '-n', '12', '-o', 'cpu', '-stats', 'pid,command,cpu,threads,state,time']);
  await startSampler('iostat', '/usr/sbin/iostat', ['-d', '-w', '1', '-c', '60']);
  const profilePath = join(outputDir, 'recorder-native-sample.txt');
  await startSampler('sample-command', '/usr/bin/sample', [String(process.pid), '6', '10', '-file', profilePath], profilePath);
  const casesDir = join(outputDir, 'source-only');
  await mkdir(casesDir, { mode: 0o700 });
  const fixture = await readFile(new URL('../fixtures/motion/index.html', import.meta.url), 'utf8');
  report.capture = await executeCase(api, fixture, { width: 1280, height: 800 }, 1, casesDir, controller.signal, { captureOnly: true });
  report.status = 'completed';
} catch (error) {
  report.failure = { code: error.code ?? null, message: error.message };
  report.status = 'failed';
} finally {
  clearInterval(timer); sampleCpu();
  for (const sampler of samplers) if (sampler.entry.name !== 'sample-command') sampler.child.kill('SIGTERM');
  for (const sampler of samplers) {
    await sampler.finished;
    await sampler.file.close();
  }
  process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
  const range = report.capture?.captureCallTiming;
  report.captureCpuSamples = range ? report.cpuSamples.filter(sample => sample.completedMonotonicMs >= range.startedMonotonicMs && sample.startedMonotonicMs <= range.completedMonotonicMs) : [];
  report.samplerStatus = report.samplers.every(entry => !entry.error && (entry.code === 0 || entry.signal === 'SIGTERM') && (entry.name !== 'sample-command' || entry.code === 0)) ? 'completed' : 'failed';
  await writeFile(join(outputDir, 'diagnostic.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  process.stdout.write(JSON.stringify({ ...report, installedPackage: { ...report.installedPackage, packageFiles: undefined }, cpuSamples: undefined }) + '\n');
  for (const sampler of samplers) {
    for (const path of [sampler.entry.outputPath, sampler.entry.reportPath].filter(Boolean)) {
      try { process.stdout.write(`\nDiagnostic file ${path}\n${await readFile(path, 'utf8')}\n`); }
      catch (error) { process.stdout.write(JSON.stringify({ diagnosticFileUnavailable: path, code: error.code ?? null }) + '\n'); }
    }
  }
}
if (report.status !== 'completed' || report.capture?.status !== 'source-numeric-passed' || report.samplerStatus !== 'completed') process.exitCode = 1;
