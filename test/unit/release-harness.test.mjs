import { execFileSync } from 'node:child_process';
import { copyFile, mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, test } from 'vitest';
import { command, installCandidate, sourceState } from '../../scripts/release-harness.mjs';
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

test('installed CLI failures retain private process evidence before every validation gate and preserve the primary error if saving fails', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'swc-release-evidence-')));
  const packageRoot = join(root, 'package');
  const reports = join(root, 'private');
  try {
    for (const directory of ['dist/cli', 'dist/recorder', 'dist/schema', 'schema', 'skills/show-what-changed', 'assets/fonts']) await mkdir(join(packageRoot, directory), { recursive: true });
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: 'show-what-changed', version: '0.0.0', type: 'module', bin: { 'show-what-changed': 'dist/cli/index.js' } }));
    await writeFile(join(packageRoot, 'dist/cli/index.js'), '#!/usr/bin/env node\nprocess.stdout.write(process.env.SWC_TEST_OUTPUT); process.stderr.write("PRIVATE_STDERR"); process.exitCode = Number(process.env.SWC_TEST_EXIT);\n', { mode: 0o755 });
    await writeFile(join(packageRoot, 'dist/schema/index.js'), 'export const ResultSchema = { parse(value) { if (value.valid !== true) throw new Error("PRIVATE_SCHEMA_REJECTION"); return value; } };\n');
    for (const file of ['dist/recorder/mask-worker.js', 'dist/recorder/masker.js', 'skills/show-what-changed/SKILL.md', 'assets/fonts/Inter-Regular.woff2', 'assets/fonts/OFL.txt', 'assets/fonts/provenance.json', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md']) await writeFile(join(packageRoot, file), 'Synthetic harness fixture.\n');
    for (const name of ['capture', 'config', 'manifest', 'plan', 'result', 'scenario', 'timeline']) await copyFile(new URL(`../../schema/${name}.v2.json`, import.meta.url), join(packageRoot, `schema/${name}.v2.json`));
    const archive = join(root, 'show-what-changed-0.0.0.tgz');
    execFileSync('npm', ['pack', '--ignore-scripts', '--pack-destination', root], { cwd: packageRoot, stdio: 'pipe' });
    const candidate = await installCandidate(archive, root, reports);
    for (const [name, stdout, actualExit, stage] of [
      ['nonzero', '{"valid":true,"exitCode":6}', 6, 'process'],
      ['malformed', 'PRIVATE_NOT_JSON', 0, 'json'],
      ['schema', '{"private":"PRIVATE_SCHEMA_VALUE"}', 0, 'schema'],
      ['envelope', '{"valid":true,"exitCode":2}', 0, 'envelope-exit'],
    ]) {
      const pending = candidate.cli(name, ['PRIVATE_ARGUMENT'], root, 0, { SWC_TEST_OUTPUT: stdout, SWC_TEST_EXIT: String(actualExit) });
      expect(candidate.commands.at(-1).name).toBe(name);
      const error = await pending.then(() => { throw new Error('Expected installed CLI rejection'); }, (failure) => failure);
      expect(error.validationStage).toBe(stage);
      expect(error.result).toMatchObject({ code: actualExit, stdout, stderr: 'PRIVATE_STDERR' });
      const path = join(reports, name + '.json');
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(error.result);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect(candidate.commands.at(-1)).toMatchObject({ name, validationStage: stage, actualExit });
    }
    await rm(reports, { recursive: true });
    await writeFile(reports, 'Block the private evidence directory.\n');
    const error = await candidate.cli('save-failed', [], root, 0, { SWC_TEST_OUTPUT: 'PRIVATE_FAILED_OUTPUT', SWC_TEST_EXIT: '6' }).catch((failure) => failure);
    expect(error.message).toMatch(/^Command failed:/);
    expect(error.result).toMatchObject({ code: 6, stdout: 'PRIVATE_FAILED_OUTPUT' });
    expect(error.evidenceError).toBeInstanceOf(Error);
    expect(error.validationStage).toBe('process');
    const saveError = await candidate.cli('save-failed-success', [], root, 0, { SWC_TEST_OUTPUT: '{"valid":true,"exitCode":0}', SWC_TEST_EXIT: '0' }).catch((failure) => failure);
    expect(saveError.validationStage).toBe('evidence');
    expect(saveError.result.code).toBe(0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
