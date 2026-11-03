import { lstat, mkdtemp, opendir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { RunIdSchema, Sha256Schema } from '../schema/index.js';
import { checkCancelled, failure } from '../schema/errors.js';
import { digest, sha256 } from '../schema/io.js';
import { gitBytes, nulStrings } from '../workspace/git.js';
import { hasCode, readContainedFile, safeDirectory } from './files.js';
import { OwnerMarkerSchema, readOwner } from './ownership.js';

export const PlanOwnerSchema = z.strictObject({ schemaVersion: z.literal(1), tool: z.literal('show-what-changed'), sha256: Sha256Schema });
export type OutputPaths = Readonly<{ files: readonly string[]; directories: readonly string[] }>;
export type PlanOwnership = Readonly<{ planSha256: string; ownerSha256: string }>;
export async function pathExists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) { if (hasCode(error, 'ENOENT')) return false; throw error; }
}
export async function readPlanOwnership(repoRoot: string): Promise<PlanOwnership | null> {
  const output = join(repoRoot, '.show-what-changed');
  try {
    const bytes = await readContainedFile(output, 'plan.owner.json', 4096);
    const owner = PlanOwnerSchema.parse(JSON.parse(bytes.toString('utf8')));
    const plan = await readContainedFile(output, 'plan.json', 128 * 1024 * 1024);
    if (sha256(plan) !== owner.sha256 || !bytes.equals(await readContainedFile(output, 'plan.owner.json', 4096))) return null;
    return { planSha256: owner.sha256, ownerSha256: sha256(bytes) };
  } catch { return null; }
}
export async function registeredOutputPaths(repoRoot: string, signal?: AbortSignal): Promise<OutputPaths> {
  const output = join(repoRoot, '.show-what-changed');
  if (!await pathExists(output)) return { files: [], directories: [] };
  await safeDirectory(output);
  const files: string[] = []; const directories: string[] = [];
  if (await readPlanOwnership(repoRoot)) files.push('.show-what-changed/plan.json', '.show-what-changed/plan.owner.json');
  const runs = join(output, 'runs');
  if (await pathExists(runs)) {
    await safeDirectory(runs);
    for await (const entry of await opendir(runs)) {
      if (signal) checkCancelled(signal);
      if (!entry.isDirectory() || !RunIdSchema.safeParse(entry.name).success) continue;
      try {
        const marker = await readOwner(join(runs, entry.name));
        if (marker.repoRoot === repoRoot) directories.push(`.show-what-changed/runs/${entry.name}`);
      } catch {}
    }
  }
  try {
    const owner = OwnerMarkerSchema.parse(JSON.parse((await readContainedFile(output, 'run.lock/owner.json', 65536)).toString('utf8')));
    if (owner.repoRoot === repoRoot && digest(await readOwner(owner.runDir)) === digest(owner)) files.push('.show-what-changed/run.lock/owner.json');
  } catch {}
  return { files, directories };
}
export async function assertUntrackedOutputTargets(repoRoot: string, paths: readonly string[], signal?: AbortSignal): Promise<void> {
  if (!await pathExists(join(repoRoot, '.git'))) return;
  const options = signal ? { signal } : {};
  const head = nulStrings(await gitBytes(repoRoot, ['ls-tree', '-rz', '--name-only', 'HEAD', '--', '.show-what-changed'], options));
  const index = nulStrings(await gitBytes(repoRoot, ['ls-files', '--cached', '-z', '--', '.show-what-changed'], options));
  const targets = paths.map((path) => `.show-what-changed/${path}`);
  if ([...head, ...index].some((path) => targets.some((target) => path === target || path.startsWith(`${target}/`) || target.startsWith(`${path}/`)))) {
    throw failure(2, 'UNSAFE_OUTPUT', 'artifacts', 'A required output path overlaps tracked source.', 'Move the tracked application file or choose a repository without a fixed output-path conflict.');
  }
}
export async function assertPlanOutput(repoRoot: string): Promise<PlanOwnership | null> {
  const output = join(repoRoot, '.show-what-changed');
  await assertUntrackedOutputTargets(repoRoot, ['plan.json', 'plan.owner.json', 'plan-write.lock']);
  if (!await pathExists(output)) return null;
  await safeDirectory(output);
  const ownership = await readPlanOwnership(repoRoot);
  if (!ownership && (await pathExists(join(output, 'plan.json')) || await pathExists(join(output, 'plan.owner.json')))) {
    throw failure(2, 'UNSAFE_OUTPUT', 'planning', 'The existing plan files do not have matching ownership records.', 'Move the existing plan and ownership record aside before generating a replacement.');
  }
  return ownership;
}

export async function untrackedSourcePaths(repoRoot: string, outputs: OutputPaths, signal?: AbortSignal): Promise<string[]> {
  const patterns = [...outputs.files.map((path) => `/${path}`), ...outputs.directories.map((path) => `/${path}/`)];
  const args = ['ls-files', '--others', '--exclude-standard', '-z'];
  if (!patterns.length) return nulStrings(await gitBytes(repoRoot, args, signal ? { signal } : {}));
  const temporary = await mkdtemp(join(tmpdir(), 'swc-output-excludes-'));
  try {
    const path = join(temporary, 'excludes');
    await writeFile(path, `${patterns.join('\n')}\n`, { flag: 'wx', mode: 0o600 });
    return nulStrings(await gitBytes(repoRoot, [...args, `--exclude-from=${path}`], signal ? { signal } : {}));
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
