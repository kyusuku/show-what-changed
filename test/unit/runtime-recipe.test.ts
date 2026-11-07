import { chmod, lstat, mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { z } from 'zod';
import { ConfigSchema, PlanSchema } from '../../src/schema/index.js';
import type { Config, Plan } from '../../src/schema/index.js';
import type { RunContext, WorkspacePair } from '../../src/schema/contracts.js';
import { createRunContext, cleanupRun } from '../../src/runtime/context.js';
import { start } from '../../src/runtime/index.js';
import { groupMembers } from '../../src/runtime/process-table.js';
import { sha256 } from '../../src/schema/io.js';
import { applicationEnvironment, bindEnvironment, commandArguments, prepareInputs, readAuthState, readBoundInputs } from '../../src/runtime/recipe.js';
const roots: string[] = []; const runs: RunContext[] = [];
async function fixture(execution: unknown): Promise<{ run: RunContext; workspaces: WorkspacePair; plan: Plan }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'swc-recipe-'))); roots.push(root);
  const run = await createRunContext({ repoRoot: root, timeoutMs: 60_000, signal: new AbortController().signal, diagnostics: { event() {} } }); runs.push(run);
  const config = ConfigSchema.parse({ schemaVersion: 2, execution });
  const make = async (side: 'before' | 'after') => { const path = join(run.paths.tempDir, side); await mkdir(path); for (const file of ['runtime-server.cjs', 'isolated-store.cjs', 'ordered.cjs']) await writeFile(join(path, file), await readFile(new URL(`../../fixtures/services/${file}`, import.meta.url))); return { side, root: path, commit: 'a'.repeat(40), kind: 'commit' as const, label: side, materializedHash: '0'.repeat(64), inventory: [], sourceSettings: config.source }; };
  const workspaces = { before: await make('before'), after: await make('after') };
  const stats = { files: 0, bytes: 0, fingerprint: '0'.repeat(64) };
  const plan = PlanSchema.parse({ schemaVersion: 2, planId: '0'.repeat(64), generatedAt: new Date().toISOString(), repoRoot: root, requestedBase: 'HEAD', requestedHead: 'HEAD', baseCommit: 'a'.repeat(40), headCommit: 'a'.repeat(40), baseResolution: 'exact', headKind: 'commit', sourceFingerprint: null, configDigest: '0'.repeat(64), scenarioDigest: '0'.repeat(64), configSource: null, scenarioSources: [], inputs: [], inventories: { before: [], after: [] }, sourceStats: { before: stats, after: stats }, config, scenarios: [{ schemaVersion: 2, id: 'one', title: 'One', steps: [{ id: 'open', op: 'goto', path: '/' }] }], changedFiles: [], coverage: { selected: [], unresolved: [], omitted: [], unsupported: [], complete: true }, execution: { sourceFileCounts: { before: 0, after: 0 }, sourceBytes: { before: 0, after: 0 }, estimatedSnapshotBytes: 0, environmentReferences: [], notice: 'Fixture code executes.' }, warnings: [] });
  return { run, workspaces, plan };
}
afterEach(async () => { for (const run of runs.splice(0)) expect((await cleanupRun(run)).status).toBe('ok'); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); delete process.env.SWC_PRIVATE_TEST; delete process.env.SWC_RUNTIME_PATH; });
const basic = { start: { kind: 'process', argv: [process.execPath, 'runtime-server.cjs', '{port}'] }, state: { kind: 'stateless' }, ready: { timeoutMs: 3000 } };
test('manifest-free empty setup starts generic host applications with stable side origins', async () => {
  const f = await fixture({ ...basic, env: { APP_ORIGIN: { template: '{origin}' } } });
  const result = await start(f.workspaces, f.plan, f.run);
  for (const side of ['before', 'after'] as const) {
    expect(await (await fetch(result.servers[side].origin)).json()).toEqual({ side, cwd: f.workspaces[side].root, origin: result.servers[side].origin });
    expect(result.provenance[side]).toMatchObject({ kind: 'process', dependencyReproducibility: 'none', buildArtifacts: 'unverified' });
  }
});
test('Python uses the same generic runtime contract and selected prerequisite', async () => {
  const pythonServer = "import http.server, socketserver, sys; socketserver.TCPServer.allow_reuse_address = True; socketserver.TCPServer(('127.0.0.1', int(sys.argv[1])), http.server.SimpleHTTPRequestHandler).serve_forever()";
  const f = await fixture({ ...basic, ready: { timeoutMs: 15_000 }, requires: [{ argv: ['python3', '--version'], expectedVersion: '>=3.8.0' }], start: { kind: 'process', argv: ['python3', '-c', pythonServer, '{port}'] } });
  for (const workspace of Object.values(f.workspaces)) await writeFile(join(workspace.root, 'index.html'), 'generic-python');
  const result = await start(f.workspaces, f.plan, f.run);
  expect(await (await fetch(result.servers.before.origin)).text()).toBe('generic-python');
  expect(JSON.parse(await readFile(join(f.run.paths.privateDir, 'execution.json'), 'utf8')).prerequisites).toHaveLength(2);
}, 30_000);
test.each([
  [{ requires: [{ argv: ['swc-nonexistent-runtime-executable', '--version'], expectedVersion: '*' }] }, { exitCode: 8, detail: { code: 'PREREQUISITE_MISSING' } }],
  [{ requires: [{ argv: [process.execPath, '--version'], expectedVersion: '<1.0.0' }] }, { exitCode: 8, detail: { code: 'PREREQUISITE_VERSION' } }],
  [{ requires: [{ argv: [process.execPath, '-e', 'process.exit(12)'], expectedVersion: '*' }] }, { exitCode: 8, detail: { code: 'PREREQUISITE_VERSION' } }],
  [{ env: { PRIVATE_VALUE: { fromEnv: 'SWC_PRIVATE_TEST' } } }, { detail: { code: 'MISSING_ENVIRONMENT' } }],
  [{ pathPrependFromEnv: 'SWC_RUNTIME_PATH' }, { detail: { code: 'INVALID_RUNTIME_PATH' } }],
])('preflight failure happens before setup', async (fields, expected) => {
  const f = await fixture({ ...basic, ...fields, setup: [{ argv: [process.execPath, '-e', "require('node:fs').writeFileSync('setup-ran','wrong')"] }] });
  await expect(start(f.workspaces, f.plan, f.run)).rejects.toMatchObject(expected);
  for (const workspace of Object.values(f.workspaces)) await expect(lstat(join(workspace.root, 'setup-ran'))).rejects.toMatchObject({ code: 'ENOENT' });
});
test.each([
  { stage: 'setup', fields: { setup: [{ argv: [process.execPath, '-e', 'process.exit(12)'] }] }, exitCode: 5, code: 'SETUP_FAILED' },
  { stage: 'bootstrap', fields: { bootstrap: [{ argv: [process.execPath, '-e', 'process.exit(12)'] }] }, exitCode: 5, code: 'BOOTSTRAP_FAILED' },
  { stage: 'startup', fields: { start: { kind: 'process', argv: [process.execPath, '-e', 'process.exit(12)'] } }, exitCode: 6, code: 'SERVER_EXITED' },
])('recipe $stage failure preserves its exit category and can clean all owned resources', async ({ fields, exitCode, code }) => {
  const f = await fixture({ ...basic, ...fields, services: [{ id: 'store', kind: 'process', argv: [process.execPath, 'runtime-server.cjs', '{port}'], ready: { kind: 'http', path: '/', statuses: [200], timeoutMs: 3000 } }] });
  await expect(start(f.workspaces, f.plan, f.run)).rejects.toMatchObject({ exitCode, detail: { code, phase: 'starting' } });
  const processes = z.array(z.object({ group: z.number().int().positive() })).parse(JSON.parse(await readFile(join(f.run.paths.privateDir, 'processes.json'), 'utf8')));
  expect((await Promise.all(processes.map(({ group }) => groupMembers(group)))).some((members) => members.length > 0)).toBe(true);
  expect(await cleanupRun(f.run)).toEqual({ status: 'ok', errors: [] });
  for (const { group } of processes) expect(await groupMembers(group)).toEqual([]);
  for (const side of ['before', 'after']) expect(await readdir(join(f.run.paths.privateDir, 'execution', side))).toEqual([]);
  for (const path of [f.run.paths.tempDir, join(f.run.paths.repoRoot, '.show-what-changed', 'run.lock')]) await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
}, 15_000);
test('application PATH selection leaves tool Node unchanged and exact secrets are redacted before log persistence', async () => {
  const f = await fixture({ ...basic, pathPrependFromEnv: 'SWC_RUNTIME_PATH', requires: [{ argv: ['selected-runtime', '--version'], expectedVersion: '7.8.9' }], env: { PRIVATE_VALUE: { fromEnv: 'SWC_PRIVATE_TEST' } }, setup: [{ argv: [process.execPath, '-e', 'process.stdout.write(process.env.PRIVATE_VALUE)'] }] });
  const bin = join(f.run.paths.repoRoot, 'bin'); await mkdir(bin); await writeFile(join(bin, 'selected-runtime'), '#!/bin/sh\nprintf 7.8.9\n'); await chmod(join(bin, 'selected-runtime'), 0o700);
  process.env.SWC_RUNTIME_PATH = bin; process.env.SWC_PRIVATE_TEST = 'secret-byte-string-123456789';
  const original = process.execPath;
  await start(f.workspaces, f.plan, f.run); await cleanupRun(f.run);
  expect(process.execPath).toBe(original);
  const logs = await readdir(f.run.paths.privateDir);
  const text = (await Promise.all(logs.filter((name) => name.endsWith('.log')).map((name) => readFile(join(f.run.paths.privateDir, name), 'utf8')))).join('');
  expect(text).toContain('[redacted]'); expect(text).not.toContain(process.env.SWC_PRIVATE_TEST);
  expect(f.run.redactions.text(`value=${process.env.SWC_PRIVATE_TEST}`)).toBe('value=[redacted]');
}, 15_000);
test('ordered services resolve separate env and seed independent datasets', async () => {
  process.env.SWC_PRIVATE_TEST = 'app-only-secret';
  const f = await fixture({
    ...basic, state: { kind: 'isolated', seedId: 'seed' }, inputs: [{ id: 'seed', path: '/placeholder' }],
    env: { PRIVATE_VALUE: { fromEnv: 'SWC_PRIVATE_TEST' }, SERVICE_URL: { template: 'http://{service.store.host}:{service.store.port}' }, LATER_URL: { template: 'http://{service.later.host}:{service.later.port}' }, DATA: { template: '{stateDir}' }, SIDE: { template: '{side}' } },
    services: [
      { id: 'store', kind: 'process', cwd: 'store', argv: [process.execPath, '../isolated-store.cjs', '{port}'], env: { DATA: { template: '{stateDir}' }, SEED: { template: '{input.seed}' }, SIDE: { template: '{side}' }, SERVICE_VALUE: { literal: 'store-only' } }, ready: { kind: 'http', path: '/ready', statuses: [204], timeoutMs: 3000 } },
      { id: 'later', kind: 'process', cwd: 'later', setup: [{ cwd: 'later', argv: [process.execPath, '../ordered.cjs', 'setup', '{port}'], timeoutMs: 3000 }], argv: [process.execPath, '../ordered.cjs', 'start', '{port}'], env: { PREVIOUS: { template: 'http://{service.store.host}:{service.store.port}' }, DATA: { template: '{stateDir}' }, SIDE: { template: '{side}' }, SERVICE_VALUE: { literal: 'later-only' } }, ready: { kind: 'http', path: '/ready', statuses: [204], timeoutMs: 3000 } },
    ],
    setup: [{ argv: [process.execPath, 'ordered.cjs', 'app-setup'], timeoutMs: 3000 }],
  });
  for (const workspace of Object.values(f.workspaces)) { await mkdir(join(workspace.root, 'store')); await mkdir(join(workspace.root, 'later')); }
  const path = join(f.run.paths.repoRoot, 'seed.json'); await writeFile(path, 'equal-seed');
  const bound = { id: 'seed', path, sha256: sha256(Buffer.from('equal-seed')), byteLength: 10, executable: false, extension: '.json' };
  const plan = { ...f.plan, inputs: [bound], config: { ...f.plan.config, execution: { ...f.plan.config.execution, inputs: [{ id: 'seed', path }] } } };
  const result = await start(f.workspaces, plan, f.run);
  const urls: Record<string, string> = {};
  for (const side of ['before', 'after'] as const) {
    const app = await (await fetch(result.servers[side].origin)).json(); urls[side] = app.service; expect(await (await fetch(app.service)).json()).toEqual({ data: 'equal-seed' });
    const directories = await readdir(join(f.run.paths.privateDir, 'execution', side)); expect(directories).toHaveLength(1);
    const directory = directories[0]; if (!directory) throw new Error('Missing private side service state');
    const stateDir = join(f.run.paths.privateDir, 'execution', side, directory, 'state');
    const laterSetup: unknown = JSON.parse(await readFile(join(stateDir, 'later-setup.json'), 'utf8'));
    const appSetup = z.object({ side: z.enum(['before', 'after']), laterUrl: z.url(), observed: z.unknown() }).strict().parse(JSON.parse(await readFile(join(stateDir, 'app-setup.json'), 'utf8')));
    expect(laterSetup).toEqual({ side, port: new URL(appSetup.laterUrl).port, cwd: join(f.workspaces[side].root, 'later'), serviceValue: 'later-only', dependencyUrl: app.service, dependency: { side, endpoint: app.service, cwd: join(f.workspaces[side].root, 'store'), serviceValue: 'store-only', readiness: [503, 204], data: 'equal-seed' } });
    const response = await fetch(appSetup.laterUrl + '/observation', { signal: AbortSignal.timeout(1000) }); expect(response.status).toBe(200);
    const observed: unknown = await response.json();
    expect(observed).toEqual({ side, endpoint: appSetup.laterUrl, cwd: join(f.workspaces[side].root, 'later'), serviceValue: 'later-only', readiness: [503, 204], setup: laterSetup });
    expect(appSetup).toEqual({ side, laterUrl: appSetup.laterUrl, observed });
  }
  await fetch(urls.before!, { method: 'POST' });
  expect(await (await fetch(urls.before!)).json()).toEqual({ data: 'changed' });
  expect(await (await fetch(urls.after!)).json()).toEqual({ data: 'equal-seed' });
  expect(result.provenance.before).toMatchObject({ state: 'isolated', seedId: 'seed' });
}, 60_000);
test('helper bytes, extension, executable mode and auth origins remain side private', async () => {
  const f = await fixture({ ...basic, inputs: [{ id: 'helper', path: '/placeholder' }], auth: { storageState: 'auth.json' } });
  const path = join(f.run.paths.repoRoot, 'helper.mjs'); const bytes = Buffer.from('nonsecret helper bytes'); await writeFile(path, bytes); await chmod(path, 0o700);
  const plan = { ...f.plan, config: { ...f.plan.config, execution: { ...f.plan.config.execution, inputs: [{ id: 'helper', path }] } }, inputs: [{ id: 'helper', path, sha256: sha256(bytes), byteLength: bytes.length, executable: true, extension: '.mjs' }] };
  const read = await readBoundInputs(plan, f.run);
  const before = await prepareInputs(plan, f.run, 'before', read); const after = await prepareInputs(plan, f.run, 'after', read);
  expect(await readFile(join(before.inputDir, 'helper.mjs'))).toEqual(bytes); expect((await lstat(join(before.inputDir, 'helper.mjs'))).mode & 0o111).toBe(0o111);
  expect(before.stateDir).not.toBe(after.stateDir);
  const state = (origin: string, domain = '127.0.0.1') => ({ cookies: [{ name: 'local', value: 'private-cookie-value', domain, path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' }], origins: [{ origin, localStorage: [{ name: 'auth', value: 'private-local-storage' }] }] });
  for (const [inputs, origin] of [[before, 'http://127.0.0.1:4310'], [after, 'http://127.0.0.1:4311']] as const) { await writeFile(join(inputs.stateDir, 'auth.json'), JSON.stringify(state(origin))); expect(await readAuthState(f.plan.config.execution, inputs, origin, f.run)).toEqual(state(origin)); }
  await expect(readAuthState(f.plan.config.execution, before, 'http://127.0.0.1:4311', f.run)).rejects.toMatchObject({ detail: { code: 'INVALID_AUTH_STATE' } });
  await writeFile(join(before.stateDir, 'auth.json'), JSON.stringify(state('http://127.0.0.1:4310', '.example.test'))); await expect(readAuthState(f.plan.config.execution, before, 'http://127.0.0.1:4310', f.run)).rejects.toMatchObject({ detail: { code: 'INVALID_AUTH_STATE' } });
  await writeFile(path, 'changed'); await expect(readBoundInputs(plan, f.run)).rejects.toMatchObject({ detail: { code: 'INPUT_CHANGED' } });
});
test('consumer token resolution enforces whole arguments and private container paths', async () => {
  const f = await fixture({ ...basic, env: { URL: { template: '{origin}/side/{side}/{port}' } } }); const inputs = await prepareInputs(f.plan, f.run, 'before', new Map());
  const consumer = { side: 'before' as const, port: 8080, origin: 'http://127.0.0.1:4310', container: true, inputs, services: [{ kind: 'container' as const, id: 'db', port: 4311, alias: 'service-db', containerPort: 5432 }], runId: f.run.runId };
  expect(commandArguments(['{port}', '{origin}', '{stateDir}', '{service.db.host}', '{service.db.port}'], consumer)).toEqual(['8080', consumer.origin, '/swc-state', 'service-db', '5432']);
  expect(() => commandArguments(['--port={port}'], consumer)).toThrow();
  expect(() => commandArguments(['{unknown}'], consumer)).toThrow();
  const bound = await bindEnvironment(f.plan.config.execution, f.run); expect(applicationEnvironment(f.plan.config.execution.env, bound, consumer).URL).toBe(`${consumer.origin}/side/before/8080`);
});

test('bootstrap auth is restored into independent real browser contexts after exact-origin validation', async () => {
  const f = await fixture({ ...basic, start: { kind: 'process', argv: [process.execPath, 'auth-server.cjs', '{port}'] }, bootstrap: [{ argv: [process.execPath, 'auth-bootstrap.cjs', '{stateDir}', '{origin}', '{side}'] }], auth: { storageState: 'auth.json' } });
  for (const workspace of Object.values(f.workspaces)) {
    await writeFile(join(workspace.root, 'auth-server.cjs'), await readFile(new URL('../../fixtures/auth/server.cjs', import.meta.url)));
    await writeFile(join(workspace.root, 'auth-bootstrap.cjs'), await readFile(new URL('../../fixtures/auth/bootstrap.cjs', import.meta.url)));
  }
  const { servers } = await start(f.workspaces, f.plan, f.run);
  const { openBrowser } = await import('../../src/runtime/browser.js'); const browser = await openBrowser(f.run);
  for (const side of ['before', 'after'] as const) {
    const state = servers[side].storageState; if (!state) throw new Error('Missing side auth state');
    const context = await browser.newContext({ storageState: structuredClone(state) });
    f.run.resources.register({ kind: 'context', identity: `auth-${side}`, dispose: async () => context.close() });
    const page = await context.newPage(); await page.goto(servers[side].origin);
    expect(await page.locator('body').textContent()).toBe(`true:${side}-storage`);
    expect((await context.cookies())[0]?.value).toBe(`${side}-cookie`);
  }
}, 20_000);

test('concurrent owned runs reserve disjoint bounded ports across their application pairs', async () => {
  const first = await fixture(basic); const second = await fixture(basic);
  const results = await Promise.all([start(first.workspaces, first.plan, first.run), start(second.workspaces, second.plan, second.run)]);
  const servers = results.flatMap((result) => Object.values(result.servers));
  expect(new Set(servers.map((server) => server.port)).size).toBe(4);
  expect(servers.every((server) => server.port >= 4310 && server.port <= 4499)).toBe(true);
  for (const server of servers) expect((await fetch(server.origin)).ok).toBe(true);
}, 20_000);
