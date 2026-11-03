import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, truncate, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, test } from 'vitest';
import { diskFiles, inspectSources as inspect, fingerprintInventory, visitSourceFile, validateInventory, validateSourcePath } from '../../src/workspace/source.js';
import type { SourceRequest } from '../../src/schema/contracts.js';
import { readTree, visitTreeBlobs } from '../../src/workspace/git.js';
import { SourceSettingsSchema } from '../../src/schema/recipe.js';
const settings = SourceSettingsSchema.parse({});
const inspectSources = (request: Omit<SourceRequest, 'source'> & { source?: SourceRequest['source'] }, signal?: AbortSignal) => inspect({ ...request, source: request.source ?? settings }, signal);

const execute = promisify(execFile); const roots: string[] = [];
async function git(root: string, ...args: string[]): Promise<string> { return (await execute('git', args, { cwd: root })).stdout.trim(); }
async function fixture(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'swc-source-'))); roots.push(root);
  await git(root, 'init', '-q'); await git(root, 'config', 'user.email', 'fixture@example.invalid'); await git(root, 'config', 'user.name', 'Source fixture');
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'source-fixture', version: '1.0.0' }));
  await writeFile(join(root, 'package-lock.json'), JSON.stringify({ name: 'source-fixture', version: '1.0.0', lockfileVersion: 3, packages: { '': { name: 'source-fixture', version: '1.0.0' } } }));
  await writeFile(join(root, '.gitignore'), 'node_modules/\n.next/\n.env.local\n'); await writeFile(join(root, 'keep.txt'), 'initial\n');
  await git(root, 'add', '.'); await git(root, 'commit', '-qm', 'initial'); return root;
}
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('T03 measured source limits', () => {
  const limit = 512 * 1024 * 1024;
  test('rejects an oversized regular file with its measured size before reading it', async () => {
    const root = await fixture();
    await writeFile(join(root, 'oversized.bin'), ''); await truncate(join(root, 'oversized.bin'), limit + 1);
    await expect(visitSourceFile(root, 'oversized.bin', () => {})).rejects.toMatchObject({ exitCode: 2, detail: { code: 'SOURCE_LIMIT', message: expect.stringContaining(`${limit + 1} bytes`) } });
    await expect(visitSourceFile(root, 'oversized.bin', () => {})).rejects.toMatchObject({ detail: { message: expect.stringContaining(String(limit)) } });
  });
  test('reports measured aggregate bytes when individually valid files exceed the limit', async () => {
    const root = await fixture(); const commit = await git(root, 'rev-parse', 'HEAD');
    const maxBytes = 512 * 1024;
    await writeFile(join(root, '!first.bin'), Buffer.alloc(maxBytes / 2));
    await writeFile(join(root, '!second.bin'), Buffer.alloc(maxBytes / 2 + 1));
    await expect(diskFiles(root, commit, undefined, { ...settings, maxBytes })).rejects.toMatchObject({ exitCode: 2, detail: { code: 'SOURCE_LIMIT', message: expect.stringContaining(`${maxBytes + 1} bytes`) } });
  }, 15_000);
  test('accepts the exact inventory count and byte bounds and rejects one over each', () => {
    const file = { path: 'file.bin', exists: true as const, executable: false, byteLength: limit, sha256: '0'.repeat(64) };
    expect(() => validateInventory([file])).not.toThrow();
    const pair = [file, { ...file, path: 'second.bin' }];
    expect(() => validateInventory(pair)).not.toThrow();
    expect(() => validateInventory([...pair, { ...file, path: 'one-byte.bin', byteLength: 1 }])).toThrowError(expect.objectContaining({ detail: expect.objectContaining({ code: 'SOURCE_LIMIT' }) }));
    expect(() => validateInventory([...pair, { ...file, path: 'third.bin' }], { ...settings, maxBytes: 2 * 1024 ** 3 })).not.toThrow();
    expect(() => validateInventory([{ ...file, byteLength: limit + 1 }])).toThrowError(expect.objectContaining({ detail: expect.objectContaining({ message: expect.stringContaining(`${limit + 1} bytes`) }) }));
    const files = Array.from({ length: 100_000 }, (_, index) => ({ ...file, path: `file-${index}.bin`, byteLength: 0 }));
    expect(() => validateInventory(files)).not.toThrow();
    expect(() => validateInventory([...files, { ...file, path: 'one-more.bin', byteLength: 0 }])).toThrowError(expect.objectContaining({ detail: expect.objectContaining({ message: expect.stringContaining('100000 files') }) }));
  });
});

test.each(['symlink', 'submodule'] as const)('T04 names the offending committed %s path', async (kind) => {
  const root = await fixture(); const path = `nested ${kind}\nentry`;
  if (kind === 'symlink') { await symlink('keep.txt', join(root, path)); await git(root, 'add', path); }
  else { const commit = await git(root, 'rev-parse', 'HEAD'); await git(root, 'update-index', '--add', '--cacheinfo', `160000,${commit},${path}`); }
  await git(root, 'commit', '-qm', 'Unsupported committed fixture');
  await expect(inspectSources({ invocationDir: root, head: 'HEAD' })).rejects.toMatchObject({ exitCode: 2, detail: { code: 'UNSUPPORTED_SOURCE_LAYOUT', message: expect.stringContaining(JSON.stringify(path)) } });
});

describe('T04 general source layouts', () => {
  test.each(['static', 'python', 'npm', 'pnpm'])('accepts %s source without package-manager policy', async (kind) => {
    const root = await fixture();
    await git(root, 'rm', 'package.json', 'package-lock.json');
    const files: Record<string, string> = kind === 'static' ? { 'index.html': '<h1>Static</h1>' }
      : kind === 'python' ? { 'requirements.txt': 'flask==3.1.0', 'server.py': 'print("not executed")' }
      : kind === 'npm' ? { 'package.json': '{"engines":{"node":"1.x"},"dependencies":{"local":"file:../local"}}', 'package-lock.json': '{}' }
      : { 'pnpm-workspace.yaml': 'packages: [apps/*, packages/*]', 'pnpm-lock.yaml': 'lockfileVersion: 9', 'apps/web/index.html': 'shared workspace', 'packages/shared/index.ts': 'export const shared = 1;' };
    for (const [path, contents] of Object.entries(files)) { await mkdir(join(root, path, '..'), { recursive: true }); await writeFile(join(root, path), contents); }
    await git(root, 'add', '.'); await git(root, 'commit', '-qm', 'General application');
    const result = await inspectSources({ invocationDir: root, head: 'HEAD' });
    for (const path of Object.keys(files)) expect(result.inventories.after).toContainEqual(expect.objectContaining({ path, exists: true }));
  });
  test.each([
    ['assets/prohibited-lfs-pointer.txt', 'version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 3\n'],
    ['assets/a file\nwith newline.txt', 'version https://git-lfs.github.com/spec/v1\n'],
    ['nested/.gitattributes', '*.txt filter=private-filter\n'],
  ])('identifies unsupported %s without printing contents', async (path, contents) => {
    const root = await fixture(); await mkdir(join(root, path, '..'), { recursive: true }); await writeFile(join(root, path), contents);
    await expect(inspectSources({ invocationDir: root })).rejects.toMatchObject({ exitCode: 2, detail: expect.objectContaining({ code: 'UNSUPPORTED_SOURCE_LAYOUT', message: expect.stringContaining(JSON.stringify(path)) }), message: expect.not.stringMatching(/sha256:abc|private-filter/) });
  });
  test.each(['/Users/private-person/private-source.txt', '../private-source.txt', 'nested\\private-source.txt'])('does not print unsafe filename %#', (path) => {
    expect(() => validateSourcePath(path)).toThrowError(expect.objectContaining({ exitCode: 2, detail: expect.objectContaining({ code: 'UNSUPPORTED_SOURCE_LAYOUT' }), message: expect.not.stringContaining('private-source') }));
  });
  test('names external attributes by configuration and filename without exposing their absolute path or contents', async () => {
    const root = await fixture();
    const path = join(root, 'private-global-attributes');
    await writeFile(path, '*.txt filter=private-filter-command\n');
    await git(root, 'config', 'core.attributesFile', path);
    await expect(inspectSources({ invocationDir: root })).rejects.toMatchObject({
      exitCode: 2,
      detail: {
        code: 'UNSUPPORTED_SOURCE_LAYOUT', phase: 'source',
        message: expect.stringMatching(/core\.attributesFile.*private-global-attributes/),
        hint: 'Use a full checkout with regular source files, no Git filters, symlinks, submodules, or LFS pointers.',
      },
      message: expect.not.stringMatching(new RegExp(`${root}|private-filter-command`)),
    });
  });

  test('names a repository configuration condition without claiming an offending source file', async () => {
    const root = await fixture();
    await git(root, 'config', 'core.sparseCheckout', 'true');
    await expect(inspectSources({ invocationDir: root })).rejects.toMatchObject({
      exitCode: 2, detail: expect.objectContaining({ code: 'UNSUPPORTED_SOURCE_LAYOUT', phase: 'source', message: expect.stringContaining('core.sparseCheckout') }),
      message: expect.not.stringContaining(root),
    });
  });
});

describe('T02 exact source semantics', () => {
  test('WORKTREE uses final disk bytes, retained index-only deletions, absent markers and NUL filenames', async () => {
    const root = await fixture();
    await writeFile(join(root, 'keep.txt'), 'staged\n'); await git(root, 'add', 'keep.txt'); await writeFile(join(root, 'keep.txt'), 'initial\n');
    expect((await inspectSources({ invocationDir: root })).changedFiles).toEqual([]);
    await git(root, 'rm', '--cached', '-f', 'keep.txt'); await writeFile(join(root, '.gitignore'), 'node_modules/\n.next/\n.env.local\nkeep.txt\n');
    await writeFile(join(root, 'a file\nwith newline.txt'), 'new bytes'); await writeFile(join(root, '.env.local'), 'ignored secret');
    const inspection = await inspectSources({ invocationDir: root });
    expect(inspection.inventories.after.find((entry) => entry.path === 'keep.txt')).toMatchObject({ exists: true });
    expect(inspection.changedFiles.some((entry) => entry.oldPath === 'keep.txt')).toBe(false);
    expect(inspection.changedFiles).toContainEqual({ status: 'A', oldPath: null, newPath: 'a file\nwith newline.txt' });
    expect(inspection.inventories.after.some((entry) => entry.path === '.env.local')).toBe(false);
    await unlink(join(root, 'keep.txt'));
    const removed = await inspectSources({ invocationDir: root });
    expect(removed.inventories.after).toContainEqual({ path: 'keep.txt', exists: false });
    expect(removed.changedFiles).toContainEqual({ status: 'D', oldPath: 'keep.txt', newPath: null });
    expect(removed.sourceFingerprint).toBe(fingerprintInventory(removed.inventories.after));
  });
  test('exact diverged endpoints differ from their explicit merge base and do not depend on caller HEAD', async () => {
    const root = await fixture(); const common = await git(root, 'rev-parse', 'HEAD');
    await git(root, 'checkout', '-qb', 'before'); await writeFile(join(root, 'base-only.txt'), 'base'); await git(root, 'add', '.'); await git(root, 'commit', '-qm', 'base');
    const before = await git(root, 'rev-parse', 'HEAD');
    await git(root, 'checkout', '--detach', common); await writeFile(join(root, 'after-only.txt'), 'after'); await git(root, 'add', '.'); await git(root, 'commit', '-qm', 'head'); const after = await git(root, 'rev-parse', 'HEAD');
    await git(root, 'checkout', '--detach', common);
    const exact = await inspectSources({ invocationDir: root, base: before, head: after });
    expect(exact.baseCommit).toBe(before); expect(exact.headCommit).toBe(after);
    expect(exact.changedFiles).toContainEqual({ status: 'D', oldPath: 'base-only.txt', newPath: null });
    expect(exact.changedFiles).toContainEqual({ status: 'A', oldPath: null, newPath: 'after-only.txt' });
    const merged = await inspectSources({ invocationDir: root, base: before, head: after, mergeBase: true });
    expect(merged.baseCommit).toBe(common); expect(merged.changedFiles).toHaveLength(1);
    await expect(inspectSources({ invocationDir: root, base: '--help' })).rejects.toMatchObject({ detail: { code: 'INVALID_REF' } });
    await expect(inspectSources({ invocationDir: root, base: 'not-fetched-ref' })).rejects.toMatchObject({ exitCode: 2 });
  });
  test('renames are exact deletion and addition entries', async () => {
    const root = await fixture(); const base = await git(root, 'rev-parse', 'HEAD'); await git(root, 'mv', 'keep.txt', 'moved.txt'); await git(root, 'commit', '-qm', 'rename');
    expect((await inspectSources({ invocationDir: root, base, head: 'HEAD' })).changedFiles).toEqual([{ status: 'D', oldPath: 'keep.txt', newPath: null }, { status: 'A', oldPath: null, newPath: 'moved.txt' }]);
  });
});
describe('T04 read-only full preflight', () => {
  test('configured filters and source attributes fail without running a filter', async () => {
    const root = await fixture(); const sentinel = join(root, 'filter-ran');
    await git(root, 'config', 'filter.evil.clean', `touch ${sentinel}`);
    await expect(inspectSources({ invocationDir: root })).rejects.toMatchObject({ detail: { code: 'UNSUPPORTED_SOURCE_LAYOUT', message: expect.stringContaining('Git configuration') }, message: expect.not.stringContaining(sentinel) });
    await expect(readFile(sentinel)).rejects.toMatchObject({ code: 'ENOENT' });
    await git(root, 'config', '--remove-section', 'filter.evil'); await writeFile(join(root, '.gitattributes'), '*.txt filter=evil\n');
    await expect(inspectSources({ invocationDir: root })).rejects.toMatchObject({ detail: { code: 'UNSUPPORTED_SOURCE_LAYOUT', message: expect.stringContaining('.gitattributes') } });
    await expect(readFile(sentinel)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  test.each([['lfs', 'keep.txt'], ['symlink', 'link.txt'], ['transition', 'keep.txt']])('rejects unsupported %s before execution and identifies %s', async (kind, path) => {
    const root = await fixture();
    if (kind === 'lfs') await writeFile(join(root, 'keep.txt'), 'version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 3\n');
    if (kind === 'symlink') await symlink('/etc/passwd', join(root, 'link.txt'));
    if (kind === 'transition') { await unlink(join(root, 'keep.txt')); await mkdir(join(root, 'keep.txt')); await writeFile(join(root, 'keep.txt', 'child.txt'), 'child'); }
    await expect(inspectSources({ invocationDir: root })).rejects.toMatchObject({ exitCode: 2, detail: { code: 'UNSUPPORTED_SOURCE_LAYOUT', phase: 'source', message: expect.stringContaining(path) }, message: expect.not.stringContaining(root) });
  });
  test('preflight checks unsafe BEFORE-only source inputs', async () => {
    const root = await fixture(); await writeFile(join(root, 'keep.txt'), 'version https://git-lfs.github.com/spec/v1\n'); await git(root, 'add', '.'); await git(root, 'commit', '-qm', 'unsupported base'); const base = await git(root, 'rev-parse', 'HEAD');
    await writeFile(join(root, 'keep.txt'), 'fixed'); await git(root, 'add', '.'); await git(root, 'commit', '-qm', 'supported head');
    await expect(inspectSources({ invocationDir: root, base, head: 'HEAD' })).rejects.toMatchObject({ detail: { code: 'UNSUPPORTED_SOURCE_LAYOUT' } });
  });
});

test('T04 rejects committed submodules, invalid UTF-8 names and sparse checkout configuration', async () => {
  const root = await fixture(); const commit = await git(root, 'rev-parse', 'HEAD');
  await git(root, 'update-index', '--add', '--cacheinfo', `160000,${commit},nested`); await git(root, 'commit', '-qm', 'submodule');
  await expect(inspectSources({ invocationDir: root, head: 'HEAD' })).rejects.toMatchObject({ detail: { code: 'UNSUPPORTED_SOURCE_LAYOUT' } });
  await git(root, 'reset', '--hard', commit);
  const blob = await git(root, 'rev-parse', 'HEAD:keep.txt');
  const invalid = Buffer.concat([Buffer.from(`100644 ${blob}\t`), Buffer.from([255, 0])]);
  await new Promise<void>((resolve, reject) => { const child = spawn('git', ['update-index', '-z', '--index-info'], { cwd: root, stdio: ['pipe', 'ignore', 'pipe'] }); child.once('error', reject); child.once('close', (code) => code === 0 ? resolve() : reject(new Error('Invalid-path fixture creation failed'))); child.stdin.end(invalid); });
  await expect(inspectSources({ invocationDir: root })).rejects.toMatchObject({ detail: { code: 'UNSUPPORTED_SOURCE_LAYOUT' } }); await git(root, 'reset', '--mixed', 'HEAD');
  await git(root, 'config', 'core.sparseCheckout', 'true');
  await expect(inspectSources({ invocationDir: root })).rejects.toMatchObject({ detail: { code: 'UNSUPPORTED_SOURCE_LAYOUT' } });
});

test('T02 pre-cancelled inspection preserves the cancellation reason', async () => {
  const root = await fixture(); const control = new AbortController(); control.abort();
  await expect(inspectSources({ invocationDir: root }, control.signal)).rejects.toMatchObject({ exitCode: 10 });
});

test.each(['npm:string-width@^4.2.0', 'npm:@scope/package@2.0.0', 'npm:package@stable', 'npm:package'])('T04 accepts a public registry alias %s', async (value) => {
  const root = await fixture();
  const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
  lock.packages['node_modules/parent'] = { resolved: 'https://registry.npmjs.org/parent/-/parent-1.0.0.tgz', dependencies: { alias: value } };
  await writeFile(join(root, 'package-lock.json'), JSON.stringify(lock));
  await expect(inspectSources({ invocationDir: root })).resolves.toMatchObject({ headKind: 'worktree' });
});

test.each(['npm:package@file:../private', 'npm:package@npm:other', 'npm:package@git+ssh://private/repo', 'npm:../../private'])('T04 leaves declared dependency policy to runtime %s', async (value) => {
  const root = await fixture();
  const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
  lock.packages['node_modules/parent'] = { dependencies: { alias: value } };
  await writeFile(join(root, 'package-lock.json'), JSON.stringify(lock));
  await expect(inspectSources({ invocationDir: root })).resolves.toMatchObject({ headKind: 'worktree' });
});

test('T02 rejects zero and multiple merge bases instead of selecting an arbitrary ancestor', async () => {
  const root = await fixture(); const common = await git(root, 'rev-parse', 'HEAD'); const tree = await git(root, 'rev-parse', 'HEAD^{tree}');
  const orphan = await git(root, 'commit-tree', tree, '-m', 'unrelated');
  await expect(inspectSources({ invocationDir: root, base: orphan, head: common, mergeBase: true })).rejects.toMatchObject({ detail: { code: 'AMBIGUOUS_MERGE_BASE' } });
  const a = await git(root, 'commit-tree', tree, '-p', common, '-m', 'a'); const b = await git(root, 'commit-tree', tree, '-p', common, '-m', 'b');
  const left = await git(root, 'commit-tree', tree, '-p', a, '-p', b, '-m', 'left'); const right = await git(root, 'commit-tree', tree, '-p', b, '-p', a, '-m', 'right');
  await expect(inspectSources({ invocationDir: root, base: left, head: right, mergeBase: true })).rejects.toMatchObject({ detail: { code: 'AMBIGUOUS_MERGE_BASE' } });
});

test('T03 retains tracked static, build, dependency, and nested tool-name paths', async () => {
  const root = await fixture();
  const files = ['dist/site.html', 'build/input.js', 'node_modules/vendored/source.js', '.next/tracked.css', 'docs/dist/static.txt', 'nested/.show-what-changed/input.txt'];
  for (const path of files) { await mkdir(join(root, path, '..'), { recursive: true }); await writeFile(join(root, path), path); await git(root, 'add', '-f', path); }
  await git(root, 'commit', '-qm', 'tracked inputs');
  const result = await inspectSources({ invocationDir: root });
  for (const path of files) expect(result.inventories.after).toContainEqual(expect.objectContaining({ path, exists: true }));
  await mkdir(join(root, '.show-what-changed')); await writeFile(join(root, '.show-what-changed/plan.json'), '{}');
  expect((await inspectSources({ invocationDir: root })).inventories.after).toContainEqual(expect.objectContaining({ path: '.show-what-changed/plan.json', exists: true }));
});

test('T03 generated directories cannot cover endpoint or pre-existing eligible input', async () => {
  const root = await fixture(); const base = await git(root, 'rev-parse', 'HEAD');
  for (const generatedDirs of [['keep.txt'], ['new-output']]) {
    if (generatedDirs[0] === 'new-output') { await mkdir(join(root, 'new-output')); await writeFile(join(root, 'new-output/existing.txt'), 'pre-existing input'); }
    await expect(inspectSources({ invocationDir: root, head: 'HEAD', source: { ...settings, generatedDirs } })).rejects.toMatchObject({ detail: { code: 'GENERATED_DIR_CONFLICT' } });
  }
  await git(root, 'rm', 'keep.txt'); await git(root, 'commit', '-qm', 'remove input');
  await expect(inspectSources({ invocationDir: root, base, head: 'HEAD', source: { ...settings, generatedDirs: ['keep.txt'] } })).rejects.toMatchObject({ detail: { code: 'GENERATED_DIR_CONFLICT' } });
});

test('T03 streams a source blob beyond the obsolete 200 MiB repository cap', async () => {
  const root = await fixture(); const size = 224 * 1024 * 1024;
  await writeFile(join(root, 'large.bin'), ''); await truncate(join(root, 'large.bin'), size); await git(root, 'add', 'large.bin'); await git(root, 'commit', '-qm', 'streamed volume fixture');
  const result = await inspectSources({ invocationDir: root, head: 'HEAD' });
  expect(result.stats.before.bytes).toBeGreaterThan(size); expect(result.stats.after.bytes).toBe(result.stats.before.bytes);
  const expected = await visitSourceFile(root, 'large.bin', () => {});
  expect(result.inventories.after.find((entry) => entry.path === 'large.bin')).toEqual(expected);
  const entries = await readTree(root, result.headCommit);
  expect(entries.every((entry) => !('bytes' in entry))).toBe(true);
  let streamedBytes = 0; let largestChunk = 0;
  await visitTreeBlobs(root, entries.filter((entry) => entry.path === 'large.bin'), async (_entry, chunks) => { for await (const chunk of chunks) { streamedBytes += chunk.length; largestChunk = Math.max(largestChunk, chunk.length); } });
  expect(streamedBytes).toBe(size); expect(largestChunk).toBeLessThanOrEqual(64 * 1024);
}, 30_000);

test('T03 streamed disk reads respond to cancellation between bounded chunks', async () => {
  const root = await fixture(); await writeFile(join(root, 'streamed.bin'), Buffer.alloc(1024 * 1024));
  const control = new AbortController(); let consumed = 0;
  await expect(visitSourceFile(root, 'streamed.bin', (chunk) => { consumed += chunk.length; control.abort(); }, control.signal)).rejects.toMatchObject({ exitCode: 10 });
  expect(consumed).toBe(64 * 1024);
});
