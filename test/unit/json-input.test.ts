import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { readJsonDocument, sha256 } from '../../src/schema/io.js';

it('rejects a named pipe without waiting for a writer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'swc-json-pipe-'));
  try {
    const path = join(root, 'input.json');
    execFileSync('mkfifo', [path]);
    await expect(readJsonDocument(path)).rejects.toThrow('regular file');
  } finally { await rm(root, { recursive: true, force: true }); }
}, 2000);

it('returns the parsed document and hash from the same file bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'swc-json-bytes-'));
  try {
    const path = join(root, 'input.json');
    const contents = '{ "schemaVersion": 1 }\n';
    await writeFile(path, contents);
    expect(await readJsonDocument(path)).toEqual({ value: { schemaVersion: 1 }, rawSha256: sha256(contents) });
  } finally { await rm(root, { recursive: true, force: true }); }
});
