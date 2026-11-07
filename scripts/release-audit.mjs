#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, lstat, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash, saveJson } from './release-harness.mjs';
import { gitEnvironment } from './git-env.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const [tarballArgument, outputArgument] = process.argv.slice(2);
assert(tarballArgument && outputArgument && process.argv.length === 4, 'Usage: node scripts/release-audit.mjs candidate.tgz output-directory');
const output = resolve(outputArgument);
await mkdir(output, { recursive: true });
const git = (...args) => execFileSync('git', args, { cwd: root, env: gitEnvironment(), maxBuffer: 64 * 1024 * 1024 });
const lockBytes = await readFile(join(root, 'package-lock.json'));
const lock = JSON.parse(lockBytes);
const dependencies = [];
for (const [path, locked] of Object.entries(lock.packages)) {
  if (!path) continue;
  let installed;
  try { installed = JSON.parse(await readFile(join(root, path, 'package.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const name = installed?.name ?? path.split('node_modules/').at(-1);
  const license = installed?.license ?? locked.license ?? null;
  assert(license, `No declared license for ${name}@${locked.version}`);
  assert(!locked.resolved || locked.resolved.startsWith('https://registry.npmjs.org/'), `Unexpected dependency origin ${name}`);
  const notices = [];
  if (installed) {
    assert.equal(installed.version, locked.version, `Installed version differs from lock for ${path}`);
    for (const filename of await readdir(join(root, path))) if (/^(?:licen[sc]e|copying|notice)(?:[.-]|$)/i.test(filename)) {
      const target = join(root, path, filename);
      if ((await lstat(target)).isFile()) notices.push({ path: join(path, filename), sha256: hash(await readFile(target)) });
    }
  }
  dependencies.push({ name, version: locked.version, path, license, developmentOnly: Boolean(locked.dev), optional: Boolean(locked.optional), installed: Boolean(installed), resolved: locked.resolved ?? null, integrity: locked.integrity ?? null, notices });
}
const rules = [
  ['aws-access-key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{50,255})\b/g],
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g],
  ['slack-token', /\bxox[bapors]-[A-Za-z0-9-]{20,}\b/g],
  ['openai-token', /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{40,}\b/g],
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['credential-url', /https?:\/\/[^\s/:"'<>]{2,}:[^\s/@"'<>]{6,}@[^\s/"'<>]+/g],
  ['literal-credential', /(?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*["']([A-Za-z0-9_+/-]{20,})["']/gi],
];
const scans = [];
const findings = [];
const reviewedSynthetic = new Map([
  ['b91f66fa76232858c51c833219b7ec000bcda014b6f75860e4efc3f48a4f94a3', 'Disposable local PostgreSQL fixture password from runtime-docker.test.ts'],
  ['3e87fb25cc7a413e4e424f9cae3aa58b42e92af821d88f35f15533269c7ce92a', 'T09 synthetic masking canary from adversarial-gaps.test.ts'],
  ['09241cd2398ff033b9a8be8b867f56c434d18066cafcfd2ce8a1bb12400be62a', 'Synthetic failure-summary privacy canary from release-smoke-diagnostics.test.mjs'],
  ['a69ede8ec6c0b4d2c8e8f277631e2263c9c386fe44adbbbb4ef9ff7baa4bcb12', 'T04 fake credential URL at registry.example.invalid in source.test.ts'],
  ['c127c198e854b5e5bc0d7bab9e2b196ba415c2c09b022db2dbde20ae57a5982a', 'Synthetic installer output masking canary at invalid.example in setup-lifecycle.test.ts'],
  ['f6729932bd0216a9ced489911667e48ede49c4c0c9886343567e8abee5e4a2b6', 'Synthetic redactText output omission canary at example.test in setup.test.ts'],
  ['103535163a72b2e1346192e28d00bdaf52672b059ff3357c3ebb465c750a029f', 'Mock HTTPS_PROXY environment inheritance fixture at proxy.invalid in setup.test.ts'],
  ['e256f6e18a700d9d98e37583e83d9ec600a4973d9fa5fe3beb4446ac8444c9f8', 'Mock spawn error result masking canary at proxy.invalid in setup.test.ts'],
]);
function scan(identity, bytes, scope) {
  const record = { identity, scope, bytes: bytes.length, sha256: hash(bytes), binary: bytes.includes(0) };
  scans.push(record);
  if (record.binary) return;
  const text = bytes.toString('utf8');
  for (const [rule, pattern] of rules) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const value = match[1] ?? match[0];
      const matchSha256 = hash(value);
      const reason = reviewedSynthetic.get(matchSha256);
      findings.push({ identity, scope, rule, line: text.slice(0, match.index).split('\n').length, matchSha256, disposition: reason ? 'explicit-synthetic-fixture' : 'review-required', reason: reason ?? null });
    }
  }
}
const worktreePaths = [...new Set(git('ls-files', '-z', '--cached', '--others', '--exclude-standard').toString('utf8').split('\0').filter(Boolean))];
for (const path of worktreePaths) {
  try {
    const target = join(root, path);
    if ((await lstat(target)).isFile()) scan(path, await readFile(target), 'candidate-worktree');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const staged = git('ls-files', '-s', '-z').toString('utf8').split('\0').filter(Boolean);
for (const entry of staged) {
  const match = /^\d+ ([a-f0-9]+) \d\t(.+?)$/s.exec(entry);
  assert(match, 'Invalid Git index entry');
  scan(match[2], git('cat-file', 'blob', match[1]), 'git-index');
}
const objects = git('rev-list', '--objects', '--all', '--no-object-names').toString('utf8').trim().split('\n').filter(Boolean);
const objectInfo = execFileSync('git', ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], { cwd: root, env: gitEnvironment(), input: objects.join('\n') + '\n', encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim().split('\n');
for (const line of objectInfo) {
  const [oid, type] = line.split(' ');
  if (['blob', 'commit', 'tag'].includes(type)) scan(oid, git('cat-file', type, oid), 'git-history-' + type);
}
const tarball = resolve(tarballArgument);
const tarballBytes = await readFile(tarball);
const entries = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' }).trim().split('\n');
for (const entry of entries) assert(entry.startsWith('package/') && !entry.split('/').includes('..'), 'Unsafe candidate path');
const modes = execFileSync('tar', ['-tvzf', tarball], { encoding: 'utf8' }).trim().split('\n');
assert(modes.every((line) => line.startsWith('-') || line.startsWith('d')), 'Candidate contains a nonregular archive entry');
const unpack = await mkdtemp(join(tmpdir(), 'swc-audit-tar-'));
execFileSync('tar', ['-xzf', tarball, '-C', unpack]);
for (const entry of entries) {
  const path = join(unpack, entry);
  if ((await lstat(path)).isFile()) scan(entry, await readFile(path), 'npm-tarball');
}
const report = {
  schemaVersion: 1, checkedAt: new Date().toISOString(), commit: git('rev-parse', 'HEAD').toString('utf8').trim(),
  lockfileSha256: hash(lockBytes), tarball: { path: tarball, sha256: hash(tarballBytes), bytes: tarballBytes.length }, dependencies,
  scan: { rules: rules.map(([name]) => name), scanned: scans, findings, limitations: 'Pattern-based review of known credential shapes and literal credentials. Binary files are hashed but not interpreted. A clean scan is not proof that no secret can exist.' },
  status: findings.some((finding) => finding.disposition === 'review-required') ? 'review-required' : 'passed',
};
await saveJson(join(output, 'report.json'), report);
process.stdout.write(JSON.stringify({ status: report.status, report: join(output, 'report.json'), dependencies: dependencies.length, scannedObjects: scans.length, findings: findings.length }) + '\n');
process.exitCode = report.status === 'passed' ? 0 : 1;
