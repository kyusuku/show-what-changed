import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import type { Plan } from '../../src/schema/index.js';
import type { OwnedProcess, RunContext, RuntimeResult, Supervisor, Workspace, WorkspacePair } from '../../src/schema/contracts.js';
import { PlanSchema, parseConfig, parseScenario } from '../../src/schema/index.js';
import { failure } from '../../src/schema/errors.js';
import { DockerRuntime } from '../../src/runtime/docker.js';
import { cleanupRun, releaseRunOwnership } from '../../src/runtime/context.js';
import { runCleanupLifetime } from '../../src/runtime/cleanup-lifetime.js';
import { readOwner } from '../../src/runtime/ownership.js';
import { compare } from '../../src/runner/index.js';

const lateRm = vi.hoisted(() => ({ entered: undefined as undefined | (() => void), released: undefined as undefined | Promise<void> }));
const state = vi.hoisted(() => ({ plan: undefined as Plan | undefined, run: undefined as RunContext | undefined, start: undefined as ((workspaces: WorkspacePair, run: RunContext) => Promise<RuntimeResult>) | undefined, supervisor: undefined as Supervisor | undefined }));
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs, rm: async (...args: Parameters<typeof fs.rm>) => { if (lateRm.entered && String(args[0]).includes('/docker-export-')) { lateRm.entered(); await lateRm.released; } return fs.rm(...args); }, readFile: (...args: Parameters<typeof fs.readFile>) => args[0] instanceof URL && args[0].pathname.endsWith('/assets/fonts/Inter-Regular.woff2') ? Promise.resolve(Buffer.from('wOF2 synthetic capability fixture')) : fs.readFile(...args) };
});
vi.mock('../../src/planner/index.js', () => ({ plan: async () => state.plan, validateSavedPlan: async () => {} }));
vi.mock('../../src/workspace/index.js', () => ({
  prepare: async (plan: Plan, run: RunContext) => {
    const result = {} as Record<'before' | 'after', Workspace>;
    for (const side of ['before', 'after'] as const) {
      const root = join(run.paths.tempDir, side); await mkdir(root); await writeFile(join(root, 'Dockerfile'), 'FROM scratch\n');
      result[side] = { side, root, commit: plan.baseCommit, kind: 'commit', label: side, materializedHash: 'a'.repeat(64), inventory: [], sourceSettings: plan.config.source };
    }
    return result;
  },
  verify: async () => ({ before: { valid: true, actualHash: 'a'.repeat(64), errors: [] }, after: { valid: true, actualHash: 'a'.repeat(64), errors: [] } }),
}));
vi.mock('../../src/runtime/index.js', () => ({ start: async (workspaces: WorkspacePair, _plan: Plan, run: RunContext) => { state.run = run; return state.start!(workspaces, run); } }));
vi.mock('../../src/runtime/process-table.js', async (original) => ({ ...await original<object>(), processTable: async () => [{ pid: process.pid, parent: 1, group: process.pid, started: 'synthetic owner' }] }));
vi.mock('../../src/runtime/supervisor.js', () => ({ createSupervisor: (options: { signal: AbortSignal; onCancel?: () => void }) => { options.signal.addEventListener('abort', () => options.onCancel?.(), { once: true }); return state.supervisor; } }));
vi.mock('playwright', () => ({ chromium: { executablePath: () => process.execPath } }));
vi.mock('../../src/composer/index.js', () => ({ checkMediaCapabilities: async () => {} }));
vi.mock('../../src/recorder/index.js', () => ({ capture: () => { throw new Error('Capture must not run.'); } }));
const roots: string[] = [];
afterEach(async () => { if (state.run) await releaseRunOwnership(state.run); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); state.run = undefined; vi.restoreAllMocks(); });
function barrier() { let resolve = () => {}; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }
const imageId = `sha256:${'c'.repeat(64)}`;
type DockerInternals = { inspectBuilder: () => Promise<unknown>; inspect: (_resource: unknown, _deadline?: number) => Promise<unknown>; removeBuilder: (_resource: unknown, deadline: number) => Promise<boolean> };
async function fixture(options: { validArchive?: boolean; builderRemoval?: (deadline: number) => Promise<boolean>; processStop?: () => Promise<void>; stopAll?: () => Promise<void>; exportFailure?: boolean } = {}) {
  const root = await mkdtemp('/private/tmp/swc-export-terminal-'); roots.push(root);
  const config = parseConfig({ schemaVersion: 2, execution: { start: { kind: 'process', argv: ['synthetic', '{port}'] }, state: { kind: 'stateless' } } });
  state.plan = PlanSchema.parse({ schemaVersion: 2, planId: 'a'.repeat(64), generatedAt: new Date().toISOString(), repoRoot: root, requestedBase: 'HEAD', requestedHead: 'HEAD', baseCommit: 'a'.repeat(40), headCommit: 'a'.repeat(40), baseResolution: 'exact', headKind: 'commit', sourceFingerprint: null, configDigest: 'a'.repeat(64), configSource: null, scenarioSources: [], scenarioDigest: 'a'.repeat(64), inputs: [], inventories: { before: [], after: [] }, sourceStats: { before: { files: 1, bytes: 13, fingerprint: 'a'.repeat(64) }, after: { files: 1, bytes: 13, fingerprint: 'a'.repeat(64) } }, config, scenarios: [parseScenario({ schemaVersion: 2, id: 'synthetic', title: 'Synthetic', steps: [{ id: 'open', op: 'goto', path: '/' }] })], changedFiles: [], coverage: { selected: [{ path: '/', reason: 'EXPLICIT_SELECTION', via: [] }], unresolved: [], omitted: [], unsupported: [], complete: true }, execution: { sourceFileCounts: { before: 1, after: 1 }, sourceBytes: { before: 13, after: 13 }, estimatedSnapshotBytes: 26, environmentReferences: [], notice: 'Synthetic controlled test.' }, warnings: [] });
  const commands = new Map<OwnedProcess, readonly string[]>();
  state.supervisor = {
    async spawn(spec) {
      const argv = spec.argv[0] === 'docker' ? spec.argv.slice(5) : spec.argv;
      if (argv[0] === 'buildx' && argv[1] === 'build') {
        const archive = argv[argv.indexOf('--output') + 1]!.split('dest=')[1]!;
        await writeFile(join(spec.cwd, archive), options.validArchive ? Buffer.alloc(1536) : 'truncated');
        await writeFile(argv[argv.indexOf('--iidfile') + 1]!, imageId);
        await writeFile(argv[argv.indexOf('--metadata-file') + 1]!, JSON.stringify({ 'containerimage.config.digest': imageId }));
      }
      const child: OwnedProcess = { id: String(commands.size), pid: 1, groupId: 1, stdin: null, isAlive: () => false, output: () => ({ stdout: argv[0] === 'lsof' ? 'lsof version information:\n    revision: 4.99.7\n' : '', stderr: '', truncated: false }), exited: Promise.resolve({ code: options.exportFailure && argv[1] === 'build' ? 1 : 0, signal: null, spawnError: null }) };
      commands.set(child, argv); return child;
    },
    async adopt() { throw new Error('No process adoption in this test.'); },
    async stop(child) { if (commands.get(child)?.[1] === 'build') await options.processStop?.(); },
    async stopAll() { await options.stopAll?.(); return { status: 'ok', errors: [] }; },
  };
  const removeBuilder = vi.fn(async (_resource: unknown, deadline: number) => options.builderRemoval ? options.builderRemoval(deadline) : false);
  state.start = async (workspaces, run) => {
    const runtime = Reflect.construct(DockerRuntime, [run, { schemaVersion: 2, runId: run.runId, endpoint: 'unix:///synthetic-not-used', configRelative: 'docker-client', resources: [], pendingCreates: [] }]) as DockerRuntime;
    const internals = runtime as unknown as DockerInternals;
    internals.inspectBuilder = async () => ({ container: {}, volume: {} });
    internals.inspect = async () => ({ Id: imageId, Config: { Labels: {} } });
    internals.removeBuilder = removeBuilder;
    await runtime.build(workspaces.before, '.', 'Dockerfile');
    throw new Error('Build failure was expected.');
  };
  const controller = new AbortController();
  const result = compare({ kind: 'new', request: { invocationDir: root } }, { invocationDir: root, timeoutMs: 60_000, signal: controller.signal, consent: { kind: 'allow-exec' }, diagnostics: { event() {} } });
  return { root, result, controller, removeBuilder };
}
async function retained() {
  const run = state.run!;
  expect((await readOwner(run.paths.runDir)).state).toBe('active');
  expect(await readFile(join(run.paths.repoRoot, '.show-what-changed/run.lock/owner.json'), 'utf8')).toContain(run.runId);
  expect((await readdir(run.paths.privateDir)).filter((path) => path.startsWith('docker-export-'))).toHaveLength(1);
  return JSON.parse(await readFile(join(run.paths.runDir, 'manifest.json'), 'utf8'));
}

test.each([false, true])('terminal result preserves the initial build failure when builder removal fails, export failure=%s', async (exportFailure) => {
  const f = await fixture({ exportFailure, builderRemoval: async () => { throw new Error('builder cleanup failed'); } });
  const result = await f.result; const expected = exportFailure ? 'DOCKER_FAILED' : 'INVALID_IMAGE_ARCHIVE';
  expect(result).toMatchObject({ status: 'failed', exitCode: 6, error: { code: expected }, data: { state: 'terminal', cleanupOutcome: { status: 'failed' } } });
  expect(result.data!.errors.map((error) => error.code)).toEqual(expect.arrayContaining([expected, 'CLEANUP_FAILED']));
  expect(result.data!.cleanupOutcome.errors).not.toHaveLength(0); expect(f.removeBuilder).toHaveBeenCalledTimes(1);
  const saved = await retained(); expect(saved).toMatchObject({ status: 'failed', exitCode: 6, cleanupOutcome: { status: 'failed' } });
});

test('a successful operation with failed builder cleanup cannot produce a successful terminal result', async () => {
  const f = await fixture({ validArchive: true, builderRemoval: async () => { throw failure(5, 'BUILDER_CLEANUP_FAILED', 'cleanup', 'Builder cleanup failed.', 'Inspect.'); } });
  expect(await f.result).toMatchObject({ status: 'failed', exitCode: 5, error: { code: 'BUILDER_CLEANUP_FAILED' }, data: { cleanupOutcome: { status: 'failed' } } });
  await retained();
});

test('the runner terminates on the shared context deadline while producer stop is still blocked', async () => {
  const entered = barrier(); const release = barrier();
  const f = await fixture({ processStop: async () => { entered.resolve(); await release.promise; }, stopAll: () => release.promise });
  await entered.promise;
  const run = state.run!; const deadline = performance.now() + 25; runCleanupLifetime(run).begin(deadline);
  const cleaning = cleanupRun(run);
  const result = await f.result;
  expect(result).toMatchObject({ status: 'failed', exitCode: 5, error: { code: 'CLEANUP_TIMEOUT' }, data: { cleanupOutcome: { status: 'failed' } } });
  expect((await cleaning).status).toBe('failed'); expect(runCleanupLifetime(run).deadline).toBe(deadline);
  expect(f.removeBuilder).not.toHaveBeenCalled(); await retained();
  release.resolve(); await new Promise((done) => setImmediate(done));
  expect((await cleanupRun(run)).status).toBe('failed'); expect(f.removeBuilder).not.toHaveBeenCalled(); await retained();
});

test('cancellation remains the first cause while blocked cleanup times out and retains ownership', async () => {
  const entered = barrier(); const release = barrier();
  const f = await fixture({ processStop: async () => { entered.resolve(); await release.promise; }, stopAll: () => release.promise });
  await entered.promise; runCleanupLifetime(state.run!).begin(performance.now() + 25);
  f.controller.abort(failure(130, 'SIGINT', 'execution', 'Cancelled.', 'Retry.'));
  expect(await f.result).toMatchObject({ status: 'cancelled', exitCode: 130, error: { code: 'SIGINT' }, data: { cleanupOutcome: { status: 'failed' } } });
  await retained(); release.resolve(); await new Promise((done) => setImmediate(done)); expect(f.removeBuilder).not.toHaveBeenCalled();
});

test('a builder that settles after cleanup expiry cannot delete the archive or erase the earlier build error', async () => {
  const entered = barrier(); const release = barrier();
  const f = await fixture({ builderRemoval: async () => { entered.resolve(); await release.promise; return false; } });
  await entered.promise; const run = state.run!; runCleanupLifetime(run).begin(performance.now() + 25);
  const cleaning = cleanupRun(run);
  expect(await f.result).toMatchObject({ status: 'failed', exitCode: 6, error: { code: 'INVALID_IMAGE_ARCHIVE' }, data: { cleanupOutcome: { status: 'failed' } } });
  expect((await cleaning).status).toBe('failed'); await retained();
  release.resolve(); await new Promise((done) => setImmediate(done)); await retained(); expect(f.removeBuilder).toHaveBeenCalledTimes(1);
});


test('late issued removal leaves terminal failure and ownership sticky', async () => {
  const entered = barrier(); const release = barrier();
  lateRm.entered = entered.resolve; lateRm.released = release.promise;
  try {
    const f = await fixture(); await entered.promise;
    const run = state.run!; runCleanupLifetime(run).begin(performance.now() + 25);
    const cleaning = cleanupRun(run);
    const result = await f.result;
    expect(result).toMatchObject({ status: 'failed', exitCode: 6, error: { code: 'INVALID_IMAGE_ARCHIVE' }, data: { cleanupOutcome: { status: 'failed' } } });
    expect((await cleaning).status).toBe('failed');
    expect((await retained()).status).toBe('failed');
    release.resolve();
    await vi.waitFor(async () => { expect((await readdir(run.paths.privateDir)).filter((p) => p.startsWith('docker-export-'))).toHaveLength(0); });
    expect((await readOwner(run.paths.runDir)).state).toBe('active');
    expect(await readFile(join(run.paths.repoRoot, '.show-what-changed/run.lock/owner.json'), 'utf8')).toContain(run.runId);
    expect(JSON.parse(await readFile(join(run.paths.runDir, 'manifest.json'), 'utf8'))).toMatchObject({ status: 'failed', exitCode: 6, cleanupOutcome: { status: 'failed' } });
    expect((await cleanupRun(run)).status).toBe('failed');
    expect(f.removeBuilder).toHaveBeenCalledTimes(1);
  } finally { lateRm.entered = undefined; release.resolve(); }
});
