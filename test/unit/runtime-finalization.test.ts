import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { cleanupRun, createRunContext, releaseRunOwnership, reopenRunContext } from '../../src/runtime/context.js';
import { readOwner, cleanOwnedRun } from '../../src/runtime/ownership.js';
import { writeRunFile } from '../../src/runtime/files.js';
import type { RunContext } from '../../src/schema/contracts.js';

type Hook = ((path: string) => Promise<void>) | undefined;
const hooks = vi.hoisted<{ beforeLink: Hook; beforeMkdir: Hook; beforeRm: Hook; afterRmdir: Hook; beforeUnlink: Hook }>(() => ({ beforeLink: undefined, beforeMkdir: undefined, beforeRm: undefined, afterRmdir: undefined, beforeUnlink: undefined }));
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual,
    link: async (...args: Parameters<typeof actual.link>) => { await hooks.beforeLink?.(String(args[1])); return actual.link(...args); },
    mkdir: async (...args: Parameters<typeof actual.mkdir>) => { await hooks.beforeMkdir?.(String(args[0])); return actual.mkdir(...args); },
    rm: async (...args: Parameters<typeof actual.rm>) => { await hooks.beforeRm?.(String(args[0])); return actual.rm(...args); },
    rmdir: async (...args: Parameters<typeof actual.rmdir>) => { await actual.rmdir(...args); await hooks.afterRmdir?.(String(args[0])); },
    unlink: async (...args: Parameters<typeof actual.unlink>) => { await hooks.beforeUnlink?.(String(args[0])); return actual.unlink(...args); },
  };
});
const roots: string[] = [];
const runs: RunContext[] = [];
const diagnostics = { event() {} };
function deferred(): { promise: Promise<void>; resolve: () => void } { let resolve = (): void => {}; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }
async function root(): Promise<string> { const path = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'swc-finalization-'))); roots.push(path); return path; }
async function create(path: string, signal = new AbortController().signal): Promise<RunContext> { const run = await createRunContext({ repoRoot: path, timeoutMs: 60_000, signal, diagnostics, retainOwnership: true }); runs.push(run); return run; }
async function reopen(run: RunContext): Promise<RunContext> { const resumed = await reopenRunContext({ runDir: run.paths.runDir, timeoutMs: 60_000, signal: new AbortController().signal, diagnostics, retainOwnership: true }); runs.push(resumed); return resumed; }
afterEach(async () => { hooks.beforeLink = undefined; hooks.beforeMkdir = undefined; hooks.beforeRm = undefined; hooks.afterRmdir = undefined; hooks.beforeUnlink = undefined; for (const run of runs.splice(0)) await releaseRunOwnership(run); await Promise.all(roots.splice(0).map((path) => fs.rm(path, { recursive: true, force: true }))); });

test('resource cleanup retains exclusive ownership through terminal artifact writes', async () => {
  const path = await root(); const run = await create(path);
  expect(await cleanupRun(run)).toEqual({ status: 'ok', errors: [] });
  expect((await readOwner(run.paths.runDir)).state).toBe('active');
  await expect(fs.stat(run.paths.tempDir)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(cleanOwnedRun(path, run.runId)).rejects.toMatchObject({ detail: { code: 'RUN_ACTIVE' } });
  await expect(reopen(run)).rejects.toMatchObject({ detail: { code: 'RUN_ACTIVE' } });
  await writeRunFile(run, 'manifest.json', '{"terminal":true}');
  expect(await releaseRunOwnership(run)).toEqual({ status: 'ok', errors: [], ownership: 'released' });
  expect(await releaseRunOwnership(run)).toEqual({ status: 'ok', errors: [], ownership: 'released' });
  expect((await readOwner(run.paths.runDir)).state).toBe('inactive');
  expect(await fs.readFile(join(run.paths.runDir, 'manifest.json'), 'utf8')).toBe('{"terminal":true}');
  expect((await cleanOwnedRun(path, run.runId)).removed).toBe(true);
});

test('cancellation remains observable after resource cleanup without releasing ownership', async () => {
  const path = await root(); const controller = new AbortController(); const run = await create(path, controller.signal);
  await cleanupRun(run); controller.abort(new Error('terminal write cancelled'));
  expect(run.signal.aborted).toBe(true);
  expect((await readOwner(run.paths.runDir)).state).toBe('active');
  await expect(cleanOwnedRun(path, run.runId)).rejects.toMatchObject({ detail: { code: 'RUN_ACTIVE' } });
  expect((await releaseRunOwnership(run)).ownership).toBe('released');
});

test('explicit release waits for resource disposal and refuses release after cleanup failure', async () => {
  const path = await root(); const run = await create(path); const entered = deferred(); const resume = deferred();
  run.resources.register({ kind: 'context', identity: 'blocked-close', dispose: async () => { entered.resolve(); await resume.promise; } });
  const release = releaseRunOwnership(run); await entered.promise;
  await expect(cleanOwnedRun(path, run.runId)).rejects.toMatchObject({ detail: { code: 'RUN_ACTIVE' } });
  resume.resolve(); expect((await release).ownership).toBe('released');
  const failed = await create(path); failed.resources.register({ kind: 'context', identity: 'failed-close', dispose: async () => { throw new Error('close failed'); } });
  expect(await releaseRunOwnership(failed)).toMatchObject({ status: 'failed', ownership: 'retained' });
  expect((await readOwner(failed.paths.runDir)).state).toBe('active');
});

test('failed reopen initialization releases ownership even when retention was requested', async () => {
  const path = await root(); const run = await create(path); await releaseRunOwnership(run);
  const link = join(run.paths.runDir, 'unexpected-link'); await fs.symlink(path, link);
  await expect(reopen(run)).rejects.toMatchObject({ detail: { code: 'UNSAFE_PATH' } });
  expect((await readOwner(run.paths.runDir)).state).toBe('inactive');
  await expect(fs.stat(join(path, '.show-what-changed', 'run.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
  await fs.unlink(link); expect((await releaseRunOwnership(await reopen(run))).ownership).toBe('released');
});

test('an incomplete lock never means that a completed run is safe to delete', async () => {
  const path = await root(); const run = await create(path); await releaseRunOwnership(run);
  await fs.mkdir(join(path, '.show-what-changed', 'run.lock'));
  await expect(cleanOwnedRun(path, run.runId)).rejects.toMatchObject({ detail: { code: 'OWNERSHIP_UNCERTAIN' } });
  expect((await readOwner(run.paths.runDir)).runId).toBe(run.runId);
});

test('clean holds the same repository lock until run deletion completes', async () => {
  const path = await root(); const run = await create(path); await releaseRunOwnership(run); const entered = deferred(); const resume = deferred();
  hooks.beforeRm = async (target) => { if (target === run.paths.runDir) { entered.resolve(); await resume.promise; } };
  const cleaning = cleanOwnedRun(path, run.runId); await entered.promise;
  try { await expect(reopen(run)).rejects.toMatchObject({ detail: { code: 'RUN_ACTIVE' } }); }
  finally { resume.resolve(); }
  expect((await cleaning).removed).toBe(true);
});

test('clean revalidates a run when compose acquires the lock after its initial read', async () => {
  const path = await root(); const run = await create(path); await releaseRunOwnership(run); const entered = deferred(); const resume = deferred();
  const lockPath = join(path, '.show-what-changed', 'run.lock');
  hooks.beforeMkdir = async (target) => { if (target === lockPath) { hooks.beforeMkdir = undefined; entered.resolve(); await resume.promise; } };
  const cleaning = cleanOwnedRun(path, run.runId); await entered.promise;
  const resumed = await reopen(run); resume.resolve();
  await expect(cleaning).rejects.toMatchObject({ detail: { code: 'RUN_ACTIVE' } });
  expect((await readOwner(run.paths.runDir)).state).toBe('active');
  await writeRunFile(resumed, 'manifest.json', '{"stillOwned":true}');
});

test('a partial lock release remains owned and blocks clean while terminal metadata is repaired', async () => {
  const path = await root(); const run = await create(path); const lockPath = join(path, '.show-what-changed', 'run.lock');
  await fs.writeFile(join(lockPath, 'unremoved-residue'), 'preserve');
  expect(await releaseRunOwnership(run)).toMatchObject({ status: 'failed', ownership: 'retained' });
  await expect(cleanOwnedRun(path, run.runId)).rejects.toMatchObject({ detail: { code: 'OWNERSHIP_UNCERTAIN' } });
  await expect(reopen(run)).rejects.toMatchObject({ detail: { code: 'RUN_ACTIVE' } });
  await writeRunFile(run, 'manifest.json', '{"cleanup":"failed"}');
  expect(await fs.readFile(join(run.paths.runDir, 'manifest.json'), 'utf8')).toBe('{"cleanup":"failed"}');
});

test('a filesystem error reported after lock removal never claims retained ownership', async () => {
  const path = await root(); const run = await create(path); const lockPath = join(path, '.show-what-changed', 'run.lock');
  hooks.afterRmdir = async (target) => { if (target === lockPath) throw new Error('injected error after release'); };
  expect(await releaseRunOwnership(run)).toMatchObject({ status: 'failed', ownership: 'uncertain' });
  await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('an inactive marker committed before an atomic-write cleanup error still retains the live lock', async () => {
  const path = await root(); const run = await create(path);
  hooks.beforeUnlink = async (target) => { if (target.startsWith(join(run.paths.runDir, '.swc-'))) { hooks.beforeUnlink = undefined; throw new Error('injected temporary unlink error after marker rename'); } };
  expect(await releaseRunOwnership(run)).toMatchObject({ status: 'failed', ownership: 'retained' });
  expect((await readOwner(run.paths.runDir)).state).toBe('inactive');
  await expect(cleanOwnedRun(path, run.runId)).rejects.toMatchObject({ detail: { code: 'RUN_ACTIVE' } });
  await writeRunFile(run, 'manifest.json', '{"cleanup":"failed"}');
});

test('only one cleaner can claim an exact abandoned repository lock', async () => {
  const path = await root(); const run = await create(path); await releaseRunOwnership(run);
  const old = await readOwner(run.paths.runDir);
  const marker = { ...old, state: 'active', owner: { ...old.owner, pid: 99999999, started: 'no such owner' } };
  await fs.writeFile(join(run.paths.runDir, '.owner.json'), JSON.stringify(marker));
  const lockPath = join(path, '.show-what-changed', 'run.lock'); await fs.mkdir(lockPath); await fs.writeFile(join(lockPath, 'owner.json'), JSON.stringify(marker));
  const entered = deferred(); const resume = deferred();
  hooks.beforeRm = async (target) => { if (target === run.paths.runDir) { entered.resolve(); await resume.promise; } };
  const cleaning = cleanOwnedRun(path, run.runId); await entered.promise;
  try { await expect(cleanOwnedRun(path, run.runId)).rejects.toMatchObject({ detail: { code: 'RUN_ACTIVE' } }); }
  finally { resume.resolve(); }
  expect((await cleaning).removed).toBe(true);
  await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('reopen failure before context handoff restores the previous inactive owner', async () => {
  const path = await root(); const run = await create(path); await releaseRunOwnership(run);
  const marker = await readOwner(run.paths.runDir); const lockPath = join(path, '.show-what-changed', 'run.lock');
  hooks.beforeLink = async (target) => { if (target === join(lockPath, 'owner.json')) { hooks.beforeLink = undefined; throw new Error('injected lock writer error'); } };
  await expect(reopen(run)).rejects.toThrow('injected lock writer error');
  expect(await readOwner(run.paths.runDir)).toEqual(marker);
  await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
});


test('automatic cancellation cleanup retains ownership until explicit release', async () => {
  const path = await root(); const controller = new AbortController(); const run = await create(path, controller.signal); let disposed = 0;
  run.resources.register({ kind: 'context', identity: 'cancelled-context', dispose: async () => { disposed++; } });
  controller.abort(new Error('cancelled'));
  expect((await cleanupRun(run)).status).toBe('ok'); expect(disposed).toBe(1);
  expect((await readOwner(run.paths.runDir)).state).toBe('active');
  await expect(cleanOwnedRun(path, run.runId)).rejects.toMatchObject({ detail: { code: 'RUN_ACTIVE' } });
  expect((await releaseRunOwnership(run)).ownership).toBe('released');
});

test('the retained global deadline remains live during terminal artifact writes', async () => {
  const path = await root(); const run = await createRunContext({ repoRoot: path, timeoutMs: 50, signal: new AbortController().signal, diagnostics, retainOwnership: true }); runs.push(run);
  await cleanupRun(run); await new Promise((done) => setTimeout(done, 100));
  expect(run.signal.aborted).toBe(true); expect(run.signal.reason).toMatchObject({ exitCode: 10 });
  expect((await readOwner(run.paths.runDir)).state).toBe('active');
  expect((await releaseRunOwnership(run)).ownership).toBe('released');
});

test('a changed run ownership marker never permits terminal metadata repair', async () => {
  const path = await root(); const run = await create(path); const marker = await readOwner(run.paths.runDir);
  await fs.writeFile(join(run.paths.runDir, '.owner.json'), JSON.stringify({ ...marker, nonce: '0'.repeat(32) }));
  expect(await releaseRunOwnership(run)).toMatchObject({ status: 'failed', ownership: 'uncertain' });
  await expect(create(path)).rejects.toMatchObject({ detail: { code: 'RUN_ACTIVE' } });
});

test('aborted cleanup traverses every resource kind in dependency order with a separate thirty-second budget', async () => {
  const path = await root(); const controller = new AbortController(); const run = await create(path, controller.signal);
  const order: string[] = []; const budgets: number[] = [];
  const kinds = ['capture', 'context', 'browser', 'builder', 'container', 'network', 'image', 'lock', 'private-dir', 'workspace'] as const;
  for (const kind of [...kinds].reverse()) run.resources.register({ kind, identity: `order-${kind}`, dispose: async (deadline) => { order.push(kind); budgets.push(deadline - performance.now()); } });
  controller.abort(new Error('cancelled before cleanup'));
  expect(await cleanupRun(run)).toEqual({ status: 'ok', errors: [] });
  expect(order).toEqual(kinds);
  expect(budgets.every((budget) => budget > 28_000 && budget <= 30_000)).toBe(true);
  expect(() => run.resources.register({ kind: 'context', identity: 'too-late', dispose: async () => {} })).toThrow();
  expect((await releaseRunOwnership(run)).ownership).toBe('released');
});
