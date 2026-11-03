import { execFile, spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, expect, test } from 'vitest';
import { ManifestSchema, ResultSchema } from '../../src/schema/index.js';

const execute = promisify(execFile);
const roots: string[] = [];
const exists = (path: string) => stat(path).then(() => true, () => false);
type Probe = 'chmod' | 'mkdir' | 'open' | 'writeFile' | 'rename' | 'inventory-read' | 'source-read' | 'git-add' | 'git-reset' | 'git-inspect' | 'git-missing' | 'programmer' | 'coded-programmer' | 'timeout' | 'SIGINT' | 'SIGTERM';
async function git(root: string, ...args: string[]): Promise<string> {
  return (await execute('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args], { cwd: root })).stdout.trim();
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function workspaceProbe(probe: Probe) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'swc-workspace-errors-')));
  roots.push(root);
  const repo = join(root, 'repo');
  await mkdir(repo);
  await git(repo, 'init', '-q');
  await git(repo, 'config', 'user.email', 'fixture@example.invalid');
  await git(repo, 'config', 'user.name', 'Workspace errors fixture');
  await writeFile(join(repo, 'package.json'), JSON.stringify({ name: 'workspace-errors-fixture', version: '1.0.0' }));
  await writeFile(join(repo, 'package-lock.json'), JSON.stringify({ name: 'workspace-errors-fixture', version: '1.0.0', lockfileVersion: 3, packages: { '': { name: 'workspace-errors-fixture', version: '1.0.0' } } }));
  await writeFile(join(repo, '.gitignore'), '.show-what-changed/\nnode_modules/\n');
  await writeFile(join(repo, 'show-what-changed.config.json'), JSON.stringify({ schemaVersion: 2, execution: { start: { kind: 'process', argv: ['node', 'server.mjs', '{port}'] }, state: { kind: 'stateless' } } }));
  await writeFile(join(repo, 'source.txt'), 'committed source');
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-qm', 'initial');
  await writeFile(join(repo, 'source.txt'), 'staged source');
  await git(repo, 'add', 'source.txt');
  await writeFile(join(repo, 'source.txt'), 'final caller source');
  await mkdir(join(repo, 'new-directory'));
  await writeFile(join(repo, 'new-directory/untracked.txt'), 'untracked caller source');
  await mkdir(join(repo, 'node_modules'));
  await writeFile(join(repo, 'node_modules/caller'), 'caller dependencies');
  const index = await readFile(join(repo, '.git/index'));
  const head = await git(repo, 'rev-parse', 'HEAD');
  const worktrees = await git(repo, 'worktree', 'list', '--porcelain');
  const trace = join(root, 'trace.json');
  const fsShim = join(root, 'fs-shim.mjs');
  const gitShim = join(root, 'git-shim.mjs');
  const loader = join(root, 'loader.mjs');
  await writeFile(fsShim, `
import * as fs from 'node:fs/promises';
import { constants } from 'node:os';
export * from 'node:fs/promises';
const probe = ${JSON.stringify(probe)};
const managed = path => String(path).includes('/private/workspaces/');
async function fail(operation, path) {
  const state = globalThis.__workspaceProbe;
  if (state.fired) return;
  const name = String(path);
  const selected = probe === operation && managed(path)
    || probe === 'inventory-read' && operation === 'read' && name.endsWith('/private/workspaces/before/source.txt')
    || probe === 'source-read' && operation === 'read' && state.afterStarted && name === ${JSON.stringify(join(repo, 'source.txt'))}
    || ['programmer', 'coded-programmer', 'timeout', 'SIGINT', 'SIGTERM'].includes(probe) && operation === 'chmod' && managed(path);
  if (!selected) return;
  state.fired = true;
  state.operation = operation;
  globalThis.__workspaceTrace();
  if (probe === 'programmer') throw new TypeError('Private injected programmer failure');
  if (probe === 'coded-programmer') throw Object.assign(new Error('Private injected coded programmer failure'), { code: 'EACCES' });
  if (probe === 'timeout') await new Promise(resolve => setTimeout(resolve, 6000));
  if (probe === 'SIGINT' || probe === 'SIGTERM') {
    process.kill(process.pid, probe);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  const code = operation === 'writeFile' ? 'ENOSPC' : 'EACCES';
  throw Object.assign(new Error('Private injected filesystem failure'), { code, errno: -constants.errno[code], syscall: operation, path: name });
}
export async function chmod(path, mode) { await fail('chmod', path); return fs.chmod(path, mode); }
export async function mkdir(path, options) { if (String(path).endsWith('/after/new-directory')) await fail('mkdir', path); return fs.mkdir(path, options); }
export async function rename(source, destination) { await fail('rename', destination); return fs.rename(source, destination); }
export async function open(path, flags, mode) {
  const copying = String(path).includes('/.swc-copy-');
  await fail(copying ? 'open' : 'read', path);
  const handle = await fs.open(path, flags, mode);
  if (copying && probe === 'writeFile') {
    const write = handle.writeFile.bind(handle);
    handle.writeFile = async (...args) => { await fail('writeFile', path); return write(...args); };
  }
  return handle;
}
`);
  await writeFile(gitShim, `
import { spawn as realSpawn } from 'node:child_process';
export * from 'node:child_process';
export function spawn(command, args, options) {
  const probe = ${JSON.stringify(probe)};
  const state = globalThis.__workspaceProbe;
  const add = args.includes('worktree') && args.includes('add');
  const reset = args.includes('reset') && args.includes('--hard');
  if (add && args.some(arg => arg.endsWith('/after'))) state.afterStarted = true;
  const selected = probe === 'git-add' && add || probe === 'git-reset' && reset
    || probe === 'git-inspect' && options.cwd.endsWith('/before') && args.includes('ls-files') && args.includes('-u')
    || probe === 'git-missing' && add;
  if (selected && !state.fired) {
    state.fired = true;
    state.operation = add ? 'git-add' : reset ? 'git-reset' : 'git-inspect';
    globalThis.__workspaceTrace();
    if (probe === 'git-missing') return realSpawn(${JSON.stringify(join(root, 'missing-git'))}, args, options);
    return realSpawn(process.execPath, ['-e', 'process.exit(19)'], options);
  }
  return realSpawn(command, args, options);
}
`);
  await writeFile(loader, `
import { registerHooks } from 'node:module';
import { writeFileSync } from 'node:fs';
globalThis.__workspaceProbe = { fired: false, afterStarted: false };
globalThis.__workspaceTrace = () => writeFileSync(${JSON.stringify(trace)}, JSON.stringify(globalThis.__workspaceProbe));
globalThis.__workspaceTrace();
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'node:fs/promises' && /\\/src\\/(workspace\\/(index|source)|runtime\\/files)\\.ts$/.test(context.parentURL ?? '')) return next(${JSON.stringify(pathToFileURL(fsShim).href)}, context);
  if (specifier === 'node:child_process' && context.parentURL?.endsWith('/src/workspace/git.ts')) return next(${JSON.stringify(pathToFileURL(gitShim).href)}, context);
  if (context.parentURL?.includes('/src/') && specifier.startsWith('.') && specifier.endsWith('.js')) return next(specifier.replace(/\\.js$/, '.ts'), context);
  return next(specifier, context);
} });
await import(${JSON.stringify(new URL('../../src/cli/index.ts', import.meta.url).href)});
`);
  const child = spawn(process.execPath, ['--no-warnings', '--experimental-transform-types', loader, 'compare', '--route', '/', '--allow-exec', '--json', ...(probe === 'timeout' ? ['--timeout', '5'] : [])], { cwd: repo, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', (bytes: Buffer) => { stdout += bytes; });
  child.stderr.on('data', (bytes: Buffer) => { stderr += bytes; });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 25_000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    expect(stdout.trim().split('\n'), stderr).toHaveLength(1);
    const result = ResultSchema.parse(JSON.parse(stdout));
    expect(result.data, stdout + stderr).not.toBeNull();
    const manifest = ManifestSchema.parse(result.data);
    expect(JSON.parse(await readFile(trace, 'utf8'))).toMatchObject({ fired: true });
    expect(await readFile(join(repo, '.git/index'))).toEqual(index);
    expect(await git(repo, 'rev-parse', 'HEAD')).toBe(head);
    expect(await git(repo, 'worktree', 'list', '--porcelain')).toBe(worktrees);
    expect(await readFile(join(repo, 'source.txt'), 'utf8')).toBe('final caller source');
    expect(await readFile(join(repo, 'new-directory/untracked.txt'), 'utf8')).toBe('untracked caller source');
    expect(await readFile(join(repo, 'node_modules/caller'), 'utf8')).toBe('caller dependencies');
    expect(manifest.cleanupOutcome).toEqual({ status: 'ok', errors: [] });
    expect(await exists(join(repo, '.show-what-changed/run.lock'))).toBe(false);
    expect(await exists(join(repo, '.show-what-changed/runs', manifest.runId, 'private/workspaces'))).toBe(false);
    const saved = ManifestSchema.parse(JSON.parse(await readFile(join(repo, '.show-what-changed/runs', manifest.runId, 'manifest.json'), 'utf8')));
    expect(result.data).toEqual(saved);
    expect(stdout).not.toContain('Private injected');
    return { code, result, manifest };
  } finally { clearTimeout(timeout); }
}

test.each(['chmod', 'mkdir', 'open', 'writeFile', 'rename', 'inventory-read', 'source-read', 'git-add', 'git-reset'] as const)('reports %s materialization failure as exit 5 and removes owned worktrees', async (probe) => {
  const actual = await workspaceProbe(probe);
  expect(actual.code).toBe(5);
  expect(actual.result).toMatchObject({ status: 'failed', exitCode: 5, error: { code: 'WORKSPACE_FAILED', phase: 'preparing', side: ['mkdir', 'open', 'writeFile', 'rename', 'source-read'].includes(probe) ? 'after' : 'before' } });
  expect(actual.manifest).toMatchObject({ status: 'failed', exitCode: 5 });
}, 30_000);

test.each([
  ['git-inspect', 2, 'GIT_FAILED', 'failed'],
  ['git-missing', 8, 'GIT_UNAVAILABLE', 'failed'],
  ['programmer', 1, 'INTERNAL_ERROR', 'failed'],
  ['coded-programmer', 1, 'INTERNAL_ERROR', 'failed'],
  ['timeout', 10, 'DEADLINE_EXCEEDED', 'cancelled'],
  ['SIGINT', 130, 'SIGINT', 'cancelled'],
  ['SIGTERM', 143, 'SIGTERM', 'cancelled'],
] as const)('preserves %s classification and cleanup', async (probe, exitCode, code, status) => {
  const actual = await workspaceProbe(probe);
  expect(actual.code).toBe(exitCode);
  expect(actual.result).toMatchObject({ status, exitCode, error: { code } });
  expect(actual.manifest).toMatchObject({ status, exitCode });
}, 30_000);
