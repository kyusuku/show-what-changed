import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { afterEach, expect, test, vi } from 'vitest';
import type { RunContext } from '../../src/schema/contracts.js';
import { DockerImageArchive } from '../../src/runtime/docker-archive.js';
import { runCleanupLifetime } from '../../src/runtime/cleanup-lifetime.js';
import { cleanupRun, createRunContext, releaseRunOwnership } from '../../src/runtime/context.js';
import { readOwner, cleanOwnedRun } from '../../src/runtime/ownership.js';

vi.mock('../../src/runtime/process-table.js', async (original) => ({ ...await original<object>(), processTable: async () => [{ pid: process.pid, parent: 1, group: process.pid, started: 'synthetic owner' }] }));
const roots: string[] = [];
const runs: RunContext[] = [];
afterEach(async () => { for (const run of runs.splice(0)) await releaseRunOwnership(run); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); vi.restoreAllMocks(); });
function barrier() { let resolve = () => {}; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }
async function run() {
  const root = await mkdtemp(join(tmpdir(), 'swc-archive-cleanup-')); roots.push(root);
  const value = await createRunContext({ repoRoot: root, timeoutMs: 60_000, signal: new AbortController().signal, diagnostics: { event() {} }, retainOwnership: true }); runs.push(value); return value;
}
const name = 'docker-export-0123456789abcdef01234567';
async function archives(run: RunContext) { return (await readdir(run.paths.privateDir)).filter((path) => path.startsWith('docker-export-')); }

test.each(['stop', 'dispose'] as const)('%s bounds a blocked operation and retains its archive after late settlement', async (action) => {
  const context = await run(); const entered = barrier(); const release = barrier(); const removeBuilder = vi.fn(async () => {});
  const archive = new DockerImageArchive(context, name, removeBuilder);
  const operation = archive.runOperation(async () => { await writeFile(join(context.paths.privateDir, archive.relativePath), 'owned export'); entered.resolve(); await release.promise; });
  const outcome = operation.catch((error: unknown) => error); await entered.promise;
  const deadline = performance.now() + 25;
  await expect(archive[action](deadline)).rejects.toMatchObject({ detail: { code: 'CLEANUP_TIMEOUT' } });
  expect(await outcome).toMatchObject({ detail: { code: 'CLEANUP_TIMEOUT' } });
  expect(removeBuilder).not.toHaveBeenCalled(); expect(await archives(context)).toEqual([name]);
  release.resolve(); await new Promise((done) => setImmediate(done));
  await expect(archive.dispose(performance.now() + 1000)).rejects.toMatchObject({ detail: { code: 'CLEANUP_TIMEOUT' } });
  expect(removeBuilder).not.toHaveBeenCalled(); expect(await archives(context)).toEqual([name]);
  expect(await releaseRunOwnership(context)).toMatchObject({ status: 'failed', ownership: 'retained' });
});

test('a concurrent earlier disposal deadline shortens all waiters and cannot be restarted', async () => {
  const context = await run(); const entered = barrier(); const release = barrier();
  const removeBuilder = vi.fn(async () => {}); const archive = new DockerImageArchive(context, name, removeBuilder);
  const operation = archive.runOperation(async () => { entered.resolve(); await release.promise; });
  const operationResult = operation.catch((error: unknown) => error); await entered.promise;
  const first = archive.dispose(performance.now() + 1000);
  const firstResult = first.catch((error: unknown) => error);
  await expect(archive.dispose(performance.now() + 25)).rejects.toMatchObject({ detail: { code: 'CLEANUP_TIMEOUT' } });
  expect(await firstResult).toMatchObject({ detail: { code: 'CLEANUP_TIMEOUT' } });
  release.resolve(); await operationResult;
  expect(removeBuilder).not.toHaveBeenCalled(); expect(await archives(context)).toEqual([name]);
});

test('manual context cleanup bounds the build waiter even when supervisor stop remains pending', async () => {
  const context = await run(); const entered = barrier(); const release = barrier(); const stop = barrier();
  vi.spyOn(context.supervisor, 'stopAll').mockImplementation(() => stop.promise.then(() => ({ status: 'ok', errors: [] })));
  const removeBuilder = vi.fn(async () => {}); const archive = new DockerImageArchive(context, name, removeBuilder);
  const operation = archive.runOperation(async () => { entered.resolve(); await release.promise; });
  const result = operation.catch((error: unknown) => error); await entered.promise;
  const deadline = performance.now() + 25; runCleanupLifetime(context).begin(deadline);
  const cleaning = cleanupRun(context);
  expect(await result).toMatchObject({ detail: { code: 'CLEANUP_TIMEOUT' } });
  expect(await cleaning).toMatchObject({ status: 'failed' });
  expect(runCleanupLifetime(context).deadline).toBe(deadline);
  expect(await releaseRunOwnership(context)).toMatchObject({ status: 'failed', ownership: 'retained' });
  release.resolve(); stop.resolve(); await new Promise((done) => setImmediate(done));
  expect(removeBuilder).not.toHaveBeenCalled(); expect(await archives(context)).toEqual([name]);
  expect((await readOwner(context.paths.runDir)).state).toBe('active');
});

test('normal disposal respects a prior run cleanup deadline at builder removal', async () => {
  const context = await run(); const entered = barrier(); const release = barrier();
  const removeBuilder = vi.fn(async (_deadline: number) => { entered.resolve(); await release.promise; });
  const archive = new DockerImageArchive(context, name, removeBuilder); await archive.runOperation(async () => {});
  const deadline = performance.now() + 25; runCleanupLifetime(context).begin(deadline);
  const disposed = archive.dispose(performance.now() + 30_000); const outcome = disposed.catch((error: unknown) => error);
  await entered.promise; expect(removeBuilder).toHaveBeenCalledWith(deadline);
  expect(await outcome).toMatchObject({ detail: { code: 'CLEANUP_TIMEOUT' } });
  release.resolve(); await new Promise((done) => setImmediate(done));
  expect(await archives(context)).toEqual([name]);
  expect(await releaseRunOwnership(context)).toMatchObject({ status: 'failed', ownership: 'retained' });
});

test('normal disposal bounds blocked builder removal without starting the run cleanup budget', async () => {
  const context = await run(); const release = barrier();
  const archive = new DockerImageArchive(context, name, async () => release.promise);
  await archive.runOperation(async () => {});
  await expect(archive.dispose(performance.now() + 25)).rejects.toMatchObject({ detail: { code: 'CLEANUP_TIMEOUT' } });
  expect(runCleanupLifetime(context).deadline).toBe(Infinity);
  release.resolve(); await new Promise((done) => setImmediate(done));
  expect(await archives(context)).toEqual([name]);
  expect(await releaseRunOwnership(context)).toMatchObject({ status: 'failed', ownership: 'retained' });
});

test('process inactivity must be proved even after the operation has settled', async () => {
  const context = await run(); const removeBuilder = vi.fn(async () => {}); const archive = new DockerImageArchive(context, name, removeBuilder);
  await archive.runOperation(async () => { archive.holdProcess(); });
  await expect(archive.dispose(performance.now() + 1000)).rejects.toMatchObject({ detail: { code: 'PROCESS_CLEANUP_FAILED' } });
  expect(removeBuilder).not.toHaveBeenCalled(); expect(await archives(context)).toEqual([name]);
  expect(await releaseRunOwnership(context)).toMatchObject({ status: 'failed', ownership: 'retained' });
});

test('successful disposal remains idempotent after its original deadline', async () => {
  const context = await run(); const removeBuilder = vi.fn(async () => {}); const archive = new DockerImageArchive(context, name, removeBuilder);
  await archive.runOperation(async () => {}); await archive.dispose(performance.now() + 100);
  await new Promise((done) => setTimeout(done, 110));
  await archive.dispose(performance.now() + 25); await archive.stop(performance.now() + 25);
  expect(runCleanupLifetime(context).deadline).toBe(Infinity);
  expect(removeBuilder).toHaveBeenCalledTimes(1); expect(await archives(context)).toEqual([]);
  expect(await releaseRunOwnership(context)).toMatchObject({ status: 'ok', ownership: 'released' });
});

test('a retained timeout can be cleaned later after independent owner inactivity is established', async () => {
  const context = await run(); const entered = barrier(); const release = barrier(); const archive = new DockerImageArchive(context, name, async () => {});
  const operation = archive.runOperation(async () => { entered.resolve(); await release.promise; });
  const result = operation.catch((error: unknown) => error); await entered.promise;
  await expect(archive.dispose(performance.now() + 25)).rejects.toMatchObject({ detail: { code: 'CLEANUP_TIMEOUT' } });
  release.resolve(); await result; await new Promise((done) => setImmediate(done));
  expect(await releaseRunOwnership(context)).toMatchObject({ status: 'failed', ownership: 'retained' });
  const owner = await readOwner(context.paths.runDir);
  const inactive = { ...owner, owner: { ...owner.owner, pid: 99999999, started: 'synthetic ended owner' } };
  await writeFile(join(context.paths.runDir, '.owner.json'), JSON.stringify(inactive));
  await writeFile(join(context.paths.repoRoot, '.show-what-changed/run.lock/owner.json'), JSON.stringify(inactive));
  expect((await cleanOwnedRun(context.paths.repoRoot, context.runId)).removed).toBe(true);
  await expect(readFile(join(context.paths.privateDir, archive.relativePath))).rejects.toMatchObject({ code: 'ENOENT' });
});
