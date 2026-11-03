import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, test, vi } from 'vitest';
import type { RunContext } from '../../src/schema/contracts.js';
const hooks = vi.hoisted(() => ({ replace: false }));
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs, mkdir: async (...args: Parameters<typeof fs.mkdir>) => {
    const result = await fs.mkdir(...args); const path = String(args[0]);
    if (hooks.replace && path.includes('/docker-export-')) {
      hooks.replace = false; await fs.rename(path, `${path}-original`); await fs.mkdir(path, { mode: 0o700 });
      await fs.writeFile(join(path, 'foreign'), 'preserve');
    }
    return result;
  } };
});
import { DockerImageArchive } from '../../src/runtime/docker-archive.js';
const roots: string[] = [];
afterEach(async () => { hooks.replace = false; await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'swc-dir-repair-'))); roots.push(root);
  return { root, run: { paths: { privateDir: root }, signal: new AbortController().signal, resources: { register() {} } } as unknown as RunContext };
}
const name = 'docker-export-0123456789abcdef01234567';
test('rejects detectable replacement before identity capture and preserves its contents', async () => {
  const { root, run } = await fixture(); hooks.replace = true;
  const remove = vi.fn(async () => {}); const archive = new DockerImageArchive(run, name, remove);
  await expect(archive.runOperation(async () => {})).rejects.toMatchObject({ detail: { code: 'INVALID_IMAGE_ARCHIVE' } });
  await expect(archive.dispose(performance.now() + 1000)).rejects.toMatchObject({ detail: { code: 'INVALID_IMAGE_ARCHIVE' } });
  expect(await readFile(join(root, name, 'foreign'), 'utf8')).toBe('preserve');
  expect((await readdir(root)).sort()).toEqual([name, `${name}-original`]); expect(remove).not.toHaveBeenCalled();
});
test('never adopts a pre-existing directory even when it has private permissions', async () => {
  const { root, run } = await fixture(); await mkdir(join(root, name), { mode: 0o700 }); await writeFile(join(root, name, 'foreign'), 'preserve');
  const archive = new DockerImageArchive(run, name, async () => {});
  await expect(archive.runOperation(async () => {})).rejects.toMatchObject({ code: 'EEXIST' });
  await expect(archive.dispose(performance.now() + 1000)).rejects.toMatchObject({ code: 'EEXIST' });
  expect(await readFile(join(root, name, 'foreign'), 'utf8')).toBe('preserve');
});
