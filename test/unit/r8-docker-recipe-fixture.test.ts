import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { sha256 } from '../../src/schema/io.js';

const execute = promisify(execFile);

test('public Docker recipe setup consumes the bound seed and produces distinct side build inputs without Docker', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'swc-r8-docker-fixture-')));
  try {
    const seed = await readFile(new URL('../fixtures/r8-docker-seed.json', import.meta.url));
    const seedPath = join(root, 'seed.json'); await writeFile(seedPath, seed);
    const observed: Record<string, unknown> = {};
    for (const side of ['before', 'after']) {
      const workspace = join(root, side), state = join(workspace, 'state'); await mkdir(state, { recursive: true });
      await execute(process.execPath, [fileURLToPath(new URL('../fixtures/r8-docker-setup.cjs', import.meta.url))], {
        cwd: workspace,
        env: { ...process.env, SIDE: side, SEED: seedPath, DATA: state, PORT: '4321', APP_ORIGIN: 'http://127.0.0.1:4321', DB_HOST: '127.0.0.1', DB_PORT: '4322' },
        timeout: 5000, maxBuffer: 1024 * 1024,
      });
      const generated = JSON.parse(await readFile(join(workspace, 'generated/runtime.json'), 'utf8'));
      expect(generated).toEqual({ side, seedSha256: sha256(seed) }); observed[side] = generated;
      expect(JSON.parse(await readFile(join(state, 'setup.json'), 'utf8')).generated).toEqual(generated);
    }
    expect(observed.before).not.toEqual(observed.after);
    expect(await readFile(seedPath)).toEqual(seed);
  } finally { await rm(root, { recursive: true, force: true }); }
});
