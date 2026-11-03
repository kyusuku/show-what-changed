import { execFile, spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { expect, test } from 'vitest';
import { cleanupRun, createRunContext } from '../../src/runtime/context.js';
import { OwnerMarkerSchema } from '../../src/runtime/ownership.js';
import { processTable } from '../../src/runtime/process-table.js';
import { CleanReportSchema, ManifestSchema, ResultSchema } from '../../src/schema/index.js';

const execute = promisify(execFile);
const exists = (path: string) => stat(path).then(() => true, () => false);
const ProcessLedgerSchema = z.array(z.strictObject({ pid: z.number().int().positive(), group: z.number().int().positive(), started: z.string().nullable() }));

async function git(repo: string, ...args: string[]): Promise<string> {
  return (await execute('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args], { cwd: repo })).stdout.trim();
}

async function callerState(repo: string) {
  return {
    index: await readFile(join(repo, '.git/index')),
    head: await git(repo, 'rev-parse', 'HEAD'),
    worktrees: await git(repo, 'worktree', 'list', '--porcelain'),
    tracked: await readFile(join(repo, 'source.txt')),
    lock: await readFile(join(repo, 'recipe.lock')),
    untracked: await readFile(join(repo, 'caller-untracked.txt')),
    dependencies: await readFile(join(repo, 'node_modules/caller.txt')),
  };
}

async function fixture(mutation?: 'setup' | 'bootstrap') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'swc-r03-host-ownership-')));
  const repo = join(root, 'repo');
  await mkdir(repo);
  await git(repo, 'init', '-q');
  await git(repo, 'config', 'user.email', 'fixture@example.invalid');
  await git(repo, 'config', 'user.name', 'Host ownership fixture');
  await writeFile(join(repo, '.gitignore'), '.show-what-changed/\nnode_modules/\n');
  await writeFile(join(repo, 'source.txt'), 'committed caller source');
  await writeFile(join(repo, 'recipe.lock'), 'committed-lock\n');
  await writeFile(join(repo, 'server.mjs'), `
import { createServer } from 'node:http';
const server = createServer((_request, response) => response.end('host ownership fixture'));
server.listen(Number(process.argv[2]), '127.0.0.1', () => process.stdout.write('server-ready:' + process.pid + '\\n'));
`);
  await writeFile(join(repo, 'mutate-lock.mjs'), `
import { writeFileSync } from 'node:fs';
writeFileSync('recipe.lock', 'changed-by-recipe-' + process.env.SWC_SIDE + '\\n');
process.stdout.write('lock-mutated:' + process.env.SWC_SIDE + '\\n');
`);
  await writeFile(join(repo, 'show-what-changed.config.json'), JSON.stringify({
    schemaVersion: 2,
    execution: {
      start: { kind: 'process', argv: [process.execPath, 'server.mjs', '{port}'] },
      ready: { timeoutMs: 3000 },
      state: { kind: 'stateless' },
      ...(mutation ? { [mutation]: [{ argv: [process.execPath, 'mutate-lock.mjs'], timeoutMs: 3000 }] } : {}),
    },
  }));
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-qm', 'initial fixture');
  await writeFile(join(repo, 'source.txt'), 'staged caller source');
  await git(repo, 'add', 'source.txt');
  await writeFile(join(repo, 'source.txt'), 'unstaged caller source');
  await writeFile(join(repo, 'recipe.lock'), 'staged-caller-lock\n');
  await git(repo, 'add', 'recipe.lock');
  await writeFile(join(repo, 'recipe.lock'), 'unstaged-caller-lock\n');
  await writeFile(join(repo, 'caller-untracked.txt'), 'caller untracked source');
  await mkdir(join(repo, 'node_modules'));
  await writeFile(join(repo, 'node_modules/caller.txt'), 'caller dependencies');
  const loader = join(root, 'cli-loader.mjs');
  await writeFile(loader, `
import { registerHooks } from 'node:module';
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.includes('/src/') && specifier.startsWith('.') && specifier.endsWith('.js')) return next(specifier.replace(/\\.js$/, '.ts'), context);
    return next(specifier, context);
  },
  load(url, context, next) {
    const result = next(url, context);
    if (${JSON.stringify(Boolean(mutation))} && url.endsWith('/src/runner/index.ts')) {
      const source = String(result.source);
      const pattern = /async function compareCapabilities\\(run: RunContext\\): Promise<void> \\{[\\s\\S]*?\\n\\}\\nfunction uniqueErrors/;
      if (!pattern.test(source)) throw new Error('Missing host-only capability probe anchor');
      return { ...result, source: source.replace(pattern, 'async function compareCapabilities(): Promise<void> {}\\nfunction uniqueErrors') };
    }
    return result;
  },
});
await import(${JSON.stringify(new URL('../../src/cli/index.ts', import.meta.url).href)});
`);
  return { root, repo, loader, caller: await callerState(repo) };
}

async function cli(f: Awaited<ReturnType<typeof fixture>>, args: string[]) {
  const child = spawn(process.execPath, ['--no-warnings', '--experimental-transform-types', f.loader, ...args, '--json'], { cwd: f.repo, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (bytes: Buffer) => { stdout += bytes; });
  child.stderr.on('data', (bytes: Buffer) => { stderr += bytes; });
  const closed = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 20_000);
  try {
    const code = await closed;
    expect(stdout.trim().split('\n'), stderr).toHaveLength(1);
    const result = ResultSchema.parse(JSON.parse(stdout));
    expect(code, stderr).toBe(result.exitCode);
    await writeFile(join(f.root, `cli-${args[0]}-${Date.now()}.json`), JSON.stringify({ code, result, stderr }, null, 2));
    return { code, result };
  } finally { clearTimeout(timeout); }
}

async function sentinel(root: string) {
  const child = spawn(process.execPath, ['-e', "process.on('message',message=>process.send?.(message));process.send?.('ready');setInterval(()=>{},1000)"], { cwd: root, detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const closed = new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('close', () => resolve()); });
  const ping = (message: string) => new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { child.removeListener('message', receive); reject(new Error('Test sentinel did not respond')); }, 1500);
    const receive = (value: unknown) => {
      if (value !== message) return;
      clearTimeout(timeout);
      child.removeListener('message', receive);
      resolve();
    };
    child.on('message', receive);
    if (message !== 'ready') child.send(message, (error) => { if (error) { clearTimeout(timeout); child.removeListener('message', receive); reject(error); } });
  });
  try {
    await ping('ready');
    const identity = (await processTable()).find((row) => row.pid === child.pid);
    if (!identity) throw new Error('Test sentinel process identity is unavailable');
    return {
      identity,
      async assertAlive() {
        expect((await processTable()).find((row) => row.pid === identity.pid)).toEqual(identity);
        await ping('still-alive');
      },
      async stop() {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
        const timeout = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 1000);
        try { await closed; } finally { clearTimeout(timeout); }
      },
    };
  } catch (error) {
    child.kill('SIGKILL');
    await closed;
    throw error;
  }
}

async function finishFixture(f: Awaited<ReturnType<typeof fixture>>, passed: boolean) {
  if (passed) await rm(f.root, { recursive: true, force: true });
  else process.stderr.write(`Retained failed host ownership fixture at ${f.root}\n`);
}

test('CLI clean preserves a live unrelated PID named by a stale mismatched-start ledger', async () => {
  const f = await fixture();
  const unrelated = await sentinel(f.root);
  let passed = false;
  try {
    const run = await createRunContext({ repoRoot: f.repo, timeoutMs: 10_000, signal: new AbortController().signal, diagnostics: { event() {} } });
    expect(await cleanupRun(run)).toEqual({ status: 'ok', errors: [] });
    const markerPath = join(run.paths.runDir, '.owner.json');
    const marker = OwnerMarkerSchema.parse(JSON.parse(await readFile(markerPath, 'utf8')));
    const abandoned = { ...marker, state: 'active', owner: { ...unrelated.identity, started: 'Thu Jan  1 00:00:00 1970' } } satisfies z.infer<typeof OwnerMarkerSchema>;
    expect(abandoned.owner.started).not.toBe(unrelated.identity.started);
    await writeFile(markerPath, JSON.stringify(abandoned));
    const ledgerPath = join(run.paths.privateDir, 'processes.json');
    const ledger = JSON.stringify([{ pid: unrelated.identity.pid, group: unrelated.identity.group, started: abandoned.owner.started }]);
    await writeFile(ledgerPath, ledger);
    const beforeMarker = await readFile(markerPath);
    const result = await cli(f, ['clean', run.runId]);
    expect(result).toMatchObject({ code: 2, result: { command: 'clean', status: 'failed', exitCode: 2, data: null, error: { code: 'RUN_ACTIVE', phase: 'cleanup' } } });
    await unrelated.assertAlive();
    expect(await readFile(markerPath)).toEqual(beforeMarker);
    expect(await readFile(ledgerPath, 'utf8')).toBe(ledger);
    expect(await exists(join(f.repo, '.show-what-changed/run.lock'))).toBe(false);
    expect(await callerState(f.repo)).toEqual(f.caller);
    await writeFile(ledgerPath, '[]');
    expect((await cli(f, ['clean', run.runId])).code).toBe(0);
    await unrelated.assertAlive();
    expect(await exists(run.paths.runDir)).toBe(false);
    passed = true;
  } finally { await unrelated.stop(); await finishFixture(f, passed); }
}, 30_000);

test.each(['setup', 'bootstrap'] as const)('CLI reports tracked recipe lockfile mutation during %s without changing caller state', async (phase) => {
  const f = await fixture(phase);
  let passed = false;
  try {
    const result = await cli(f, ['compare', '--base', 'HEAD', '--head', 'WORKTREE', '--route', '/', '--allow-exec', '--timeout', '15']);
    expect(result).toMatchObject({ code: 5, result: { command: 'compare', status: 'failed', exitCode: 5, error: { code: 'SOURCE_MUTATED', phase: 'preparing' } } });
    const manifest = ManifestSchema.parse(result.result.data);
    expect(manifest).toMatchObject({ status: 'failed', exitCode: 5, cleanupOutcome: { status: 'ok', errors: [] }, comparisonOutcome: { status: 'failed', capture: 'failed' }, artifacts: { video: null, poster: null, capture: null, timeline: null } });
    for (const side of ['before', 'after'] as const) {
      const provenance = manifest.comparisonOutcome.provenance[side];
      expect(provenance).toMatchObject({ valid: false, errors: [{ code: 'SOURCE_MUTATED', phase: 'provenance', side }] });
      expect(provenance.actualHash).not.toBeNull();
      expect(provenance.actualHash).not.toBe(manifest.sources[side].materializedHash);
      expect(manifest.execution?.[side]).toMatchObject({ kind: 'process', dependencyReproducibility: phase === 'setup' ? 'unverified' : 'none', buildArtifacts: 'unverified' });
    }
    const runDir = join(f.repo, '.show-what-changed/runs', manifest.runId);
    const saved = ManifestSchema.parse(JSON.parse(await readFile(join(runDir, 'manifest.json'), 'utf8')));
    expect(saved).toEqual(result.result.data);
    const privateDir = join(runDir, 'private');
    const logs = (await Promise.all((await readdir(privateDir)).filter((name) => name.endsWith('.log')).map((name) => readFile(join(privateDir, name), 'utf8')))).join('\n');
    expect(logs).toContain('lock-mutated:before');
    expect(logs).toContain('lock-mutated:after');
    expect(logs.match(/server-ready:/g)).toHaveLength(2);
    const ledger = ProcessLedgerSchema.parse(JSON.parse(await readFile(join(privateDir, 'processes.json'), 'utf8')));
    expect(ledger.length).toBeGreaterThanOrEqual(4);
    const processes = await processTable();
    expect(processes.filter((row) => ledger.some((entry) => entry.group === row.group))).toEqual([]);
    expect(await exists(join(runDir, 'private/workspaces'))).toBe(false);
    expect(await exists(join(f.repo, '.show-what-changed/run.lock'))).toBe(false);
    expect(await callerState(f.repo)).toEqual(f.caller);
    passed = true;
  } finally { await finishFixture(f, passed); }
}, 30_000);

test('repeated CLI clean reports missing inactive run safely and preserves unrelated output and process', async () => {
  const f = await fixture();
  const unrelated = await sentinel(f.root);
  let passed = false;
  try {
    const run = await createRunContext({ repoRoot: f.repo, timeoutMs: 10_000, signal: new AbortController().signal, diagnostics: { event() {} } });
    expect(await cleanupRun(run)).toEqual({ status: 'ok', errors: [] });
    const output = join(f.repo, '.show-what-changed/runs', 'unrelated-user-output');
    await mkdir(output);
    await writeFile(join(output, 'keep.txt'), 'unrelated output bytes');
    const first = await cli(f, ['clean', run.runId]);
    expect(first).toMatchObject({ code: 0, result: { command: 'clean', status: 'ok', exitCode: 0, error: null } });
    expect(CleanReportSchema.parse(first.result.data)).toEqual({ schemaVersion: 2, runId: run.runId, removed: true });
    expect(await exists(run.paths.runDir)).toBe(false);
    await unrelated.assertAlive();
    const second = await cli(f, ['clean', run.runId]);
    expect(second).toMatchObject({ code: 2, result: { command: 'clean', status: 'failed', exitCode: 2, data: null, error: { code: 'INVALID_INPUT', phase: 'validating' } } });
    expect(await readdir(join(f.repo, '.show-what-changed/runs'))).toEqual(['unrelated-user-output']);
    expect(await readFile(join(output, 'keep.txt'), 'utf8')).toBe('unrelated output bytes');
    expect(await exists(join(f.repo, '.show-what-changed/run.lock'))).toBe(false);
    await unrelated.assertAlive();
    expect(await callerState(f.repo)).toEqual(f.caller);
    passed = true;
  } finally { await unrelated.stop(); await finishFixture(f, passed); }
}, 30_000);
