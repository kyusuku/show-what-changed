import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, lstat, mkdir, readFile, readdir, readlink, realpath, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gitEnvironment } from './git-env.mjs';
import { assertNoDockerResidue } from './verify-docker-residue.mjs';

export const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
export async function saveJson(path, value) {
  await mkdir(resolve(path, '..'), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
}
export function command(argv, cwd, options = {}) {
  return new Promise((resolveResult, reject) => {
    const started = performance.now();
    const env = basename(argv[0]) === 'git' ? gitEnvironment(options.env) : { ...process.env, ...options.env };
    const child = spawn(argv[0], argv.slice(1), { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const output = { stdout: [], stderr: [] };
    let bytes = 0;
    let overflow = false;
    let timedOut = false;
    let killTimer;
    const stop = () => {
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 12_000);
      killTimer.unref();
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, options.timeoutMs ?? 900_000);
    for (const stream of ['stdout', 'stderr']) child[stream].on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > 16 * 1024 * 1024) { if (!overflow) stop(); overflow = true; }
      else output[stream].push(chunk);
    });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer); if (killTimer) clearTimeout(killTimer);
      const result = { argv, cwd, code, signal, timedOut, overflow, elapsedMs: performance.now() - started, stdout: Buffer.concat(output.stdout).toString('utf8'), stderr: Buffer.concat(output.stderr).toString('utf8') };
      if (options.expectedCode !== undefined && code !== options.expectedCode || overflow || timedOut) reject(Object.assign(new Error(`Command failed: ${argv[0]} (exit ${code}, signal ${signal})\n${result.stderr.slice(-4000)}`), { result }));
      else resolveResult(result);
    });
  });
}
async function privateCommand(argv, cwd, options, path) {
  let result;
  let failure;
  try { result = await command(argv, cwd, options); }
  catch (error) { failure = error; result = error.result; }
  if (result) {
    try { await saveJson(path, result); }
    catch (error) {
      if (failure) failure.evidenceError = error;
      else failure = Object.assign(error, { validationStage: 'evidence' });
    }
  }
  if (failure) throw Object.assign(failure, { result, commandName: basename(path, '.json'), validationStage: failure.validationStage ?? 'process' });
  return result;
}
export async function sourceState(repoRoot) {
  const git = async (...args) => (await command(['git', ...args], repoRoot, { expectedCode: 0 })).stdout;
  const paths = [...new Set((await git('ls-files', '-z', '--cached', '--others', '--exclude-standard')).split('\0').filter(Boolean))].sort();
  const files = [];
  for (const path of paths) {
    const absolute = join(repoRoot, path);
    try {
      const info = await lstat(absolute);
      assert(info.isFile(), `Unexpected source kind ${path}`);
      files.push({ path, executable: Boolean(info.mode & 0o111), sha256: hash(await readFile(absolute)) });
    } catch (error) { if (error.code === 'ENOENT') files.push({ path, deleted: true }); else throw error; }
  }
  const disk = [];
  const visit = async (directory, prefix = '') => {
    for (const name of (await readdir(directory)).sort()) {
      if (prefix === '' && ['.git', '.show-what-changed'].includes(name)) continue;
      const path = prefix + name;
      const absolute = join(directory, name);
      const info = await lstat(absolute);
      const mode = info.mode & 0o777;
      if (info.isSymbolicLink()) disk.push({ path, mode, kind: 'symlink', target: await readlink(absolute) });
      else if (info.isDirectory()) { disk.push({ path, mode, kind: 'directory' }); await visit(absolute, path + '/'); }
      else { assert(info.isFile(), `Unexpected caller file kind ${path}`); disk.push({ path, mode, kind: 'file', sha256: hash(await readFile(absolute)) }); }
    }
  };
  await visit(repoRoot);
  return { head: (await git('rev-parse', 'HEAD')).trim(), indexSha256: hash(await readFile(join(repoRoot, '.git', 'index'))), files, disk, worktrees: await git('worktree', 'list', '--porcelain') };
}
export async function assertNoOwnedActivity(runDir) {
  const groups = JSON.parse(await readFile(join(runDir, 'private/processes.json'), 'utf8'));
  let processLedgers = 1;
  try {
    groups.push(...JSON.parse(await readFile(join(runDir, 'private/docker-cleanup/processes.json'), 'utf8')));
    processLedgers++;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const table = (await command(['ps', '-axo', 'pid=,pgid=,stat='], runDir, { expectedCode: 0 })).stdout;
  const live = table.split('\n').map((line) => line.trim().split(/\s+/)).filter((row) => row.length === 3 && !row[2].startsWith('Z'));
  for (const process of groups) assert(!live.some((row) => Number(row[1]) === process.group), `Owned group ${process.group} remains alive`);
  const output = resolve(runDir, '../..');
  await assert.rejects(access(join(output, 'run.lock')), { code: 'ENOENT' });
  const docker = await assertNoDockerResidue(runDir, basename(runDir));
  return { processLedgers, dockerIdentities: docker.checkedResources };
}
export async function verifyArtifacts(repoRoot, envelope, schemas, sensitiveValues = []) {
  schemas.ResultSchema.parse(envelope);
  const manifest = schemas.ManifestSchema.parse(envelope.data);
  const runDir = join(repoRoot, '.show-what-changed/runs', manifest.runId);
  assert.deepEqual(JSON.parse(await readFile(join(runDir, 'manifest.json'), 'utf8')), manifest);
  for (const artifact of Object.values(manifest.artifacts)) {
    if (!artifact) continue;
    const path = resolve(runDir, artifact.path);
    assert(path.startsWith(runDir + '/'));
    const bytes = await readFile(path);
    assert.equal(bytes.length, artifact.bytes);
    assert.equal(hash(bytes), artifact.sha256);
  }
  assert.equal(manifest.cleanupOutcome.status, 'ok');
  assert.equal(manifest.comparisonOutcome.provenance.before.valid, true);
  assert.equal(manifest.comparisonOutcome.provenance.after.valid, true);
  const capture = schemas.CaptureBundleSchema.parse(JSON.parse(await readFile(join(runDir, 'capture.json'), 'utf8')));
  const timeline = schemas.TimelineSchema.parse(JSON.parse(await readFile(join(runDir, 'timeline.json'), 'utf8')));
  assert.equal(manifest.specRevision, '0.3');
  assert.equal(capture.runId, manifest.runId);
  assert.equal(timeline.runId, manifest.runId);
  assert.equal(capture.captureMode, manifest.captureMode);
  assert.equal(timeline.captureMode, manifest.captureMode);
  assert.equal(timeline.templateVersion, 2);
  const publicText = (await Promise.all(['manifest.json', 'pr.md', 'capture.json', 'timeline.json'].map((file) => readFile(join(runDir, file), 'utf8')))).join('\n');
  const forbidden = [repoRoot, 'SYNTHETIC_SECRET_DO_NOT_SHARE_9f8b7c6d', 'PRIVATE-FILL-123', ...sensitiveValues];
  for (let index = 0; index < forbidden.length; index++) assert(!forbidden[index] || !publicText.includes(forbidden[index]), `Known private input appeared in public output, rule ${index}`);
  const cleanupVerification = await assertNoOwnedActivity(runDir);
  return { runDir, manifest, cleanupVerification };
}
export async function installCandidate(tarball, root, reportDir) {
  assert.match(process.version, /^v24\./);
  tarball = await realpath(tarball);
  const bytes = await readFile(tarball);
  const listing = (await privateCommand(['tar', '-tzf', tarball], root, { expectedCode: 0 }, join(reportDir, 'tar-list.json'))).stdout.trim().split('\n');
  const documents = ['capture', 'config', 'manifest', 'plan', 'result', 'scenario', 'timeline'];
  const required = ['package/package.json', 'package/dist/cli/index.js', 'package/dist/recorder/mask-worker.js', 'package/dist/recorder/masker.js', ...documents.map((name) => `package/schema/${name}.v2.json`), 'package/skills/show-what-changed/SKILL.md', 'package/assets/fonts/Inter-Regular.woff2', 'package/assets/fonts/OFL.txt', 'package/assets/fonts/provenance.json', 'package/README.md', 'package/LICENSE', 'package/THIRD_PARTY_NOTICES.md'];
  for (const entry of required) assert(listing.includes(entry), `Missing packed file ${entry}`);
  for (const entry of listing) {
    assert(/^package\/(?:dist\/|schema\/|skills\/|assets\/|README\.md$|LICENSE$|THIRD_PARTY_NOTICES\.md$|package\.json$)/.test(entry), `Unexpected packed file ${entry}`);
    assert(!/^package\/schema\/.*\.v1\.json$/.test(entry), `Retired schema in candidate ${entry}`);
  }
  const installRoot = join(root, 'installed');
  await mkdir(installRoot, { recursive: true });
  await writeFile(join(installRoot, 'package.json'), '{"private":true}\n');
  await privateCommand(['npm', 'install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', tarball], installRoot, { expectedCode: 0 }, join(reportDir, 'install.json'));
  const packageRoot = join(installRoot, 'node_modules/show-what-changed');
  const binary = join(installRoot, 'node_modules/.bin/show-what-changed');
  assert.equal(await realpath(binary), join(packageRoot, 'dist/cli/index.js'));
  assert((await lstat(join(packageRoot, 'dist/cli/index.js'))).mode & 0o111);
  await assert.rejects(access(join(packageRoot, 'src')), { code: 'ENOENT' });
  await assert.rejects(access(join(installRoot, 'node_modules/vitest')), { code: 'ENOENT' });
  await assert.rejects(access(join(installRoot, 'node_modules/typescript')), { code: 'ENOENT' });
  for (const name of documents) {
    const document = JSON.parse(await readFile(join(packageRoot, 'schema', name + '.v2.json'), 'utf8'));
    const expected = JSON.parse(await readFile(new URL(`../schema/${name}.v2.json`, import.meta.url), 'utf8'));
    assert.deepEqual(document, expected, `Packed ${name} schema differs from the validated build contract`);
  }
  const schemas = await import(pathToFileURL(join(packageRoot, 'dist/schema/index.js')).href);
  const commands = [];
  const cli = async (name, args, cwd, code, env = {}) => {
    const entry = { name, args, code, validationStage: 'process' };
    commands.push(entry);
    let result;
    try {
      result = await privateCommand([binary, ...args, '--json'], cwd, { expectedCode: code, env }, join(reportDir, name + '.json'));
      entry.validationStage = 'json';
      const envelope = JSON.parse(result.stdout);
      entry.validationStage = 'schema';
      schemas.ResultSchema.parse(envelope);
      entry.validationStage = 'envelope-exit';
      assert.equal(envelope.exitCode, code);
      entry.validationStage = 'complete';
      return envelope;
    } catch (error) {
      result ??= error.result;
      entry.validationStage = error.validationStage ?? entry.validationStage;
      throw Object.assign(error, { result, commandName: name, validationStage: entry.validationStage });
    } finally {
      if (result) Object.assign(entry, { elapsedMs: result.elapsedMs, actualExit: result.code, signal: result.signal, timedOut: result.timedOut, overflow: result.overflow });
    }
  };
  return { tarball, sha256: hash(bytes), bytes: bytes.length, listing, installRoot, packageRoot, binary, schemas, commands, cli };
}
