import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, rmdirSync, unlinkSync } from 'node:fs';
import { lstat, mkdir, open, readdir, rm, rmdir, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import type { CleanReport, DoctorReport } from '../schema/index.js';
import { RunIdSchema } from '../schema/index.js';
import { failure } from '../schema/errors.js';
import { atomicPrivateFile, hasCode, readRunFile, safeDirectory } from './files.js';
import { processTable, systemProbe } from './process-table.js';
import { releasePortReservations } from './ports.js';
import { DockerRuntime, inspectDockerResidue } from './docker.js';
import { gitBytes } from '../workspace/git.js';

export const OwnerMarkerSchema = z.strictObject({ schemaVersion: z.literal(1), tool: z.literal('show-what-changed'), runId: RunIdSchema, repoRoot: z.string(), runDir: z.string(), tempDir: z.string(), owner: z.strictObject({ pid: z.number().int().positive(), parent: z.number().int().nonnegative(), group: z.number().int().positive(), started: z.string().min(1) }), nonce: z.string().regex(/^[a-f0-9]{32}$/), state: z.enum(['active', 'inactive']) });
export type OwnerMarker = z.infer<typeof OwnerMarkerSchema>;
export type OwnershipState = 'released' | 'retained' | 'uncertain';
export type RepositoryLock = { path: string; device: number; inode: number; nonce: string; ownerRemoved?: boolean };
export type OwnershipCommit = (release: () => void) => Promise<void>;
export async function ownsRepositoryLock(lock: RepositoryLock): Promise<boolean> {
  try {
    await safeDirectory(lock.path);
    const current = await lstat(lock.path);
    if (current.dev !== lock.device || current.ino !== lock.inode) return false;
    if (!lock.ownerRemoved) {
      const marker = OwnerMarkerSchema.parse(JSON.parse((await readRunFile(lock.path, 'owner.json', 65536)).toString('utf8')));
      if (marker.nonce !== lock.nonce) return false;
    } else try { await lstat(join(lock.path, 'owner.json')); return false; } catch (error) { if (!hasCode(error, 'ENOENT')) return false; }
    return true;
  } catch { return false; }
}
function readOwnerFileSync(path: string): OwnerMarker {
  const file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(file);
    if (!stat.isFile() || stat.size > 65536) throw new Error('Invalid lock owner');
    const bytes = Buffer.alloc(stat.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const count = readSync(file, bytes, size, bytes.length - size, null);
      if (!count) break;
      size += count;
    }
    const after = fstatSync(file);
    const named = lstatSync(path);
    if (size !== stat.size || after.size !== stat.size || after.ctimeMs !== stat.ctimeMs || after.mtimeMs !== stat.mtimeMs || !named.isFile() || named.dev !== stat.dev || named.ino !== stat.ino) throw new Error('Lock owner changed');
    return OwnerMarkerSchema.parse(JSON.parse(bytes.subarray(0, size).toString('utf8')));
  } finally { closeSync(file); }
}
function releaseRepositoryLockSync(lock: RepositoryLock): void {
  const current = lstatSync(lock.path);
  if (!current.isDirectory() || current.dev !== lock.device || current.ino !== lock.inode || realpathSync(lock.path) !== lock.path) throw failure(5, 'LOCK_OWNERSHIP_CHANGED', 'cleanup', 'The repository lock changed ownership.', 'Inspect the lock manually.');
  const ownerPath = join(lock.path, 'owner.json');
  if (!lock.ownerRemoved) {
    const marker = readOwnerFileSync(ownerPath);
    if (marker.nonce !== lock.nonce || realpathSync(marker.runDir) !== marker.runDir || readOwnerFileSync(join(marker.runDir, '.owner.json')).nonce !== lock.nonce) throw failure(5, 'LOCK_OWNERSHIP_CHANGED', 'cleanup', 'The repository lock or run marker changed ownership.', 'Inspect the lock manually.');
    unlinkSync(ownerPath); lock.ownerRemoved = true;
  } else {
    try { lstatSync(ownerPath); throw new Error('Lock owner reappeared'); } catch (error) { if (!hasCode(error, 'ENOENT')) throw error; }
  }
  rmdirSync(lock.path);
}
export async function releaseRepositoryLock(lock: RepositoryLock, commit?: OwnershipCommit): Promise<void> {
  if (!await ownsRepositoryLock(lock)) throw failure(5, 'LOCK_OWNERSHIP_CHANGED', 'cleanup', 'The repository lock changed ownership.', 'Inspect the lock manually.');
  if (commit) {
    let attempted = false;
    let released = false;
    await commit(() => {
      if (attempted) throw new Error('Repository ownership release was already attempted');
      attempted = true;
      releaseRepositoryLockSync(lock); released = true;
    });
    if (!released) throw new Error('Repository ownership was retained');
    return;
  }
  if (!lock.ownerRemoved) { await unlink(join(lock.path, 'owner.json')); lock.ownerRemoved = true; }
  await rmdir(lock.path);
}

export async function readOwner(runDir: string): Promise<OwnerMarker> {
  await safeDirectory(runDir);
  const parsed = OwnerMarkerSchema.safeParse(JSON.parse((await readRunFile(runDir, '.owner.json', 65536)).toString('utf8')));
  if (!parsed.success) throw failure(2, 'OWNERSHIP_UNCERTAIN', 'cleanup', 'The run ownership marker is invalid.', 'Inspect the run manually.');
  const marker = parsed.data;
  if (marker.runDir !== resolve(runDir) || marker.runDir !== join(marker.repoRoot, '.show-what-changed', 'runs', marker.runId) || marker.tempDir !== join(marker.runDir, 'private', 'workspaces')) throw failure(2, 'OWNERSHIP_UNCERTAIN', 'cleanup', 'The run ownership paths do not match their registered locations.', 'Use an intact tool-owned run.');
  await safeDirectory(marker.repoRoot);
  return marker;
}
export async function assertInactive(marker: OwnerMarker): Promise<void> {
  const rows = await processTable();
  if (marker.state === 'active' && rows.some((row) => row.pid === marker.owner.pid && row.started === marker.owner.started)) throw failure(2, 'RUN_ACTIVE', 'cleanup', 'The run owner is still active.', 'Wait for the owning run to finish.');
  const schema = z.array(z.strictObject({ pid: z.number().int().positive(), group: z.number().int().positive(), started: z.string().nullable() }));
  let groups: z.infer<typeof schema> = [];
  for (const ledger of ['private/processes.json', 'private/docker-cleanup/processes.json']) {
    try { groups.push(...schema.parse(JSON.parse((await readRunFile(marker.runDir, ledger, 1024 * 1024)).toString('utf8')))); }
    catch (error) { if (!hasCode(error, 'ENOENT')) throw failure(2, 'OWNERSHIP_UNCERTAIN', 'cleanup', 'Process ownership records could not be validated.', 'Inspect the run manually.'); }
  }
  if (groups.some((group) => rows.some((row) => row.group === group.group))) throw failure(2, 'RUN_ACTIVE', 'cleanup', 'A recorded process group is still present or its identity is uncertain.', 'Inspect and stop remaining processes manually before cleaning.');
  const probe = await systemProbe(['lsof', '-nP', '-a', '-d', 'cwd', '-Fpn'], 5000);
  if (probe.code !== 0) throw failure(2, 'OWNERSHIP_UNCERTAIN', 'cleanup', 'Workspace activity could not be inspected.', 'Ensure lsof can inspect processes before cleaning.');
  if (probe.stdout.split('\n').some((line) => line.startsWith(`n${marker.tempDir}/`) || line === `n${marker.tempDir}`)) throw failure(2, 'RUN_ACTIVE', 'cleanup', 'A process is using an owned workspace.', 'Stop it manually before cleaning.');
}
export async function removeOwnedWorkspaces(marker: OwnerMarker): Promise<void> {
  try { await safeDirectory(marker.tempDir); } catch (error) { if (hasCode(error, 'ENOENT')) return; throw error; }
  const entries = await readdir(marker.tempDir);
  if (!entries.length) { await rm(marker.tempDir, { recursive: true }); return; }
  if (entries.some((name) => name !== 'before' && name !== 'after')) throw failure(2, 'OWNERSHIP_UNCERTAIN', 'cleanup', 'The workspace root contains an unregistered path.', 'Inspect the workspace residue manually.');
  const registered = (await gitBytes(marker.repoRoot, ['worktree', 'list', '--porcelain', '-z'])).toString('utf8').split('\0').filter((part) => part.startsWith('worktree ')).map((part) => part.slice(9));
  for (const side of entries) {
    const path = join(marker.tempDir, side); await safeDirectory(path);
    if (registered.includes(path)) await gitBytes(marker.repoRoot, ['worktree', 'remove', '--force', path]);
    else { if (!(await lstat(path)).isDirectory()) throw failure(2, 'OWNERSHIP_UNCERTAIN', 'cleanup', 'A workspace is not a directory.', 'Inspect the residue manually.'); await rm(path, { recursive: true }); }
  }
  await rm(marker.tempDir, { recursive: true, force: true });
}
export async function inspectOwnedRuns(repoRoot: string): Promise<DoctorReport['abandonedRuns']> {
  const runs = join(repoRoot, '.show-what-changed', 'runs');
  try { await safeDirectory(runs); } catch (error) { if (hasCode(error, 'ENOENT')) return []; throw error; }
  const results: DoctorReport['abandonedRuns'] = [];
  for (const name of await readdir(runs)) {
    if (!RunIdSchema.safeParse(name).success) { results.push({ runId: name, state: 'uncertain', hint: 'Unrecognized output entry; inspect it manually.' }); continue; }
    try {
      const marker = await readOwner(join(runs, name));
      if (marker.state === 'inactive') continue;
      try { await assertInactive(marker); const docker = await inspectDockerResidue(marker.runDir, marker.runId); results.push({ runId: name, state: 'abandoned', hint: docker ? 'Owner is gone; recorded Docker resources or unresolved creation intents remain. Clean this exact run to reconcile them.' : 'Owner is gone and no recorded activity remains. Clean this exact run to remove residue.' }); }
      catch { results.push({ runId: name, state: 'active-or-uncertain', hint: 'Inspect the owning process and workspace activity manually.' }); }
    } catch { results.push({ runId: name, state: 'uncertain', hint: 'Ownership marker is invalid; no automatic deletion is safe.' }); }
  }
  return results;
}
export async function cleanOwnedRun(repoRoot: string, runId: string): Promise<CleanReport> {
  if (!RunIdSchema.safeParse(runId).success) throw failure(2, 'INVALID_RUN_ID', 'cleanup', 'Clean requires one exact generated run ID.', 'Use a run ID reported by doctor.');
  const runDir = join(repoRoot, '.show-what-changed', 'runs', runId);
  const marker = await readOwner(runDir);
  if (marker.repoRoot !== repoRoot) throw failure(2, 'OWNERSHIP_UNCERTAIN', 'cleanup', 'The run belongs to another repository.', 'Run clean at the owning repository.');
  const lockPath = join(repoRoot, '.show-what-changed', 'run.lock');
  await safeDirectory(join(repoRoot, '.show-what-changed'));
  let created = false;
  try { await mkdir(lockPath, { mode: 0o700 }); created = true; }
  catch (error) { if (!hasCode(error, 'EEXIST')) throw error; }
  let lock: RepositoryLock | undefined;
  let claim: string | undefined;
  let validated = false; let cleanupStarted = false; let cleanupFinished = false;
  try {
    await safeDirectory(lockPath);
    const held = await lstat(lockPath);
    lock = { path: lockPath, device: held.dev, inode: held.ino, nonce: marker.nonce };
    if (created) {
      const identity = (await processTable()).find((row) => row.pid === process.pid);
      if (!identity) throw failure(2, 'OWNERSHIP_UNCERTAIN', 'cleanup', 'The cleanup owner could not be established.', 'Ensure ps is available.');
      await atomicPrivateFile(lockPath, 'owner.json', JSON.stringify({ ...marker, owner: identity, state: 'active' }), false);
      validated = true;
    } else {
      let lockMarker: OwnerMarker;
      try { lockMarker = OwnerMarkerSchema.parse(JSON.parse((await readRunFile(lockPath, 'owner.json', 65536)).toString('utf8'))); }
      catch { throw failure(2, 'OWNERSHIP_UNCERTAIN', 'cleanup', 'The repository lock is incomplete or invalid.', 'Inspect the lock manually; an incomplete lock is never treated as absent.'); }
      if (lockMarker.nonce !== marker.nonce || lockMarker.runId !== runId || lockMarker.repoRoot !== repoRoot || lockMarker.runDir !== runDir || lockMarker.tempDir !== marker.tempDir) throw failure(2, 'RUN_ACTIVE', 'cleanup', 'A different run owns the repository lock.', 'Wait for that run to finish.');
      await assertInactive({ ...lockMarker, state: 'active' });
      const claimPath = join(lockPath, 'clean.claim');
      let file: Awaited<ReturnType<typeof open>>;
      try { file = await open(claimPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
      catch (error) { if (hasCode(error, 'EEXIST')) throw failure(2, 'RUN_ACTIVE', 'cleanup', 'Another cleanup owns or may own this repository lock.', 'Wait for it to finish or inspect the lock manually.'); throw error; }
      claim = claimPath;
      await file.close();
      if (!await ownsRepositoryLock(lock)) throw failure(2, 'OWNERSHIP_UNCERTAIN', 'cleanup', 'The repository lock changed while cleanup claimed it.', 'Inspect the run manually.');
      await assertInactive({ ...lockMarker, state: 'active' });
      validated = true;
    }
    const current = await readOwner(runDir);
    if (current.nonce !== marker.nonce) throw failure(2, 'OWNERSHIP_UNCERTAIN', 'cleanup', 'The run changed while cleanup acquired ownership.', 'Retry after the owning operation finishes.');
    await assertInactive(current);
    cleanupStarted = true;
    await DockerRuntime.recover(current.runDir, current.runId);
    await releasePortReservations(current.runDir, current.runId);
    await removeOwnedWorkspaces(current);
    await safeDirectory(runDir); await rm(runDir, { recursive: true });
    cleanupFinished = true;
    return { schemaVersion: 2, runId, removed: true };
  } finally {
    if (claim && lock && await ownsRepositoryLock(lock)) await unlink(claim);
    if (lock && (validated || created && await ownsRepositoryLock(lock))) { if (!cleanupStarted || cleanupFinished) await releaseRepositoryLock(lock); }
    else if (created && lock) {
      const held = await lstat(lockPath).catch(() => undefined);
      if (held?.dev === lock.device && held.ino === lock.inode) await rmdir(lockPath).catch(() => {});
    }
  }
}
