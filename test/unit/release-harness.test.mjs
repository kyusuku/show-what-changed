import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, test } from 'vitest';
import { command, sourceState } from '../../scripts/release-harness.mjs';
import { gitEnvironment } from '../../scripts/git-env.mjs';

test('release fixtures cannot mutate or inspect a different repository through inherited Git variables', async () => {
  const root = await mkdtemp(join(tmpdir(), 'swc-git-environment-'));
  const caller = join(root, 'caller'); const fixture = join(root, 'fixture');
  const identity = { GIT_AUTHOR_NAME: 'Synthetic Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Synthetic Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  const original = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE };
  const direct = (cwd, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args], { cwd, env: gitEnvironment(identity), encoding: 'utf8' }).trim();
  try {
    await mkdir(caller); await mkdir(fixture);
    direct(caller, 'init', '--initial-branch=main', '--template=');
    await writeFile(join(caller, 'existing.txt'), 'Caller source remains unchanged.\n');
    direct(caller, 'add', '--all'); direct(caller, 'commit', '-m', 'Caller baseline');
    await writeFile(join(caller, 'untracked.txt'), 'Do not commit this caller input.\n');
    const head = direct(caller, 'rev-parse', 'HEAD');
    const index = await readFile(join(caller, '.git', 'index'));
    process.env.GIT_DIR = join(caller, '.git'); process.env.GIT_WORK_TREE = caller;
    await writeFile(join(fixture, 'fixture.txt'), 'Only this file belongs to the fixture.\n');
    for (const args of [['init', '--initial-branch=main', '--template='], ['add', '--all'], ['-c', 'commit.gpgSign=false', 'commit', '-m', 'Fixture baseline']]) {
      await command(['git', ...args], fixture, { expectedCode: 0, env: identity });
    }
    expect(direct(caller, 'rev-parse', 'HEAD')).toBe(head);
    expect(await readFile(join(caller, '.git', 'index'))).toEqual(index);
    expect(direct(caller, 'ls-files')).toBe('existing.txt');
    expect(direct(fixture, 'ls-files')).toBe('fixture.txt');
    const state = await sourceState(fixture);
    expect(state.head).toBe(direct(fixture, 'rev-parse', 'HEAD'));
    expect(state.files.map((file) => file.path)).toEqual(['fixture.txt']);
  } finally {
    for (const [name, value] of Object.entries(original)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    await rm(root, { recursive: true, force: true });
  }
});
