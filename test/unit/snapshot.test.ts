import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, test } from 'vitest';
import { plan } from '../../src/planner/index.js';
import { prepare, verify } from '../../src/workspace/index.js';
import { createRunContext, cleanupRun } from '../../src/runtime/context.js';
import type { RunContext } from '../../src/schema/contracts.js';

const execute = promisify(execFile); const roots: string[] = []; const runs: RunContext[] = [];
async function git(root: string, ...args: string[]): Promise<string> { return (await execute('git', args, { cwd: root })).stdout.trim(); }
async function fixture(install = ''): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'swc-snapshot-'))); roots.push(root);
  await git(root, 'init', '-q'); await git(root, 'config', 'user.email', 'fixture@example.invalid'); await git(root, 'config', 'user.name', 'Snapshot fixture');
  const manifest = { name: 'snapshot-fixture', version: '1.0.0', scripts: install ? { postinstall: install } : {} };
  await writeFile(join(root, 'package.json'), JSON.stringify(manifest));
  await writeFile(join(root, 'package-lock.json'), JSON.stringify({ name: manifest.name, version: manifest.version, lockfileVersion: 3, packages: { '': { name: manifest.name, version: manifest.version, ...(install ? { hasInstallScript: true } : {}) } } }));
  await writeFile(join(root, '.gitignore'), 'node_modules/\n.next/\n'); await writeFile(join(root, 'source.txt'), 'initial\n');
  await writeFile(join(root, 'show-what-changed.config.json'), JSON.stringify({ schemaVersion: 2, execution: { start: { kind: 'process', argv: ['node', 'server.mjs', '{port}'] }, state: { kind: 'stateless' } } }));
  await git(root, 'add', '.'); await git(root, 'commit', '-qm', 'initial'); return root;
}
async function context(root: string, signal = new AbortController().signal): Promise<RunContext> { const run = await createRunContext({ repoRoot: root, signal, timeoutMs: 60_000, diagnostics: { event() {} } }); runs.push(run); return run; }
afterEach(async () => { for (const run of runs.splice(0)) await cleanupRun(run); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('T03 independent immutable snapshots', () => {
  test('preserves caller index, source, ignored dependencies and hooks while copying final filesystem bytes', async () => {
    const root = await fixture('node -e "require(\'fs\').mkdirSync(\'node_modules\', {recursive:true});require(\'fs\').writeFileSync(\'node_modules/side\', process.env.SWC_SIDE)"');
    await mkdir(join(root, 'node_modules')); await writeFile(join(root, 'node_modules', 'caller'), 'do not mutate');
    await writeFile(join(root, '.git', 'hooks', 'post-checkout'), '#!/bin/sh\ntouch hook-ran\n', { mode: 0o755 });
    await writeFile(join(root, 'source.txt'), 'staged'); await git(root, 'add', 'source.txt'); await writeFile(join(root, 'source.txt'), 'final disk'); await writeFile(join(root, 'new source.txt'), 'untracked');
    const index = await readFile(join(root, '.git', 'index')); const head = await git(root, 'rev-parse', 'HEAD');
    const selected = await plan({ invocationDir: root, routes: ['/'] }); const run = await context(root); const workspaces = await prepare(selected, run);
    expect(await readFile(join(workspaces.before.root, 'source.txt'), 'utf8')).toBe('initial\n'); expect(await readFile(join(workspaces.after.root, 'source.txt'), 'utf8')).toBe('final disk');
    expect(await readFile(join(workspaces.after.root, 'new source.txt'), 'utf8')).toBe('untracked');
    await expect(readFile(join(workspaces.before.root, 'node_modules', 'side'))).rejects.toMatchObject({ code: 'ENOENT' }); await expect(readFile(join(workspaces.after.root, 'node_modules', 'side'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(root, '.git', 'index'))).toEqual(index); expect(await git(root, 'rev-parse', 'HEAD')).toBe(head); expect(await readFile(join(root, 'node_modules', 'caller'), 'utf8')).toBe('do not mutate');
    await expect(readFile(join(root, 'hook-ran'))).rejects.toMatchObject({ code: 'ENOENT' });
    await writeFile(join(root, 'source.txt'), 'later caller edits'); expect(await readFile(join(workspaces.after.root, 'source.txt'), 'utf8')).toBe('final disk');
    expect(await verify(workspaces, run)).toMatchObject({ before: { valid: true }, after: { valid: true } });
    expect(await cleanupRun(run)).toEqual({ status: 'ok', errors: [] });
    expect(await git(root, 'worktree', 'list', '--porcelain')).not.toContain(workspaces.after.root);
    expect(await readFile(join(root, '.git', 'index'))).toEqual(index);
  }, 30_000);
  test.each(['source.txt', 'new-untracked-source.txt'])('detects post-preparation source mutation of %s', async (path) => {
    const root = await fixture(`node -e "require('fs').writeFileSync('${path}', 'mutated')"`);
    const selected = await plan({ invocationDir: root, routes: ['/'] }); const run = await context(root);
    const workspaces = await prepare(selected, run);
    await writeFile(join(workspaces.after.root, path), 'mutated');
    expect(await verify(workspaces, run)).toMatchObject({ before: { valid: true }, after: { valid: false, errors: [{ code: 'SOURCE_MUTATED' }] } });
    expect(await cleanupRun(run)).toEqual({ status: 'ok', errors: [] });
    expect(await readFile(join(root, 'source.txt'), 'utf8')).toBe('initial\n');
  }, 30_000);
  test('rejects changed source after planning and detects new files on either materialized side', async () => {
    const root = await fixture(); const selected = await plan({ invocationDir: root, routes: ['/'] }); const run = await context(root);
    await writeFile(join(root, 'source.txt'), 'later'); await expect(prepare(selected, run)).rejects.toMatchObject({ exitCode: 2, detail: { code: 'STALE_PLAN' } });
    const fresh = await plan({ invocationDir: root, routes: ['/'] }); const workspaces = await prepare(fresh, run);
    await writeFile(join(workspaces.before.root, 'new-source.ts'), 'new'); await writeFile(join(workspaces.after.root, 'new-source.ts'), 'new');
    expect(await verify(workspaces, run)).toMatchObject({ before: { valid: false }, after: { valid: false } });
  }, 30_000);
});

test('T03 rejects a real concurrent source edit during snapshot copying', async () => {
  const root = await fixture(); await writeFile(join(root, '!large.bin'), Buffer.alloc(16 * 1024 * 1024, 65)); await git(root, 'add', '.'); await git(root, 'commit', '-qm', 'copy race fixture');
  const selected = await plan({ invocationDir: root, routes: ['/'] }); const run = await context(root);
  const writer = await run.supervisor.spawn({ argv: [process.execPath, '-e', "const fs=require('fs');const path=require('path');const root=process.argv[1],after=process.argv[2];process.stdout.write('ready');setInterval(()=>{if(fs.existsSync(path.join(after,'source.txt'))){fs.writeFileSync(path.join(root,'source.txt'),'concurrent edit '+Date.now());}},1)", root, join(run.paths.tempDir, 'after')], cwd: root, purpose: 'probe' });
  while (!writer.output().stdout.includes('ready')) await new Promise((resolve) => setTimeout(resolve, 5));
  try { await expect(prepare(selected, run)).rejects.toMatchObject({ exitCode: 2, detail: { code: 'STALE_SOURCE' } }); }
  finally { await run.supervisor.stop(writer); }
  expect((await cleanupRun(run)).status).toBe('ok');
}, 30_000);

test('T04 cancelled preparation preserves caller files and starts no install process', async () => {
  const root = await fixture("node -e \"require('fs').writeFileSync('install-started','ready')\"");
  const selected = await plan({ invocationDir: root, routes: ['/'] }); const control = new AbortController(); const run = await context(root, control.signal);
  control.abort();
  await expect(prepare(selected, run)).rejects.toMatchObject({ exitCode: 10 }); expect((await cleanupRun(run)).status).toBe('ok');
  expect(await readFile(join(root, 'source.txt'), 'utf8')).toBe('initial\n'); await expect(readFile(join(root, 'install-started'))).rejects.toMatchObject({ code: 'ENOENT' });
}, 20_000);

test('T03 rejects a change-and-restore race by checking actual destination bytes', async () => {
  const root = await fixture(); const name = '!race.bin'; const size = 16 * 1024 * 1024;
  await writeFile(join(root, name), Buffer.alloc(size, 65)); await git(root, 'add', '.'); await git(root, 'commit', '-qm', 'ABA copy fixture');
  const selected = await plan({ invocationDir: root, routes: ['/'] }); const run = await context(root); const after = join(run.paths.tempDir, 'after');
  const script = "const fs=require('fs');const path=require('path');const [root,after]=process.argv.slice(1);process.stdout.write('ready');const poll=setInterval(()=>{if(!fs.existsSync(after))return;for(const name of fs.readdirSync(after)){if(!name.startsWith('.swc-copy-'))continue;try{if(fs.statSync(path.join(after,name)).size<65536)continue;}catch{continue;}fs.writeFileSync(path.join(root,'!race.bin'),Buffer.alloc(16*1024*1024,66));fs.writeFileSync(path.join(root,'!race.bin'),Buffer.alloc(16*1024*1024,65));process.stdout.write('restored');clearInterval(poll);return;}},1)";
  const writer = await run.supervisor.spawn({ argv: [process.execPath, '-e', script, root, after], cwd: root, purpose: 'probe' });
  while (!writer.output().stdout.includes('ready')) await new Promise((resolve) => setTimeout(resolve, 5));
  try {
    await expect(prepare(selected, run)).rejects.toMatchObject({ exitCode: 2, detail: { code: 'STALE_SOURCE' } });
    const restoredUntil = Date.now() + 5000;
    while (!writer.output().stdout.includes('restored') && Date.now() < restoredUntil) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(writer.output().stdout).toContain('restored'); expect((await readFile(join(root, name)))[0]).toBe(65);
  } finally { await run.supervisor.stop(writer); }
  expect((await cleanupRun(run)).status).toBe('ok');
}, 30_000);

test('T04 checks conditional linked-worktree Git filters before any checkout conversion', async () => {
  const root = await fixture(); const sentinel = join(root, '.git', 'filter-ran'); const config = join(root, '.git', 'conditional-config'); const attributes = join(root, '.git', 'conditional-attributes');
  await writeFile(attributes, '*.txt filter=fixture\n');
  await writeFile(config, `[filter "fixture"]\n smudge = "touch ${sentinel}; cat"\n[core]\n attributesFile = ${attributes}\n`);
  await git(root, 'config', `includeIf.gitdir:${root}/.git/worktrees/.path`, config);
  const selected = await plan({ invocationDir: root, routes: ['/'] }); const run = await context(root);
  await expect(prepare(selected, run)).rejects.toMatchObject({ detail: { code: 'UNSUPPORTED_SOURCE_LAYOUT' } });
  await expect(readFile(sentinel)).rejects.toMatchObject({ code: 'ENOENT' }); expect((await cleanupRun(run)).status).toBe('ok');
});


test('T03 separate same-OID workspaces retain tracked build directories and declared generated outputs', async () => {
  const root = await fixture();
  for (const path of ['dist/static.txt', 'build/input.txt', 'docs/dist/guide.txt', 'nested/.show-what-changed/source.txt']) { await mkdir(join(root, path, '..'), { recursive: true }); await writeFile(join(root, path), path); }
  const config = JSON.parse(await readFile(join(root, 'show-what-changed.config.json'), 'utf8'));
  config.source = { generatedDirs: ['generated'] }; await writeFile(join(root, 'show-what-changed.config.json'), JSON.stringify(config));
  await git(root, 'add', '.'); await git(root, 'commit', '-qm', 'tracked source outputs');
  const selected = await plan({ invocationDir: root, head: 'HEAD', routes: ['/'] }); const run = await context(root); const pair = await prepare(selected, run);
  expect(pair.before.commit).toBe(pair.after.commit); expect(pair.before.root).not.toBe(pair.after.root);
  for (const side of ['before', 'after'] as const) {
    expect(await readFile(join(pair[side].root, 'dist/static.txt'), 'utf8')).toBe('dist/static.txt');
    await mkdir(join(pair[side].root, 'generated')); await writeFile(join(pair[side].root, 'generated/output.txt'), 'new generated output');
  }
  expect(await verify(pair, run)).toMatchObject({ before: { valid: true }, after: { valid: true } });
  await writeFile(join(pair.after.root, 'outside-generated.txt'), 'new input');
  expect(await verify(pair, run)).toMatchObject({ after: { valid: false } });
}, 30_000);
