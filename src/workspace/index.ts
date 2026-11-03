import { constants } from 'node:fs';
import { chmod, lstat, open, rename, rm, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { getSystemErrorName } from 'node:util';
import type { Plan, Provenance, Side } from '../schema/index.js';
import type { RunContext, SourceInventory, Workspace, WorkspacePair } from '../schema/contracts.js';
import { checkCancelled, failure, ToolFailure } from '../schema/errors.js';
import { hasCode, safeDirectory } from '../runtime/files.js';
import { gitBytes, gitText } from './git.js';
import { byteSort, diskFiles, fingerprintInventory, inspectSources, preflightGit, validateSourcePath, visitSourceFile } from './source.js';

async function materializeOperation<T>(side: Side, operation: () => Promise<T>, gitMutation = false): Promise<T> {
  try { return await operation(); }
  catch (error) {
    const filesystemFailure = error instanceof Error && 'errno' in error && typeof error.errno === 'number' && Number.isSafeInteger(error.errno) && error.errno < 0 && 'syscall' in error && typeof error.syscall === 'string' && 'code' in error && getSystemErrorName(error.errno) === error.code;
    const gitFailure = gitMutation && error instanceof ToolFailure && error.exitCode === 2 && error.detail.code === 'GIT_FAILED';
    if (!filesystemFailure && !gitFailure) throw error;
    throw new ToolFailure(5, { code: 'WORKSPACE_FAILED', phase: 'preparing', side, message: 'The isolated source workspace could not be prepared.', hint: 'Check filesystem permissions, available disk space, and repository worktree state, then retry.' }, { cause: error });
  }
}
async function snapshotInventory(root: string, commit: string, settings: Plan['config']['source'], expected?: SourceInventory, generatedDirs: readonly string[] = [], signal?: AbortSignal): Promise<SourceInventory> {
  const { inventory } = await diskFiles(root, commit, signal, settings, generatedDirs, { files: [], directories: [] });
  const paths = new Set(inventory.map((entry) => entry.path));
  return [...inventory, ...(expected ?? []).filter((entry) => !entry.exists && !paths.has(entry.path))].sort((a, b) => byteSort(a.path, b.path));
}
async function copyFinalSource(source: string, destination: string, expected: SourceInventory, run: RunContext): Promise<void> {
  for (const entry of expected) {
    checkCancelled(run.signal); validateSourcePath(entry.path);
    const output = join(destination, entry.path);
    if (!entry.exists) {
      try { await safeDirectory(dirname(output)); const stat = await lstat(output); if (!stat.isFile() || stat.isSymbolicLink()) throw failure(2, 'UNSUPPORTED_SOURCE_LAYOUT', 'preparing', 'An overlay target is not a regular file.', 'Rerun with a supported source layout.'); await unlink(output); } catch (error) { if (!hasCode(error, 'ENOENT')) throw error; }
      continue;
    }
    await safeDirectory(dirname(output), true);
    try { const target = await lstat(output); if (!target.isFile() || target.isSymbolicLink()) throw failure(2, 'UNSUPPORTED_SOURCE_LAYOUT', 'preparing', 'An overlay target is not a regular file.', 'Use a supported source layout.'); } catch (error) { if (!hasCode(error, 'ENOENT')) throw error; }
    const temporary = join(dirname(output), `.swc-copy-${randomBytes(12).toString('hex')}`);
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, entry.executable ? 0o700 : 0o600);
    try {
      const actual = await visitSourceFile(source, entry.path, async (chunk) => { await handle.writeFile(chunk); }, run.signal);
      await handle.sync(); await handle.close(); await safeDirectory(dirname(output)); await rename(temporary, output); await chmod(output, entry.executable ? 0o700 : 0o600);
      if (!actual || actual.sha256 !== entry.sha256 || actual.byteLength !== entry.byteLength || actual.executable !== entry.executable) throw failure(2, 'STALE_SOURCE', 'preparing', 'Source or snapshot bytes changed during copying.', 'Rerun after source edits finish.');
    } finally { await handle.close().catch(() => {}); await unlink(temporary).catch((error: unknown) => { if (!hasCode(error, 'ENOENT')) throw error; }); }
  }
}
export async function prepare(plan: Plan, run: RunContext): Promise<WorkspacePair> {
  checkCancelled(run.signal);
  const inspection = await inspectSources({ invocationDir: plan.repoRoot, base: plan.baseCommit, head: plan.headKind === 'worktree' ? 'WORKTREE' : plan.headCommit, source: plan.config.source }, run.signal);
  if (inspection.repoRoot !== run.paths.repoRoot || inspection.baseCommit !== plan.baseCommit || inspection.headCommit !== plan.headCommit || inspection.sourceFingerprint !== plan.sourceFingerprint || fingerprintInventory(inspection.inventories.before) !== fingerprintInventory(plan.inventories.before) || fingerprintInventory(inspection.inventories.after) !== fingerprintInventory(plan.inventories.after)) throw failure(2, 'STALE_PLAN', 'preparing', 'The selected source no longer matches the plan.', 'Regenerate the plan before execution.');
  const materialize = async (side: Side): Promise<Workspace> => materializeOperation<Workspace>(side, async () => {
    checkCancelled(run.signal);
    const commit = side === 'before' ? plan.baseCommit : plan.headCommit;
    const root = join(run.paths.tempDir, side);
    await safeDirectory(run.paths.tempDir);
    run.resources.register({ kind: 'workspace', identity: root, dispose: async () => {
      try { await safeDirectory(root); } catch (error) { if (hasCode(error, 'ENOENT')) return; throw error; }
      await gitBytes(plan.repoRoot, ['worktree', 'remove', '--force', root]);
      await rm(root, { recursive: true, force: true });
    } });
    await materializeOperation(side, () => gitBytes(plan.repoRoot, ['worktree', 'add', '--detach', '--no-checkout', root, commit], { signal: run.signal }), true);
    await chmod(root, 0o700);
    await preflightGit(root, run.signal);
    if (await gitText(root, ['rev-parse', '--show-toplevel'], run.signal) !== root) throw failure(2, 'UNSUPPORTED_SOURCE_LAYOUT', 'preparing', 'Git redirected the managed worktree outside its registered root.', 'Remove unsupported Git worktree configuration.');
    await materializeOperation(side, () => gitBytes(root, ['-c', `core.worktree=${root}`, 'reset', '--hard', commit], { signal: run.signal }), true);
    if (side === 'after' && plan.headKind === 'worktree') {
      const intended = inspection.inventories.after;
      await copyFinalSource(plan.repoRoot, root, intended, run);
      const original = await diskFiles(plan.repoRoot, plan.headCommit, run.signal, plan.config.source);
      const actual = await snapshotInventory(root, commit, plan.config.source, intended, [], run.signal);
      if (fingerprintInventory(original.inventory) !== plan.sourceFingerprint || fingerprintInventory(actual) !== plan.sourceFingerprint) throw failure(2, 'STALE_SOURCE', 'preparing', 'Source or snapshot bytes changed during copying.', 'Rerun after source edits finish.');
    }
    const inventory = await snapshotInventory(root, commit, plan.config.source, side === 'after' && plan.headKind === 'worktree' ? inspection.inventories.after : undefined, [], run.signal);
    if (fingerprintInventory(inventory) !== fingerprintInventory(plan.inventories[side])) throw failure(2, 'STALE_SOURCE', 'preparing', 'Materialized source differs from its planned inventory.', 'Regenerate the source plan.');
    await preflightGit(root, run.signal);
    return { side, root, commit, kind: side === 'after' ? plan.headKind : 'commit', label: side === 'after' && plan.headKind === 'worktree' ? `WORKTREE at ${commit.slice(0, 12)}` : commit.slice(0, 12), inventory, sourceSettings: plan.config.source, materializedHash: fingerprintInventory(inventory) };
  });
  const before = await materialize('before'); const after = await materialize('after');
  return { before, after };
}
export async function verify(workspaces: WorkspacePair, run: RunContext): Promise<Provenance> {
  const verifySide = async (workspace: Workspace): Promise<Provenance['before']> => {
    try {
      const inventory = await snapshotInventory(workspace.root, workspace.commit, workspace.sourceSettings, workspace.inventory, workspace.sourceSettings.generatedDirs, run.signal);
      const actualHash = fingerprintInventory(inventory);
      if (actualHash !== workspace.materializedHash) return { valid: false, actualHash, errors: [{ code: 'SOURCE_MUTATED', phase: 'provenance', side: workspace.side, message: 'The app changed its supplied source files.', hint: 'Use an app that writes generated outputs only into ignored directories.' }] };
      return { valid: true, actualHash, errors: [] };
    } catch { return { valid: false, actualHash: null, errors: [{ code: 'SOURCE_MUTATED', phase: 'provenance', side: workspace.side, message: 'The supplied source can no longer be verified.', hint: 'Inspect source-writing application or install scripts.' }] }; }
  };
  return { before: await verifySide(workspaces.before), after: await verifySide(workspaces.after) };
}
