import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { createWriteStream } from 'node:fs';
import { copyFile, cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { createHash } from 'node:crypto';

const project = '/home/pwuser/project';
const evidence = '/home/pwuser/gate-evidence';
await mkdir(project, { recursive: true });
await mkdir(evidence, { recursive: true });
const input = JSON.parse(await readFile('/tmp/swc-gate-input.json', 'utf8'));
const requiredStages = ['extract', 'environment', 'install', 'sandbox', 'typecheck', 'build', 'schema-check', 'unit', 'contracts', 'privacy-scanner', 'integration'];
if (input.mode === 'release') requiredStages.push('package-source-binding', 'package-smoke', 'installed-motion', 'host-compatibility', 'public-app', 'repeatability');
const report = { schemaVersion: 2, input, platform: `${process.platform}-${process.arch}`, startedAt: new Date().toISOString(), endedAt: null, status: 'running', platformChecksComplete: false, releaseGateComplete: false, pendingAcceptance: ['Independent final-candidate acceptance across G01 through G24'], requiredStages, stages: [] };
const persist = () => writeFile(join(evidence, 'result.json'), JSON.stringify(report, null, 2) + '\n');
async function resourceUsage() {
  const paths = {
    memoryCurrent: '/sys/fs/cgroup/memory.current', memoryPeak: '/sys/fs/cgroup/memory.peak',
    memoryMax: '/sys/fs/cgroup/memory.max', memoryEvents: '/sys/fs/cgroup/memory.events',
    cgroupMemoryPressure: '/sys/fs/cgroup/memory.pressure', cpuStat: '/sys/fs/cgroup/cpu.stat',
    hostMeminfo: '/proc/meminfo', hostMemoryPressure: '/proc/pressure/memory',
  };
  return { at: new Date().toISOString(), ...Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([name, path]) => [name, await readFile(path, 'utf8')])))};
}
async function stage(id, argv, cwd = project, env = {}) {
  const record = { id, argv, cwd, startedAt: new Date().toISOString(), endedAt: null, exitCode: null, signal: null, resourcesBefore: await resourceUsage() };
  report.stages.push(record);
  await persist();
  console.log(`START ${id}`);
  const stdout = createWriteStream(join(evidence, `${id}.stdout.log`));
  const stderr = createWriteStream(join(evidence, `${id}.stderr.log`));
  const child = spawn(argv[0], argv.slice(1), { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(stdout);
  child.stderr.pipe(stderr);
  await new Promise((resolve) => {
    child.once('error', (error) => { record.error = error.message; });
    child.once('close', (code, signal) => { record.exitCode = code; record.signal = signal; resolve(); });
  });
  await Promise.all([new Promise((resolve) => stdout.end(resolve)), new Promise((resolve) => stderr.end(resolve))]);
  record.resourcesAfter = await resourceUsage();
  const oomKills = (resources) => Number(/^oom_kill (\d+)$/m.exec(resources.memoryEvents)?.[1] ?? 0);
  record.oomKillDelta = oomKills(record.resourcesAfter) - oomKills(record.resourcesBefore);
  record.endedAt = new Date().toISOString();
  await persist();
  console.log(`END ${id} exit=${record.exitCode} signal=${record.signal}`);
  if (record.oomKillDelta > 0) throw new Error(`Stage ${id} lost ${record.oomKillDelta} processes to OOM. Inspect its resource snapshots before rerunning.`);
  return record.exitCode === 0 && record.signal === null;
}
try {
  const archive = await readFile('/tmp/swc-source.tar');
  if (createHash('sha256').update(archive).digest('hex') !== input.sourceArchiveSha256) throw new Error('Source archive digest mismatch.');
  if (!await stage('extract', ['tar', '-xf', '/tmp/swc-source.tar', '-C', project])) throw new Error('Source extraction failed.');
  await copyFile('/opt/swc-linux-packages.tsv', join(evidence, 'packages.tsv'));
  await stage('environment', ['sh', '-c', 'uname -a; cat /etc/os-release; node --version; npm --version; git --version; ffmpeg -version; ffprobe -version; lsof -v; ps -p $$ -o pid=,uid=,args=']);
  if (process.version !== 'v24.22.2') throw new Error('Node runtime pin mismatch.');
  if (!await stage('install', ['npm', 'ci', '--no-audit', '--no-fund'])) throw new Error('Dependency installation failed.');
  if (!await stage('sandbox', ['node', '/opt/swc-linux-gate/sandbox-probe.mjs', project, join(evidence, 'sandbox.json')])) throw new Error('Sandboxed browser prerequisite failed.');
  const scripts = JSON.parse(await readFile(join(project, 'package.json'), 'utf8')).scripts;
  const optionalChecks = ['lint', 'format:check'].filter((name) => name in scripts);
  requiredStages.push(...optionalChecks.map((name) => name.replace(':', '-')));
  for (const name of ['typecheck', 'build', 'schema:check', ...optionalChecks]) {
    if (!await stage(name.replace(':', '-'), ['npm', 'run', name])) throw new Error(`Required ${name} check failed. Tests were not started.`);
  }
  await stage('unit', ['npm', 'run', 'test:unit', '--', '--maxWorkers=1', '--reporter=verbose']);
  await stage('contracts', ['npm', 'run', 'test:contracts', '--', '--maxWorkers=1', '--reporter=verbose']);
  await stage('privacy-scanner', ['npm', 'run', 'test:privacy']);
  await stage('integration', ['npm', 'run', 'test:integration', '--', '--maxWorkers=1', '--no-file-parallelism', '--reporter=verbose']);
  if (input.mode === 'release') {
    const tarball = '/tmp/swc-candidate.tgz';
    const bytes = await readFile(tarball);
    if (createHash('sha256').update(bytes).digest('hex') !== input.tarballSha256) throw new Error('Candidate tarball digest mismatch.');
    if (!await stage('package-source-binding', ['node', 'scripts/verify-package-source.mjs', tarball, join(evidence, 'package-source-binding')])) throw new Error('Candidate package does not match the tested source.');
    if (!await stage('package-smoke', ['node', 'scripts/release-smoke.mjs', tarball, join(evidence, 'package-smoke')])) throw new Error('Installed package smoke failed. Motion verification was not started.');
    const smoke = JSON.parse(await readFile(join(evidence, 'package-smoke/report.json'), 'utf8'));
    assert.equal(smoke.status, 'passed', 'The installed package smoke report must pass before motion verification.');
    assert.equal(smoke.candidate?.sha256, input.tarballSha256, 'The installed package must match the supplied candidate tarball.');
    assert(typeof smoke.root === 'string' && isAbsolute(smoke.root), 'The installed package smoke report must identify its fresh installation.');
    if (!await stage('installed-motion', ['node', 'scripts/revision-0.3-motion-check.mjs', '--installed-root', join(smoke.root, 'installed/node_modules/show-what-changed'), '--output-dir', join(evidence, 'installed-motion')])) throw new Error('Installed motion verification failed.');
    const motion = JSON.parse(await readFile(join(evidence, 'installed-motion/motion-check.json'), 'utf8'));
    assert.equal(motion.status, 'numeric-passed', 'Installed motion numeric checks must pass.');
    assert.equal(motion.completeRepetitionMatrix, true, 'Installed motion must complete all required viewports and repetitions.');
    report.motionCheck = { report: 'installed-motion/motion-check.json', status: motion.status, completeRepetitionMatrix: motion.completeRepetitionMatrix, visualReview: motion.visualReview?.status };
    report.pendingAcceptance.push('Review each installed motion recording at normal playback speed.');
    await stage('host-compatibility', ['node', 'scripts/compatibility-smoke.mjs', tarball, join(evidence, 'host-compatibility')]);
    await stage('public-app', ['node', 'scripts/real-app-smoke.mjs', tarball, join(evidence, 'public-app')]);
    await stage('repeatability', ['node', 'scripts/repeatability.mjs', tarball, join(evidence, 'repeatability')]);
    for (const directory of ['host-compatibility', 'public-app']) {
      const child = JSON.parse(await readFile(join(evidence, directory, 'report.json'), 'utf8'));
      report.pendingAcceptance.push(...(child.pending ?? child.pendingAcceptance ?? []));
    }
  } else {
    report.unmetReleaseGates = ['Exact integrated release commit and candidate tarball were not supplied.', 'Installed-package and repeatability gates require --release.'];
  }
  report.status = requiredStages.every((id) => report.stages.some((record) => record.id === id && record.exitCode === 0 && record.signal === null)) && report.stages.every((record) => record.exitCode === 0 && record.signal === null) ? 'passed' : 'failed';
  report.platformChecksComplete = report.status === 'passed' && input.mode === 'release';
} catch (error) {
  report.status = 'failed';
  report.error = error.message;
  console.error(error.message);
} finally {
  try { await cp(join(project, 'evidence/artifacts'), join(evidence, 'test-artifacts'), { recursive: true }); }
  catch (error) { if (error.code !== 'ENOENT') { report.status = 'failed'; report.platformChecksComplete = false; report.artifactCopyError = error.message; } }
  report.notRunStages = requiredStages.filter((id) => !report.stages.some((record) => record.id === id));
  report.endedAt = new Date().toISOString();
  await persist();
}
process.exitCode = report.status === 'passed' ? 0 : 1;
