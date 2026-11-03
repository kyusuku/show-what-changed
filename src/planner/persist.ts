import { lstat, mkdir, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Plan } from '../schema/index.js';
import { failure } from '../schema/errors.js';
import { sha256 } from '../schema/io.js';
import { atomicPrivateFile, hasCode, safeDirectory } from '../runtime/files.js';
import { assertPlanOutput } from '../runtime/outputs.js';
export async function writePlan(plan: Plan): Promise<void> {
  const output = join(plan.repoRoot, '.show-what-changed');
  const ownership = await assertPlanOutput(plan.repoRoot);
  await safeDirectory(output, true);
  const lock = join(output, 'plan-write.lock');
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error) { if (hasCode(error, 'EEXIST')) throw failure(2, 'RUN_ACTIVE', 'planning', 'Another plan write is active or needs manual recovery.', 'Inspect .show-what-changed/plan-write.lock before retrying.'); throw error; }
  const held = await lstat(lock);
  const assertLock = async (): Promise<void> => {
    try {
      await safeDirectory(lock); const current = await lstat(lock);
      if (current.ino === held.ino && current.dev === held.dev && current.ctimeMs === held.ctimeMs) return;
    } catch {}
    throw failure(2, 'UNSAFE_OUTPUT', 'planning', 'The plan-write lock changed ownership.', 'Inspect the changed lock before retrying.');
  };
  try {
    const current = await assertPlanOutput(plan.repoRoot);
    if (current?.planSha256 !== ownership?.planSha256 || current?.ownerSha256 !== ownership?.ownerSha256) throw failure(2, 'UNSAFE_OUTPUT', 'planning', 'Plan ownership changed before the write lock was acquired.', 'Inspect the changed plan files before retrying.');
    const content = JSON.stringify(plan, null, 2) + '\n';
    if (Buffer.byteLength(content) > 128 * 1024 * 1024) throw failure(2, 'PLAN_TOO_LARGE', 'planning', 'The generated plan exceeds the 128 MiB plan limit.', 'Reduce explicit input size or compare a smaller supported source tree.');
    await assertLock();
    await atomicPrivateFile(output, 'plan.json', content, ownership !== null, ownership?.planSha256);
    await assertLock();
    await atomicPrivateFile(output, 'plan.owner.json', JSON.stringify({ schemaVersion: 1, tool: 'show-what-changed', sha256: sha256(content) }) + '\n', ownership !== null, ownership?.ownerSha256);
  } finally {
    await assertLock();
    try { await rmdir(lock); }
    catch (error) { if (hasCode(error, 'ENOTEMPTY') || hasCode(error, 'EEXIST')) throw failure(2, 'UNSAFE_OUTPUT', 'planning', 'The plan-write lock contains unregistered files.', 'Inspect the lock contents before retrying.'); throw error; }
  }
}
