import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, describe, expect, test } from 'vitest';
import { createRunContext, cleanupRun, reopenRunContext } from '../../src/runtime/context.js';
import { artifactInfo, readRunFile, renameRunFile, writeRunFile } from '../../src/runtime/files.js';
import { cleanOwnedRun, inspectOwnedRuns } from '../../src/runtime/ownership.js';
import type { RunContext } from '../../src/schema/contracts.js';

const roots: string[] = []; const runs: RunContext[] = [];
async function root(): Promise<string> { const path = await realpath(await mkdtemp(join(tmpdir(), 'swc-runtime-'))); roots.push(path); return path; }
async function context(path: string, timeoutMs = 60_000, signal = new AbortController().signal): Promise<RunContext> { const run = await createRunContext({ repoRoot: path, signal, timeoutMs, diagnostics: { event() {} } }); runs.push(run); return run; }
afterEach(async () => { for (const run of runs.splice(0)) await cleanupRun(run); await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe('T13 private artifact containment and ownership', () => {
  test('writes private atomic files, rejects unowned replacement and follows no symlink ancestor', async () => {
    const path = await root(); const run = await context(path);
    await writeRunFile(run, 'frames/000.png', Buffer.from('one')); await writeRunFile(run, 'frames/000.png', Buffer.from('two'));
    expect(await readRunFile(run.paths.runDir, 'frames/000.png', 5)).toEqual(Buffer.from('two'));
    expect((await stat(join(run.paths.runDir, 'frames/000.png'))).mode & 0o777).toBe(0o600);
    expect((await artifactInfo(run.paths.runDir, 'frames/000.png')).bytes).toBe(3);
    await writeFile(join(run.paths.runDir, 'foreign.txt'), 'user-owned'); await expect(writeRunFile(run, 'foreign.txt', 'replace')).rejects.toMatchObject({ detail: { code: 'UNSAFE_OUTPUT' } });
    await expect(writeRunFile(run, '../escape.txt', 'escape')).rejects.toMatchObject({ detail: { code: 'UNSAFE_PATH' } });
    await symlink(path, join(run.paths.runDir, 'link'));
    await expect(writeRunFile(run, 'link/escape.txt', 'escape')).rejects.toMatchObject({ detail: { code: 'UNSAFE_PATH' } });
    await expect(readRunFile(run.paths.runDir, 'link/package.json', 10)).rejects.toMatchObject({ detail: { code: 'UNSAFE_PATH' } });
    await expect(readFile(join(path, 'escape.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    await rm(join(run.paths.runDir, 'link'));
  });
  test('refuses symlink output root and duplicate locks; cleanup is idempotent', async () => {
    const path = await root(); const elsewhere = await root(); await symlink(elsewhere, join(path, '.show-what-changed'));
    await expect(context(path)).rejects.toMatchObject({ detail: { code: 'UNSAFE_PATH' } });
    await rm(join(path, '.show-what-changed')); const run = await context(path);
    await expect(context(path)).rejects.toMatchObject({ detail: { code: 'RUN_ACTIVE' } });
    await expect(cleanOwnedRun(path, run.runId)).rejects.toMatchObject({ detail: { code: 'RUN_ACTIVE' } });
    expect(await cleanupRun(run)).toEqual({ status: 'ok', errors: [] }); expect(await cleanupRun(run)).toEqual({ status: 'ok', errors: [] });
    await expect(cleanOwnedRun(path, '../elsewhere')).rejects.toMatchObject({ detail: { code: 'INVALID_RUN_ID' } });
  });
  test('reopens a completed owned run and safely replaces existing media and metadata', async () => {
    const path = await root(); const run = await context(path); await writeRunFile(run, 'compare.mp4', 'old media'); await writeRunFile(run, 'manifest.json', '{}'); expect((await cleanupRun(run)).status).toBe('ok');
    const resumed = await reopenRunContext({ runDir: run.paths.runDir, signal: new AbortController().signal, timeoutMs: 10_000, diagnostics: { event() {} } }); runs.push(resumed);
    await writeRunFile(resumed, 'private/001.part.mp4', 'new media'); await renameRunFile(resumed, 'private/001.part.mp4', 'compare.mp4'); await writeRunFile(resumed, 'manifest.json', '{"updated":true}');
    expect(await readRunFile(run.paths.runDir, 'compare.mp4', 100)).toEqual(Buffer.from('new media')); expect((await cleanupRun(resumed)).status).toBe('ok');
    expect(await inspectOwnedRuns(path)).toEqual([]);
    expect(await cleanOwnedRun(path, run.runId)).toEqual({ schemaVersion: 2, runId: run.runId, removed: true });
  });
  test('does not reclaim a stale PID lock automatically', async () => {
    const path = await root(); const run = await context(path); const marker = JSON.parse(await readFile(join(run.paths.runDir, '.owner.json'), 'utf8'));
    marker.owner.pid = 99999999; marker.owner.started = 'not an actual identity'; await writeFile(join(path, '.show-what-changed', 'run.lock', 'owner.json'), JSON.stringify(marker));
    await expect(context(path)).rejects.toMatchObject({ detail: { code: 'RUN_ACTIVE' } });
    await writeFile(join(path, '.show-what-changed', 'run.lock', 'owner.json'), await readFile(join(run.paths.runDir, '.owner.json')));
  });
  test('failed resource disposal produces failed cleanup and preserves the lock', async () => {
    const path = await root(); const run = await context(path); run.resources.register({ kind: 'workspace', identity: 'failure-fixture', dispose: async () => { throw new Error('deliberate deletion failure'); } });
    expect((await cleanupRun(run)).status).toBe('failed');
    await expect(context(path)).rejects.toMatchObject({ detail: { code: 'RUN_ACTIVE' } });
  });
});
describe('T12 real process supervision', () => {
  test('keeps only the allowlisted environment and drains stdout before reporting exit', async () => {
    const path = await root(); const run = await context(path); process.env.SWC_TEST_SECRET_TOKEN = 'must-not-propagate';
    try {
      const child = await run.supervisor.spawn({ argv: [process.execPath, '-e', "process.stdout.write(JSON.stringify({secret:process.env.SWC_TEST_SECRET_TOKEN,side:process.env.SWC_SIDE,port:process.env.PORT,run:process.env.SWC_RUN_ID}));process.stdout.write('x'.repeat(1024*1024))"], cwd: path, purpose: 'probe', captureStdout: true, side: 'after', port: 4321 });
      expect((await child.exited).code).toBe(0); const output = child.output().stdout;
      expect(output).not.toContain('must-not-propagate'); expect(output).toContain('"side":"after"'); expect(output).toContain('"port":"4321"'); expect(output.endsWith('x'.repeat(1024 * 1024))).toBe(true);
    } finally { delete process.env.SWC_TEST_SECRET_TOKEN; }
  });
  test('cancellation kills a TERM-ignoring process while preserving an unrelated live child', async () => {
    const path = await root(); const control = new AbortController(); const run = await context(path, 60_000, control.signal); const otherRun = await context(await root());
    const unrelated = await otherRun.supervisor.spawn({ argv: [process.execPath, '-e', 'setInterval(()=>{},1000)'], cwd: path, purpose: 'probe' });
    const owned = await run.supervisor.spawn({ argv: [process.execPath, '-e', "process.on('SIGTERM',()=>{});process.stdout.write('ready');setInterval(()=>{},1000)"], cwd: path, purpose: 'setup' });
    while (!owned.output().stdout.includes('ready')) await new Promise((resolve) => setTimeout(resolve, 10));
    const started = performance.now(); control.abort(); await owned.exited; expect(owned.isAlive()).toBe(false); expect(unrelated.isAlive()).toBe(true);
    expect((await cleanupRun(run)).status).toBe('ok'); expect(performance.now() - started).toBeLessThan(10_000); expect(unrelated.isAlive()).toBe(true);
  }, 15_000);
  test('caps process diagnostic bytes after a completed output burst', async () => {
    const path = await root(); const run = await context(path);
    const child = await run.supervisor.spawn({ argv: [process.execPath, '-e', "process.stdout.write('x'.repeat(6*1024*1024),()=>process.exit(0))"], cwd: path, purpose: 'encode', timeoutMs: 5000 });
    expect((await child.exited).code).toBe(0); expect(child.output().truncated).toBe(true); expect(Buffer.byteLength(child.output().stdout)).toBeLessThanOrEqual(5 * 1024 * 1024); expect((await cleanupRun(run)).status).toBe('ok');
  }, 10_000);
  test.each(['encode', 'browser'] as const)('stops a hung spawned %s process at its independent process timeout', async (purpose) => {
    const path = await root(); const run = await context(path);
    const child = await run.supervisor.spawn({ argv: [process.execPath, '-e', 'setInterval(()=>{},1000)'], cwd: path, purpose, timeoutMs: 200 });
    await child.exited; expect(child.isAlive()).toBe(false); expect((await cleanupRun(run)).status).toBe('ok');
  }, 10_000);
  test('global deadline cancels the context with exit 10', async () => {
    const path = await root(); const run = await context(path, 150); const child = await run.supervisor.spawn({ argv: [process.execPath, '-e', 'setInterval(()=>{},1000)'], cwd: path, purpose: 'setup' });
    await child.exited; expect(run.signal.aborted).toBe(true); expect(run.signal.reason).toMatchObject({ exitCode: 10 }); expect((await cleanupRun(run)).status).toBe('ok');
  });
});

test('T13 diagnoses a real SIGKILL-abandoned owner and cleans only its exact registered residue', async () => {
  const path = await root(); await writeFile(join(path, 'unrelated.txt'), 'keep this');
  const source = new URL('../../src/runtime/context.ts', import.meta.url).href;
  const script = "import {registerHooks} from 'node:module';registerHooks({resolve(specifier,context,next){if(context.parentURL?.includes('/src/')&&specifier.startsWith('.')&&specifier.endsWith('.js'))return next(specifier.replace(/\\.js$/,'.ts'),context);return next(specifier,context)}});const {createRunContext}=await import(process.argv[1]);const run=await createRunContext({repoRoot:process.argv[2],timeoutMs:60000,signal:new AbortController().signal,diagnostics:{event(){}}});process.stdout.write(run.runId+'\\n');setInterval(()=>{},1000)";
  const child = spawn(process.execPath, ['--experimental-transform-types', '--input-type=module', '-e', script, source, path], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; let errors = ''; child.stdout.on('data', (chunk: Buffer) => { output += chunk; }); child.stderr.on('data', (chunk: Buffer) => { errors += chunk; });
  const exited = new Promise<void>((resolve) => child.once('close', () => resolve()));
  try {
    const until = Date.now() + 10_000; while (!output.includes('\n') && child.exitCode === null && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(output, errors).toMatch(/^\d{8}T\d{9}Z-[a-f0-9]{16}\n$/); const runId = output.trim();
    await expect(context(path)).rejects.toMatchObject({ detail: { code: 'RUN_ACTIVE' } });
    child.kill('SIGKILL'); await exited;
    expect(await inspectOwnedRuns(path)).toMatchObject([{ runId, state: 'abandoned' }]);
    expect(await cleanOwnedRun(path, runId)).toEqual({ schemaVersion: 2, runId, removed: true });
    expect(await readFile(join(path, 'unrelated.txt'), 'utf8')).toBe('keep this');
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; }
}, 20_000);

test('T12 cleans a child created immediately before its supervised command exits', async () => {
  const path = await root(); const run = await context(path); const survivorRun = await context(await root());
  const unrelated = await survivorRun.supervisor.spawn({ argv: [process.execPath, '-e', 'setInterval(()=>{},1000)'], cwd: path, purpose: 'probe' });
  const script = "process.stdin.once('data',()=>{const child=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:false,stdio:'ignore'});process.stdout.write(String(child.pid));process.exit(0)})";
  const leader = await run.supervisor.spawn({ argv: [process.execPath, '-e', script], cwd: path, purpose: 'probe', input: 'pipe' });
  leader.stdin?.end('go'); expect((await leader.exited).code).toBe(0); expect(leader.isAlive()).toBe(false);
  const descendant = Number(leader.output().stdout); expect(descendant).toBeGreaterThan(0);
  const { groupMembers } = await import('../../src/runtime/process-table.js');
  expect((await groupMembers(leader.groupId)).some((row) => row.pid === descendant)).toBe(true);
  expect((await cleanupRun(run)).status).toBe('ok'); expect(await groupMembers(leader.groupId)).toEqual([]); expect(unrelated.isAlive()).toBe(true);
}, 15_000);

test('T12 reports server command exit even when a descendant retains inherited stdio', async () => {
  const path = await root(); const run = await context(path);
  const script = "process.stdin.once('data',()=>{require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:false,stdio:'inherit'});process.exit(12)})";
  const leader = await run.supervisor.spawn({ argv: [process.execPath, '-e', script], cwd: path, purpose: 'server', input: 'pipe' }); leader.stdin?.end('go');
  expect(await leader.exited).toMatchObject({ code: 12 }); expect(leader.isAlive()).toBe(false); expect((await cleanupRun(run)).status).toBe('ok');
}, 15_000);

test('T12 process timeout also bounds inherited-pipe draining after command exit', async () => {
  const path = await root(); const run = await context(path);
  const script = "setTimeout(()=>process.stdin.once('data',()=>{require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:false,stdio:'inherit'});process.exit(0)}),250)";
  const leader = await run.supervisor.spawn({ argv: [process.execPath, '-e', script], cwd: path, purpose: 'probe', input: 'pipe', timeoutMs: 1000 }); const started = performance.now(); leader.stdin?.end('go');
  expect(await leader.exited).toMatchObject({ code: 0 }); expect(performance.now() - started).toBeLessThan(2000); expect((await cleanupRun(run)).status).toBe('ok');
}, 5000);
