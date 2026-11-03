import { createServer } from 'node:net';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, test } from 'vitest';
import { ConfigSchema, PlanSchema } from '../../src/schema/index.js';
import type { RunContext, WorkspacePair } from '../../src/schema/contracts.js';
import { cleanupRun, createRunContext } from '../../src/runtime/context.js';
import { start, listeners, verifyListeners } from '../../src/runtime/index.js';
import { openBrowser } from '../../src/runtime/browser.js';
import { groupMembers } from '../../src/runtime/process-table.js';

const roots: string[] = []; const runs: RunContext[] = [];
async function unrelatedListener() {
  for (let port = 4310; port <= 4399; port++) {
    const server = createServer();
    const available = await new Promise<boolean>((resolve) => { server.once('error', () => resolve(false)); server.listen(port, '127.0.0.1', () => resolve(true)); });
    if (available) return { server, port };
  }
  throw new Error('No free fixture listener port');
}

async function fixture(script: string, readyStatus = [200]): Promise<{ run: RunContext; workspaces: WorkspacePair; selected: ReturnType<typeof PlanSchema.parse> }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'swc-lifecycle-'))); roots.push(root);
  const run = await createRunContext({ repoRoot: root, timeoutMs: 30_000, signal: new AbortController().signal, diagnostics: { event() {} } }); runs.push(run);
  const make = async (side: 'before' | 'after') => { const path = join(run.paths.tempDir, side); await mkdir(path); await writeFile(join(path, 'server.mjs'), script); return { side, root: path, commit: 'a'.repeat(40), kind: 'commit' as const, label: `${side} fixture`, materializedHash: '0'.repeat(64), inventory: [], sourceSettings: { generatedDirs: [], maxFiles: 1000, maxBytes: 1024 * 1024 } }; };
  const workspaces = { before: await make('before'), after: await make('after') };
  const config = ConfigSchema.parse({ schemaVersion: 2, execution: { start: { kind: 'process', argv: [process.execPath, 'server.mjs', '{port}'] }, ready: { timeoutMs: 1000, path: '/ready', statuses: readyStatus }, state: { kind: 'stateless' } } });
  const selected = PlanSchema.parse({ schemaVersion: 2, planId: '0'.repeat(64), generatedAt: new Date().toISOString(), repoRoot: root, requestedBase: 'HEAD', requestedHead: 'HEAD', baseCommit: 'a'.repeat(40), headCommit: 'a'.repeat(40), baseResolution: 'exact', headKind: 'commit', sourceFingerprint: null, configDigest: '0'.repeat(64), scenarioDigest: '0'.repeat(64), configSource: null, scenarioSources: [], inputs: [], inventories: { before: [], after: [] }, sourceStats: { before: { files: 1, bytes: 1, fingerprint: '0'.repeat(64) }, after: { files: 1, bytes: 1, fingerprint: '0'.repeat(64) } }, config, scenarios: [{ schemaVersion: 2, id: 'one', title: 'One', steps: [{ id: 'open', op: 'goto', path: '/' }] }], changedFiles: [], coverage: { selected: [], unresolved: [], omitted: [], unsupported: [], complete: true }, execution: { sourceFileCounts: { before: 1, after: 1 }, sourceBytes: { before: 1, after: 1 }, estimatedSnapshotBytes: 2, environmentReferences: [], notice: 'Fixture code executes.' }, warnings: [] });
  return { run, workspaces, selected };
}
afterEach(async () => { for (const run of runs.splice(0)) await cleanupRun(run); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('T12 exact-port owned loopback readiness', () => {
  test('starts two independently owned servers, excludes an occupied candidate, and retains unrelated listeners', async () => {
    const { server: sentinel, port: occupiedPort } = await unrelatedListener();
    try {
      const { run, workspaces, selected } = await fixture("import http from 'node:http';http.createServer((req,res)=>{res.statusCode=req.url==='/ready'?201:200;res.end(process.env.SWC_SIDE)}).listen(Number(process.argv[2]),'127.0.0.1')", [201]);
      const { servers } = await start(workspaces, selected, run);
      expect(servers.before.port).not.toBe(occupiedPort); expect(servers.after.port).not.toBe(servers.before.port);
      expect(await (await fetch(servers.before.origin)).text()).toBe('before'); expect(await (await fetch(servers.after.origin)).text()).toBe('after');
      expect((await listeners(servers.before.port)).length).toBeGreaterThan(0);
      expect((await cleanupRun(run)).status).toBe('ok'); expect(await listeners(servers.before.port)).toEqual([]); expect(await listeners(servers.after.port)).toEqual([]); expect(sentinel.listening).toBe(true);
    } finally { await new Promise<void>((resolve) => sentinel.close(() => resolve())); }
  }, 15_000);
  test.each([
    ['wildcard bind', "import http from 'node:http';http.createServer((req,res)=>res.end('ok')).listen(Number(process.argv[2]),'0.0.0.0')", 'NON_LOOPBACK_LISTENER'],
    ['silent fallback', "import http from 'node:http';http.createServer((req,res)=>res.end('ok')).listen(Number(process.argv[2])+1000,'127.0.0.1')", 'SERVER_TIMEOUT'],
    ['wrong readiness status', "import http from 'node:http';http.createServer((req,res)=>{res.statusCode=204;res.end()}).listen(Number(process.argv[2]),'127.0.0.1')", 'SERVER_TIMEOUT'],
    ['external redirect', "import http from 'node:http';http.createServer((req,res)=>{res.writeHead(302,{location:'https://never-requested.example.invalid/'});res.end()}).listen(Number(process.argv[2]),'127.0.0.1')", 'READINESS_REDIRECT'],
    ['early exit', 'process.exit(12)', 'SERVER_EXITED'],
  ])('rejects %s and stops the complete owned pair', async (_name, script, code) => {
    const { run, workspaces, selected } = await fixture(script);
    await expect(start(workspaces, selected, run)).rejects.toMatchObject({ exitCode: 6, detail: { code } });
    expect((await cleanupRun(run)).status).toBe('ok');
    const processes: { pid: number; group: number }[] = JSON.parse(await readFile(join(run.paths.privateDir, 'processes.json'), 'utf8'));
    for (const process of processes) expect(await groupMembers(process.group)).toEqual([]);
  }, 15_000);
  test('refuses an unrelated listener even when it returns the requested readiness status', async () => {
    const { run } = await fixture(''); const owned = await run.supervisor.spawn({ argv: [process.execPath, '-e', 'setInterval(()=>{},1000)'], cwd: run.paths.runDir, purpose: 'server' });
    const { server: unrelated, port } = await unrelatedListener();
    try { await expect(verifyListeners(port, owned)).rejects.toMatchObject({ detail: { code: 'UNOWNED_LISTENER' } }); expect(unrelated.listening).toBe(true); }
    finally { await new Promise<void>((resolve) => unrelated.close(() => resolve())); }
  });
});
describe('T12 browser lifecycle ownership', () => {
  test('keeps the adopted browser alive until context cleanup finishes at the global deadline', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'swc-browser-deadline-'))); roots.push(root);
    const run = await createRunContext({ repoRoot: root, timeoutMs: 2000, signal: new AbortController().signal, diagnostics: { event() {} } }); runs.push(run);
    const browser = await openBrowser(run); const context = await browser.newContext(); const page = await context.newPage();
    await page.setContent('<h1>Context closes before browser process</h1>');
    let connectedDuringContextCleanup = false;
    run.resources.register({ kind: 'context', identity: 'deadline-ordering-context', dispose: async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      connectedDuringContextCleanup = browser.isConnected();
      await context.close();
    } });
    if (!run.signal.aborted) await new Promise<void>((resolve) => run.signal.addEventListener('abort', () => resolve(), { once: true }));
    expect(run.signal.reason).toMatchObject({ exitCode: 10 });
    expect(await cleanupRun(run)).toEqual({ status: 'ok', errors: [] });
    expect(connectedDuringContextCleanup).toBe(true);
    expect(browser.isConnected()).toBe(false);
    const records: { group: number }[] = JSON.parse(await readFile(join(run.paths.privateDir, 'processes.json'), 'utf8'));
    for (const record of records) expect(await groupMembers(record.group)).toEqual([]);
  }, 15_000);
  test('launches sandboxed Chromium, registers its live group and removes it through bounded cleanup', async () => {
    const { run } = await fixture(''); const browser = await openBrowser(run); const context = await browser.newContext();
    run.resources.register({ kind: 'context', identity: 'lifecycle-context', dispose: async () => context.close() });
    const page = await context.newPage(); await page.setContent('<h1>Owned browser fixture</h1>'); expect(await page.locator('h1').textContent()).toBe('Owned browser fixture');
    const processRecords: { pid: number; group: number }[] = JSON.parse(await readFile(join(run.paths.privateDir, 'processes.json'), 'utf8'));
    expect(processRecords.length).toBe(1); expect((await cleanupRun(run)).status).toBe('ok');
    for (const record of processRecords) expect(await groupMembers(record.group)).toEqual([]);
  }, 20_000);
});

test('T12 adopted Chromium crash cleanup retains process-group safety', async () => {
  const { run } = await fixture(''); const browser = await openBrowser(run); const context = await browser.newContext(); const page = await context.newPage();
  await page.setContent('<h1>Crash fixture</h1>');
  const records: { pid: number; group: number }[] = JSON.parse(await readFile(join(run.paths.privateDir, 'processes.json'), 'utf8')); const record = records[0];
  expect(record).toBeDefined(); if (!record) throw new Error('Missing browser ownership record');
  expect(browser.isConnected()).toBe(true); const disconnected = new Promise<void>((resolve) => browser.once('disconnected', () => resolve())); process.kill(record.pid, 'SIGKILL'); await disconnected;
  expect((await cleanupRun(run)).status).toBe('ok'); expect(await groupMembers(record.group)).toEqual([]);
}, 20_000);
