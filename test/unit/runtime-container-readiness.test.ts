import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import type { ProcessExit, Workspace } from '../../src/schema/contracts.js';
import type { Side } from '../../src/schema/index.js';
import { ConfigSchema, PlanSchema } from '../../src/schema/index.js';
import { cleanupRun, createRunContext } from '../../src/runtime/context.js';
import { start } from '../../src/runtime/index.js';

const docker = vi.hoisted(() => {
  const sides: Side[] = [];
  let exit = () => {};
  const exited = new Promise<ProcessExit>((resolve) => {
    exit = () => resolve({ code: 0, signal: null, spawnError: null });
  });
  const imageId = `sha256:${'a'.repeat(64)}`;
  return {
    sides,
    runtime: {
      network: async (side: Side) => { sides.push(side); return `synthetic-${side}`; },
      image: async () => ({ Id: imageId, Config: { Labels: null } }),
      container: async () => ({ id: 'b'.repeat(64), imageId, exited, verify: async () => { exit(); } }),
    },
  };
});
vi.mock('../../src/runtime/docker.js', () => ({ DockerRuntime: { create: async () => docker.runtime } }));

test('a container exit before readiness fails the recipe before app setup or the second side', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'swc-container-readiness-')));
  const run = await createRunContext({ repoRoot: root, timeoutMs: 60_000, signal: new AbortController().signal, diagnostics: { event() {} } });
  const config = ConfigSchema.parse({ schemaVersion: 2, execution: {
    services: [{ id: 'store', kind: 'container', image: `synthetic@sha256:${'a'.repeat(64)}`, containerPort: 8080, env: {}, ready: { kind: 'http', timeoutMs: 3000 } }],
    setup: [{ argv: [process.execPath, '-e', "require('node:fs').writeFileSync('setup-ran','unexpected')"] }],
    start: { kind: 'process', argv: [process.execPath, '-e', "throw new Error('Application must not start')"] },
    state: { kind: 'stateless' },
  } });
  const workspace = async (side: Side): Promise<Workspace> => {
    const path = join(run.paths.tempDir, side); await mkdir(path);
    return { side, root: path, commit: 'a'.repeat(40), kind: 'commit', label: side, materializedHash: '0'.repeat(64), inventory: [], sourceSettings: config.source };
  };
  const workspaces = { before: await workspace('before'), after: await workspace('after') };
  const stats = { files: 0, bytes: 0, fingerprint: '0'.repeat(64) };
  const plan = PlanSchema.parse({ schemaVersion: 2, planId: '0'.repeat(64), generatedAt: new Date().toISOString(), repoRoot: root, requestedBase: 'HEAD', requestedHead: 'HEAD', baseCommit: 'a'.repeat(40), headCommit: 'a'.repeat(40), baseResolution: 'exact', headKind: 'commit', sourceFingerprint: null, configDigest: '0'.repeat(64), scenarioDigest: '0'.repeat(64), configSource: null, scenarioSources: [], inputs: [], inventories: { before: [], after: [] }, sourceStats: { before: stats, after: stats }, config, scenarios: [{ schemaVersion: 2, id: 'one', title: 'One', steps: [{ id: 'open', op: 'goto', path: '/' }] }], changedFiles: [], coverage: { selected: [], unresolved: [], omitted: [], unsupported: [], complete: true }, execution: { sourceFileCounts: { before: 0, after: 0 }, sourceBytes: { before: 0, after: 0 }, estimatedSnapshotBytes: 0, environmentReferences: [], notice: 'Synthetic boundary test.' }, warnings: [] });
  const readiness = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 503 }));
  let passed = false;
  try {
    await expect(start(workspaces, plan, run)).rejects.toMatchObject({ exitCode: 6, detail: { code: 'SERVER_EXITED' } });
    expect(readiness).toHaveBeenCalled();
    expect(docker.sides).toEqual(['before']);
    for (const side of ['before', 'after'] as const) await expect(readFile(join(workspaces[side].root, 'setup-ran'))).rejects.toMatchObject({ code: 'ENOENT' });
    passed = true;
  } finally {
    readiness.mockRestore();
    expect(await cleanupRun(run)).toEqual({ status: 'ok', errors: [] });
    if (passed) await rm(root, { recursive: true, force: true });
  }
});
