import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, open, readFile, realpath, rm, rmdir, symlink, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, test, vi } from 'vitest';
import { plan, validateSavedPlan } from '../../src/planner/index.js';
import { sha256 } from '../../src/schema/io.js';
import { writePlan } from '../../src/planner/persist.js';
import { prepare, verify } from '../../src/workspace/index.js';
import { readTree } from '../../src/workspace/git.js';
import { diskFiles, inspectSources } from '../../src/workspace/source.js';
import { createRunContext, cleanupRun } from '../../src/runtime/context.js';
import { SourceSettingsSchema } from '../../src/schema/recipe.js';
import type { RunContext } from '../../src/schema/contracts.js';

const execute = promisify(execFile);
const roots: string[] = [];
const runs: RunContext[] = [];
const settings = SourceSettingsSchema.parse({});
async function git(root: string, ...args: string[]): Promise<string> { return (await execute('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: root })).stdout.trim(); }
async function fixture(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'swc-source-identity-'))); roots.push(root);
  await git(root, 'init', '-q'); await git(root, 'config', 'user.email', 'fixture@example.invalid'); await git(root, 'config', 'user.name', 'Source identity fixture');
  await writeFile(join(root, 'source.txt'), 'original source');
  await writeFile(join(root, 'show-what-changed.config.json'), JSON.stringify({ schemaVersion: 2, execution: { start: { kind: 'process', argv: ['node', 'server.mjs', '{port}'] }, state: { kind: 'stateless' } } }));
  await git(root, 'add', '.'); await git(root, 'commit', '-qm', 'Original'); return root;
}
async function context(root: string): Promise<RunContext> {
  const run = await createRunContext({ repoRoot: root, signal: new AbortController().signal, timeoutMs: 60_000, diagnostics: { event() {} } }); runs.push(run); return run;
}
async function sourceFile(root: string, path: string, contents: string): Promise<void> { await mkdir(join(root, path, '..'), { recursive: true }); await writeFile(join(root, path), contents); }
afterEach(async () => { for (const run of runs.splice(0)) await cleanupRun(run); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function editDuringSync(root: string, edit: () => Promise<void>, operation: () => Promise<void>): Promise<void> {
  const handle = await open(join(root, '.git/index'), 'r'); const prototype: Pick<FileHandle, 'sync'> = Object.getPrototypeOf(handle); const original = prototype.sync; await handle.close();
  const sync = vi.spyOn(prototype, 'sync').mockImplementationOnce(async function (this: FileHandle) { await edit(); return original.call(this); });
  try { await operation(); } finally { sync.mockRestore(); }
}


test.each(['commit', 'worktree'] as const)('root output-prefix application inputs retain exact %s snapshot bytes and provenance', async (kind) => {
  const root = await fixture(); const tracked = '.show-what-changed/app-data.txt';
  await sourceFile(root, tracked, 'original tracked app data'); await git(root, 'add', '.'); await git(root, 'commit', '-qm', 'Application data');
  const base = await git(root, 'rev-parse', 'HEAD');
  await writeFile(join(root, tracked), 'final app data'); await sourceFile(root, '.show-what-changed/unregistered/new.txt', 'new application data');
  if (kind === 'commit') { await git(root, 'add', '.'); await git(root, 'commit', '-qm', 'Changed data'); }
  const index = await readFile(join(root, '.git/index'));
  const selected = await plan({ invocationDir: root, base, head: kind === 'commit' ? 'HEAD' : 'WORKTREE', routes: ['/'] });
  expect(selected.inventories.after).toContainEqual(expect.objectContaining({ path: tracked, exists: true }));
  expect(selected.changedFiles).toContainEqual({ status: 'M', oldPath: tracked, newPath: tracked });
  const run = await context(root); const pair = await prepare(selected, run);
  expect(await readFile(join(pair.before.root, tracked), 'utf8')).toBe('original tracked app data');
  expect(await readFile(join(pair.after.root, tracked), 'utf8')).toBe('final app data');
  expect(await readFile(join(pair.after.root, '.show-what-changed/unregistered/new.txt'), 'utf8')).toBe('new application data');
  expect(await verify(pair, run)).toMatchObject({ before: { valid: true }, after: { valid: true } });
  await writeFile(join(pair.after.root, tracked), 'runtime mutation');
  expect(await verify(pair, run)).toMatchObject({ before: { valid: true }, after: { valid: false } });
  expect(await readFile(join(root, tracked), 'utf8')).toBe('final app data'); expect(await readFile(join(root, '.git/index'))).toEqual(index);
});

test.each(['commit', 'blob'] as const)('replacement %s objects cannot substitute bytes beneath the pinned OID', async (kind) => {
  const root = await fixture(); const original = await git(root, 'rev-parse', 'HEAD'); const originalBlob = await git(root, 'rev-parse', 'HEAD:source.txt');
  await writeFile(join(root, 'source.txt'), 'replacement source'); await git(root, 'add', '.'); await git(root, 'commit', '-qm', 'Replacement');
  const replacement = await git(root, 'rev-parse', 'HEAD'); const replacementBlob = await git(root, 'rev-parse', 'HEAD:source.txt');
  await git(root, 'replace', kind === 'commit' ? original : originalBlob, kind === 'commit' ? replacement : replacementBlob);
  const selected = await plan({ invocationDir: root, base: original, head: original, routes: ['/'] }); const run = await context(root); const pair = await prepare(selected, run);
  expect(selected.baseCommit).toBe(original); expect(selected.headCommit).toBe(original);
  for (const side of ['before', 'after'] as const) expect(await readFile(join(pair[side].root, 'source.txt'), 'utf8')).toBe('original source');
  expect(await verify(pair, run)).toMatchObject({ before: { valid: true }, after: { valid: true } });
  const changed = await plan({ invocationDir: root, base: original, head: replacement, routes: ['/'] });
  expect(changed.changedFiles).toContainEqual({ status: 'M', oldPath: 'source.txt', newPath: 'source.txt' });
  expect(await git(root, 'show', `${original}:source.txt`)).toBe('replacement source');
  expect(await git(root, 'replace', '-l')).toBe(kind === 'commit' ? original : originalBlob);
});

test('replacement refs changed after planning do not retarget pinned source or WORKTREE HEAD', async () => {
  const root = await fixture(); const original = await git(root, 'rev-parse', 'HEAD');
  const selected = await plan({ invocationDir: root, routes: ['/'] });
  await writeFile(join(root, 'source.txt'), 'replacement source'); await git(root, 'add', '.'); await git(root, 'commit', '-qm', 'Replacement'); const replacement = await git(root, 'rev-parse', 'HEAD');
  await git(root, '--no-replace-objects', 'reset', '--hard', original); await git(root, 'replace', original, replacement);
  await validateSavedPlan(selected, root);
  const run = await context(root); const pair = await prepare(selected, run);
  expect(pair.after.commit).toBe(original); expect(await readFile(join(pair.after.root, 'source.txt'), 'utf8')).toBe('original source');
  expect(await verify(pair, run)).toMatchObject({ before: { valid: true }, after: { valid: true } });
  expect(await git(root, 'rev-parse', 'HEAD')).toBe(original); expect(await git(root, 'replace', '-l')).toBe(original);
});

test('replacement ancestry cannot alter the comparison merge base', async () => {
  const root = await fixture(); const common = await git(root, 'rev-parse', 'HEAD'); const tree = await git(root, 'rev-parse', 'HEAD^{tree}');
  const left = await git(root, 'commit-tree', tree, '-p', common, '-m', 'Left'); const right = await git(root, 'commit-tree', tree, '-p', common, '-m', 'Right');
  const replacement = await git(root, 'commit-tree', tree, '-p', left, '-m', 'Replacement ancestry'); await git(root, 'replace', right, replacement);
  expect(await git(root, 'merge-base', left, right)).toBe(left);
  const selected = await inspectSources({ invocationDir: root, base: left, head: right, mergeBase: true, source: settings });
  expect(selected.baseCommit).toBe(common); expect(selected.headCommit).toBe(right); expect(await git(root, 'replace', '-l')).toBe(right);
});

test.each(['tracked', 'untracked'] as const)('unregistered %s output-prefix input counts toward source byte and file limits', async (kind) => {
  const root = await fixture(); const baseline = await inspectSources({ invocationDir: root, source: settings });
  await sourceFile(root, '.show-what-changed/app-data.txt', 'application input');
  if (kind === 'tracked') { await git(root, 'add', '.'); await git(root, 'commit', '-qm', 'Tracked data'); }
  const commit = await git(root, 'rev-parse', 'HEAD');
  if (kind === 'tracked') {
    await expect(readTree(root, commit, undefined, { ...settings, maxBytes: baseline.stats.after.bytes })).rejects.toMatchObject({ detail: { code: 'SOURCE_LIMIT' } });
    await expect(readTree(root, commit, undefined, { ...settings, maxFiles: baseline.stats.after.files })).rejects.toMatchObject({ detail: { code: 'SOURCE_LIMIT' } });
  }
  await expect(diskFiles(root, commit, undefined, { ...settings, maxBytes: baseline.stats.after.bytes })).rejects.toMatchObject({ detail: { code: 'SOURCE_LIMIT' } });
  await expect(diskFiles(root, commit, undefined, { ...settings, maxFiles: baseline.stats.after.files })).rejects.toMatchObject({ detail: { code: 'SOURCE_LIMIT' } });
});

test.each(['symlink', 'submodule'] as const)('committed output-prefix %s is rejected as unsupported source', async (kind) => {
  const root = await fixture(); const path = '.show-what-changed/application'; await mkdir(join(root, '.show-what-changed'));
  if (kind === 'symlink') { await symlink('../source.txt', join(root, path)); await git(root, 'add', '.'); }
  else await git(root, 'update-index', '--add', '--cacheinfo', `160000,${await git(root, 'rev-parse', 'HEAD')},${path}`);
  await git(root, 'commit', '-qm', 'Unsupported source');
  await expect(inspectSources({ invocationDir: root, head: 'HEAD', source: settings })).rejects.toMatchObject({ detail: { code: 'UNSUPPORTED_SOURCE_LAYOUT' } });
});

test('verified outputs are excluded before untracked traversal while tracked files win', async () => {
  const root = await fixture(); const selected = await plan({ invocationDir: root, routes: ['/'] }); await writePlan(selected); const run = await context(root);
  await sourceFile(run.paths.runDir, 'private/deep/media.txt', 'owned output');
  await symlink('missing target', join(run.paths.runDir, 'private/unreadable-input'));
  expect((await diskFiles(root, selected.headCommit, undefined, { ...settings, maxBytes: selected.sourceStats.after.bytes, maxFiles: selected.sourceStats.after.files })).inventory).toEqual(selected.inventories.after);
  await git(root, 'add', '-f', '.show-what-changed/plan.json');
  const tracked = await diskFiles(root, selected.headCommit);
  expect(tracked.inventory).toContainEqual(expect.objectContaining({ path: '.show-what-changed/plan.json', exists: true }));
  await rm(join(run.paths.runDir, 'private/unreadable-input'));
});


test('legacy grafts cannot alter comparison ancestry and remain intact', async () => {
  const root = await fixture(); const common = await git(root, 'rev-parse', 'HEAD'); const tree = await git(root, 'rev-parse', 'HEAD^{tree}');
  const left = await git(root, 'commit-tree', tree, '-p', common, '-m', 'Left'); const right = await git(root, 'commit-tree', tree, '-p', common, '-m', 'Right');
  const graft = `${right} ${left}\n`; await writeFile(join(root, '.git/info/grafts'), graft);
  expect(await git(root, 'merge-base', left, right)).toBe(left);
  const selected = await inspectSources({ invocationDir: root, base: left, head: right, mergeBase: true, source: settings });
  expect(selected.baseCommit).toBe(common); expect(await readFile(join(root, '.git/info/grafts'), 'utf8')).toBe(graft);
});

test('new snapshot ownership records cannot hide source mutation on either side', async () => {
  const root = await fixture(); const selected = await plan({ invocationDir: root, routes: ['/'] }); const run = await context(root); const pair = await prepare(selected, run);
  const bytes = '{}\n';
  for (const side of ['before', 'after'] as const) {
    await sourceFile(pair[side].root, '.show-what-changed/plan.json', bytes);
    await sourceFile(pair[side].root, '.show-what-changed/plan.owner.json', JSON.stringify({ schemaVersion: 1, tool: 'show-what-changed', sha256: sha256(bytes) }));
  }
  expect(await verify(pair, run)).toMatchObject({ before: { valid: false }, after: { valid: false } });
});

test('prior owned runs remain excluded while unregistered run contents and invalid plan records remain inputs', async () => {
  const root = await fixture(); const selected = await plan({ invocationDir: root, routes: ['/'] }); await writePlan(selected); const run = await context(root);
  await sourceFile(run.paths.runDir, 'private/media.txt', 'owned output'); expect((await cleanupRun(run)).status).toBe('ok');
  expect((await diskFiles(root, selected.headCommit)).inventory).toEqual(selected.inventories.after);
  await sourceFile(root, '.show-what-changed/runs/unregistered/app.txt', 'unregistered application data');
  await writeFile(join(root, '.show-what-changed/plan.json'), 'changed application bytes');
  const result = await diskFiles(root, selected.headCommit);
  for (const path of ['.show-what-changed/runs/unregistered/app.txt', '.show-what-changed/plan.json', '.show-what-changed/plan.owner.json']) expect(result.inventory).toContainEqual(expect.objectContaining({ path, exists: true }));
});

test.each(['plan.json', 'plan.owner.json', 'plan-write.lock'] as const)('unowned fixed %s blocks plan writes without changing bytes', async (path) => {
  const root = await fixture(); const selected = await plan({ invocationDir: root, routes: ['/'] }); await sourceFile(root, `.show-what-changed/${path}`, 'application-owned bytes');
  await expect(writePlan(selected)).rejects.toMatchObject({ exitCode: 2 });
  expect(await readFile(join(root, '.show-what-changed', path), 'utf8')).toBe('application-owned bytes');
  if (path !== 'plan.json') await expect(readFile(join(root, '.show-what-changed/plan.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  if (path !== 'plan-write.lock') await expect(readFile(join(root, '.show-what-changed/plan-write.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
});

test.each(['plan.json', 'plan.owner.json'] as const)('valid ownership cannot authorize overwriting tracked %s', async (path) => {
  const root = await fixture(); const selected = await plan({ invocationDir: root, routes: ['/'] }); await writePlan(selected);
  await git(root, 'add', `.show-what-changed/${path}`);
  const before = await readFile(join(root, '.show-what-changed', path)); const index = await readFile(join(root, '.git/index'));
  await expect(writePlan(selected)).rejects.toMatchObject({ detail: { code: 'UNSAFE_OUTPUT' } });
  expect(await readFile(join(root, '.show-what-changed', path))).toEqual(before); expect(await readFile(join(root, '.git/index'))).toEqual(index);
  await expect(readFile(join(root, '.show-what-changed/plan-write.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
});

test.each(['tracked', 'untracked'] as const)('fixed %s run lock collision preserves source before run writes', async (kind) => {
  const root = await fixture(); await sourceFile(root, '.show-what-changed/run.lock', 'application-owned lock');
  if (kind === 'tracked') { await git(root, 'add', '.'); await git(root, 'commit', '-qm', 'Tracked fixed-path conflict'); }
  await expect(context(root)).rejects.toMatchObject({ exitCode: 2 });
  expect(await readFile(join(root, '.show-what-changed/run.lock'), 'utf8')).toBe('application-owned lock');
  await expect(readFile(join(root, '.show-what-changed/runs'))).rejects.toMatchObject({ code: 'ENOENT' });
});

test.each(['file', 'symlink'] as const)('output root %s collision preserves the caller before any write', async (kind) => {
  const root = await fixture(); const selected = await plan({ invocationDir: root, routes: ['/'] });
  if (kind === 'file') await writeFile(join(root, '.show-what-changed'), 'application-owned root');
  else await symlink('source.txt', join(root, '.show-what-changed'));
  await expect(writePlan(selected)).rejects.toMatchObject({ detail: { code: 'UNSAFE_PATH' } }); await expect(context(root)).rejects.toMatchObject({ detail: { code: 'UNSAFE_PATH' } });
  expect(await readFile(join(root, 'source.txt'), 'utf8')).toBe('original source');
  expect(await readFile(join(root, '.show-what-changed'), 'utf8')).toBe(kind === 'file' ? 'application-owned root' : 'original source');
});

test.each(['plan.json', 'plan.owner.json'] as const)('concurrent %s edit during plan replacement is preserved', async (path) => {
  const root = await fixture(); const selected = await plan({ invocationDir: root, routes: ['/'] }); await writePlan(selected);
  const output = join(root, '.show-what-changed'); let changed = false;
  await editDuringSync(root, async () => { changed = true; await writeFile(join(output, path), 'concurrent application bytes'); }, async () => {
    await expect(writePlan(selected)).rejects.toMatchObject({ detail: { code: 'UNSAFE_OUTPUT' } });
  });
  expect(changed).toBe(true); expect(await readFile(join(output, path), 'utf8')).toBe('concurrent application bytes');
});

test('a replaced plan-write lock is preserved during cleanup', async () => {
  const root = await fixture(); const selected = await plan({ invocationDir: root, routes: ['/'] }); await writePlan(selected);
  const lock = join(root, '.show-what-changed/plan-write.lock'); let replaced = false;
  await editDuringSync(root, async () => {
    replaced = true; await rmdir(lock); await mkdir(lock); await writeFile(join(lock, 'application.txt'), 'preserve replacement lock');
  }, async () => { await expect(writePlan(selected)).rejects.toMatchObject({ detail: { code: 'UNSAFE_OUTPUT' } }); });
  expect(replaced).toBe(true); expect(await readFile(join(lock, 'application.txt'), 'utf8')).toBe('preserve replacement lock');
});

test('new generated application directories under the output prefix follow the ordinary source contract', async () => {
  const root = await fixture(); const path = '.show-what-changed/app-cache';
  const config = JSON.parse(await readFile(join(root, 'show-what-changed.config.json'), 'utf8')); config.source = { generatedDirs: [path] };
  await writeFile(join(root, 'show-what-changed.config.json'), JSON.stringify(config)); await git(root, 'add', '.'); await git(root, 'commit', '-qm', 'Generated application cache');
  const selected = await plan({ invocationDir: root, routes: ['/'] }); const run = await context(root); const pair = await prepare(selected, run);
  await sourceFile(pair.after.root, `${path}/built.txt`, 'generated application bytes');
  expect(await verify(pair, run)).toMatchObject({ before: { valid: true }, after: { valid: true } });
  await sourceFile(root, `${path}/preexisting.txt`, 'existing application input');
  await expect(plan({ invocationDir: root, routes: ['/'] })).rejects.toMatchObject({ detail: { code: 'GENERATED_DIR_CONFLICT' } });
});
