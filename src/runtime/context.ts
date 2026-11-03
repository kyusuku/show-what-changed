import { randomBytes } from 'node:crypto';
import { lstat, mkdir, realpath, rm, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { CleanupOutcome, DiagnosticSink, ResourceRegistry, RunContext } from '../schema/contracts.js';
import { sanitizeText } from '../schema/io.js';
import { checkCancelled, failure } from '../schema/errors.js';
import { atomicPrivateFile, hasCode, registerExistingRunFiles, safeDirectory } from './files.js';
import { assertInactive, ownsRepositoryLock, readOwner, releaseRepositoryLock } from './ownership.js';
import type { OwnerMarker, RepositoryLock, OwnershipState, OwnershipCommit } from './ownership.js';
import { processTable } from './process-table.js';
import { assertUntrackedOutputTargets, pathExists } from './outputs.js';
import { createSupervisor } from './supervisor.js';
import { runCleanupLifetime } from './cleanup-lifetime.js';

type Resource = Parameters<ResourceRegistry['register']>[0];
export type OwnershipReleaseOutcome = CleanupOutcome & { ownership: OwnershipState };
type Lifecycle = { resources: Resource[]; disposed: Set<Resource>; timer: NodeJS.Timeout; detach: () => void; retainOwnership: boolean; lock: RepositoryLock; marker: OwnerMarker; resourceCleanup?: Promise<CleanupOutcome>; cleanup?: Promise<CleanupOutcome>; release?: Promise<OwnershipReleaseOutcome> };
const lifecycles = new WeakMap<RunContext, Lifecycle>();
export async function beforeDeadline<T>(task: Promise<T>, deadlineMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([task, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(failure(5, 'CLEANUP_TIMEOUT', 'cleanup', 'Resource cleanup exceeded its deadline.', 'Inspect the remaining owned resources manually.')), Math.max(1, deadlineMs - performance.now())); })]);
  } finally { if (timer) clearTimeout(timer); }
}
type ContextOptions = { repoRoot: string; timeoutMs: number; signal: AbortSignal; diagnostics: DiagnosticSink; retainOwnership?: boolean };
export async function createRunContext(options: ContextOptions): Promise<RunContext> { return createContext(options); }
export async function reopenRunContext(options: Omit<ContextOptions, 'repoRoot'> & { runDir: string }): Promise<RunContext> {
  const marker = await readOwner(options.runDir); await assertInactive(marker);
  return createContext({ ...options, repoRoot: marker.repoRoot }, marker);
}
async function createContext(options: ContextOptions, existing?: OwnerMarker): Promise<RunContext> {
  checkCancelled(options.signal);
  const repoRoot = await realpath(options.repoRoot);
  await safeDirectory(repoRoot);
  const output = join(repoRoot, '.show-what-changed');
  const startedAt = new Date().toISOString();
  const runId = existing?.runId ?? `${startedAt.replace(/[-:.]/g, '')}-${randomBytes(8).toString('hex')}`;
  const runDir = join(output, 'runs', runId);
  await assertUntrackedOutputTargets(repoRoot, ['run.lock', `runs/${runId}`], options.signal);
  if (await pathExists(output)) await safeDirectory(output);
  if (await pathExists(join(output, 'runs'))) await safeDirectory(join(output, 'runs'));
  await safeDirectory(output, true);
  const lock = join(output, 'run.lock');
  try { await mkdir(lock, { mode: 0o700 }); } catch (error) { if (hasCode(error, 'EEXIST')) throw failure(2, 'RUN_ACTIVE', 'preparing', 'This repository already has a run lock.', 'Wait for its owner or inspect it with doctor; locks are never reclaimed automatically.'); throw error; }
  const lockStat = await lstat(lock);
  const privateDir = join(runDir, 'private');
  const tempDir = join(privateDir, 'workspaces');
  const resources: Resource[] = [];
  const disposed = new Set<Resource>();
  let context: RunContext | undefined;
  let marker: OwnerMarker | undefined;
  let createdRun = false;
  try {
    const identity = (await processTable()).find((row) => row.pid === process.pid);
    if (!identity) throw failure(8, 'PROCESS_INSPECTION_FAILED', 'preparing', 'Run owner identity could not be established.', 'Ensure ps is installed and accessible.');
    await safeDirectory(join(output, 'runs'), true);
    if (existing) { await safeDirectory(runDir); await assertInactive(await readOwner(runDir)); }
    else { await mkdir(runDir, { mode: 0o700 }); createdRun = true; }
    for (const path of [privateDir, tempDir, join(runDir, 'frames'), join(runDir, 'composed')]) await safeDirectory(path, true);
    marker = { schemaVersion: 1, tool: 'show-what-changed', runId, repoRoot, runDir, tempDir, owner: identity, nonce: randomBytes(16).toString('hex'), state: 'active' };
    await atomicPrivateFile(runDir, '.owner.json', JSON.stringify(marker), Boolean(existing));
    await atomicPrivateFile(lock, 'owner.json', JSON.stringify(marker), false);
    const controller = new AbortController();
    const forward = (): void => controller.abort(options.signal.reason);
    options.signal.addEventListener('abort', forward, { once: true });
    if (options.signal.aborted) forward();
    const startedMonotonicMs = performance.now();
    const deadlineMs = startedMonotonicMs + options.timeoutMs;
    const sensitive = new Set<string>();
    const redactions = { add(values: readonly string[]) { for (const value of values) if (value) sensitive.add(value); }, text(value: string) { let result = value; for (const secret of [...sensitive].sort((a, b) => b.length - a.length)) result = result.split(secret).join('[redacted]'); return sanitizeText(result); } };
    const timer = setTimeout(() => controller.abort(failure(10, 'DEADLINE_EXCEEDED', 'execution', 'The overall run deadline was reached.', 'Increase the bounded timeout or simplify the scenario.')), options.timeoutMs); timer.unref();
    const registry: ResourceRegistry = { register: (resource) => { checkCancelled(controller.signal); if (context && lifecycles.get(context)?.resourceCleanup) throw failure(5, 'RUN_STOPPED', 'cleanup', 'The run is already disposing its resources.', 'Start a new run.'); if (resources.some((existing) => existing.kind === resource.kind && existing.identity === resource.identity)) return; resources.push(resource); }, disposeAll: async () => context ? cleanupRun(context) : { status: 'ok', errors: [] } };
    context = { runId, paths: { repoRoot, runDir, privateDir, tempDir, framesDir: join(runDir, 'frames'), composedDir: join(runDir, 'composed') }, startedAt, startedMonotonicMs, redactions, deadlineMs, signal: controller.signal, diagnostics: options.diagnostics, resources: registry, supervisor: createSupervisor({ runId, privateDir, signal: controller.signal, deadlineMs, diagnostics: options.diagnostics, redactText: redactions.text, onCancel: () => { if (context) void cleanupRun(context); } }) };
    lifecycles.set(context, { resources, disposed, timer, retainOwnership: options.retainOwnership ?? false, lock: { path: lock, device: lockStat.dev, inode: lockStat.ino, nonce: marker.nonce }, marker, detach: () => options.signal.removeEventListener('abort', forward) });
    registry.register({ kind: 'workspace', identity: tempDir, dispose: async () => { await safeDirectory(tempDir); await rm(tempDir, { recursive: true, force: true }); } });

    if (existing) await registerExistingRunFiles(context);
    checkCancelled(context.signal);
    return context;
  } catch (error) {
    if (context) await releaseRunOwnership(context);
    else {
      try {
        if (existing && marker) {
          const current = await readOwner(runDir);
          if (current.nonce === marker.nonce) await atomicPrivateFile(runDir, '.owner.json', JSON.stringify(existing), true);
          else if (current.nonce !== existing.nonce) throw error;
        }
        if (createdRun) await rm(runDir, { recursive: true, force: true });
        const held = await lstat(lock);
        if (held.dev === lockStat.dev && held.ino === lockStat.ino) {
          const owned = marker && { path: lock, device: lockStat.dev, inode: lockStat.ino, nonce: marker.nonce };
          if (owned && await ownsRepositoryLock(owned)) await releaseRepositoryLock(owned);
          else await rmdir(lock);
        }
      } catch { /* An incomplete or changed lock remains blocked for manual inspection. */ }
    }
    throw error;
  }
}
export async function cleanupRun(run: RunContext): Promise<CleanupOutcome> {
  const life = lifecycles.get(run);
  if (!life) return run.resources.disposeAll();
  if (!life.cleanup) life.cleanup = (async () => {
    const cleanup = await cleanupResources(run, life);
    if (life.retainOwnership || cleanup.status === 'failed') return cleanup;
    const { status, errors } = await releaseRunOwnership(run);
    return { status, errors };
  })();
  return life.cleanup;
}
function cleanupResources(run: RunContext, life: Lifecycle): Promise<CleanupOutcome> {
  if (life.resourceCleanup) return life.resourceCleanup;
  life.resourceCleanup = (async () => {
    if (!life.retainOwnership) { clearTimeout(life.timer); life.detach(); }
    const lifetime = runCleanupLifetime(run);
    const deadline = lifetime.begin(performance.now() + 30_000);
    const errors: CleanupOutcome['errors'] = [];
    const dispose = async (kinds: Resource['kind'][]): Promise<void> => {
      for (const resource of [...life.resources].reverse().filter((resource) => kinds.includes(resource.kind))) {
        if (life.disposed.has(resource)) continue;
        try { await beforeDeadline(resource.dispose(deadline), deadline); life.disposed.add(resource); }
        catch { errors.push({ code: 'CLEANUP_FAILED', phase: 'cleanup', message: `An owned ${resource.kind} could not be removed.`, hint: 'Inspect remaining resources with doctor.' }); }
      }
    };
    await dispose(['capture']);
    await dispose(['context']);
    await dispose(['browser']);
    try { const outcome = await beforeDeadline(run.supervisor.stopAll(), deadline); errors.push(...outcome.errors); } catch { errors.push({ code: 'PROCESS_CLEANUP_FAILED', phase: 'cleanup', message: 'Owned process cleanup did not complete.', hint: 'Inspect remaining resources with doctor.' }); }
    await dispose(['builder']);
    await dispose(['container']);
    await dispose(['network']);
    await dispose(['image']);
    await dispose(['lock']);
    if (!errors.length) { await dispose(['private-dir']); await dispose(['workspace']); }
    if (!errors.length) lifetime.finish();
    return { status: errors.length ? 'failed' : 'ok', errors };
  })();
  return life.resourceCleanup;
}
async function retainedOwnership(run: RunContext, life: Lifecycle): Promise<'retained' | 'uncertain'> {
  try {
    return await ownsRepositoryLock(life.lock) && (await readOwner(run.paths.runDir)).nonce === life.marker.nonce ? 'retained' : 'uncertain';
  } catch { return 'uncertain'; }
}
export async function releaseRunOwnership(run: RunContext, commit?: OwnershipCommit): Promise<OwnershipReleaseOutcome> {
  const life = lifecycles.get(run);
  if (!life) return { status: 'failed', ownership: 'uncertain', errors: [{ code: 'OWNERSHIP_UNCERTAIN', phase: 'cleanup', message: 'The run has no registered ownership lifecycle.', hint: 'Inspect the run manually.' }] };
  if (life.release) return life.release;
  life.release = (async () => {
    const cleanup = await cleanupResources(run, life);
    try {
      if (cleanup.status === 'failed') return { ...cleanup, ownership: await retainedOwnership(run, life) };
      if (!await ownsRepositoryLock(life.lock)) throw failure(5, 'LOCK_OWNERSHIP_CHANGED', 'cleanup', 'The run lock changed ownership.', 'Inspect the lock manually.');
      const marker = await readOwner(run.paths.runDir);
      if (marker.nonce !== life.marker.nonce) throw failure(5, 'LOCK_OWNERSHIP_CHANGED', 'cleanup', 'The run ownership marker changed.', 'Inspect the run manually.');
      await atomicPrivateFile(run.paths.runDir, '.owner.json', JSON.stringify({ ...marker, state: 'inactive' }), true);
      await releaseRepositoryLock(life.lock, commit);
      return { status: 'ok', ownership: 'released', errors: [] };
    } catch {
      return { status: 'failed', ownership: await retainedOwnership(run, life), errors: [{ code: 'CLEANUP_FAILED', phase: 'cleanup', message: 'Run ownership could not be released.', hint: 'Inspect the ownership marker and repository lock with doctor.' }] };
    } finally { clearTimeout(life.timer); life.detach(); }
  })();
  return life.release;
}
