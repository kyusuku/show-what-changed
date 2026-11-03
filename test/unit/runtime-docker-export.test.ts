import { createServer, request } from 'node:http';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, test, vi } from 'vitest';
import type { OwnedProcess, ProcessExit, ResourceRegistry, RunContext, SpawnSpec, Supervisor, Workspace } from '../../src/schema/contracts.js';
import { DockerRuntime } from '../../src/runtime/docker.js';
import { failure } from '../../src/schema/errors.js';
import { runCleanupLifetime } from '../../src/runtime/cleanup-lifetime.js';

const probe = vi.hoisted(() => ({ endpoint: '', reads: [] as string[], reading: undefined as ((path: string) => Promise<void>) | undefined, read: undefined as ((path: string) => void) | undefined, created: undefined as ((path: string) => Promise<void>) | undefined, written: undefined as ((path: string) => Promise<void>) | undefined, writing: undefined as ((source: string, target: string) => Promise<void>) | undefined }));
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs, lstat: async (...args: Parameters<typeof fs.lstat>) => { await probe.reading?.(String(args[0])); return fs.lstat(...args); }, mkdir: async (...args: Parameters<typeof fs.mkdir>) => { const result = await fs.mkdir(...args); await probe.created?.(String(args[0])); return result; }, rename: async (...args: Parameters<typeof fs.rename>) => { await probe.writing?.(String(args[0]), String(args[1])); await fs.rename(...args); await probe.written?.(String(args[1])); } };
});
vi.mock('../../src/runtime/files.js', async (original) => {
  const files = await original<typeof import('../../src/runtime/files.js')>();
  return { ...files, readContainedFile: async (...args: Parameters<typeof files.readContainedFile>) => { probe.reads.push(join(args[0], args[1])); const bytes = await files.readContainedFile(...args); probe.read?.(join(args[0], args[1])); return bytes; } };
});
vi.mock('../../src/runtime/process-table.js', async (original) => ({ ...await original<object>(), systemProbe: vi.fn(async (argv: string[]) => ({ code: 0, stdout: argv.includes('show') ? 'synthetic\n' : probe.endpoint, stderr: '' })) }));
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { vi.useRealTimers(); probe.reads = []; probe.reading = undefined; probe.read = undefined; probe.created = undefined; probe.written = undefined; probe.writing = undefined; for (const cleanup of cleanups.splice(0)) await cleanup(); vi.restoreAllMocks(); });
function barrier() { let release = () => {}; const waiting = new Promise<void>((resolve) => { release = resolve; }); return { waiting, release }; }
const id = 'sha256:2e17a03bfb9683e5e07b7c9b6ae4f485acf5d18f74290a6a105bd4c67dede598';
const manifestId = 'sha256:8df32a848c402f1fcd9e96c7056c593cb777923332e9ce78148372a0ac5c542f';
const manifest = { digest: manifestId, mediaType: 'application/vnd.oci.image.manifest.v1+json', size: 669 };
function manifestMetadata(tag: string) { return { 'containerimage.config.digest': id, 'containerimage.digest': manifestId, 'containerimage.descriptor': { ...manifest, platform: { os: 'linux', architecture: 'arm64' }, annotations: { exporter: 'informational' } }, 'image.name': `docker.io/library/${tag}` }; }
const otherId = `sha256:${'d'.repeat(64)}`;
type RecordResource = { kind: string; name: string; id?: string | null; labels?: Record<string, string>; containerName?: string; volumeName?: string; node?: string };
type Ledger = { pendingCreates: string[]; resources: RecordResource[] };
type Options = { export?: (spec: SpawnSpec, defaults: () => Promise<void>) => Promise<ProcessExit | void>; load?: () => Promise<ProcessExit | void>; stop?: (command: readonly string[]) => Promise<void>; foreignImage?: boolean; returnedId?: string; from?: string; metadata?: (tag: string) => unknown; image?: (value: Record<string, unknown>) => unknown };
async function fixture(options: Options = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'swc-export, space-')));
  const privateDir = join(root, 'private'); const source = join(privateDir, 'workspaces', 'before');
  await mkdir(source, { recursive: true }); await writeFile(join(source, 'Dockerfile'), options.from ?? 'FROM scratch\n');
  const controller = new AbortController();
  const registered: Parameters<ResourceRegistry['register']>[0][] = [];
  const commands: string[][] = [];
  const requestEvents: string[] = [];
  const started = new Map<OwnedProcess, readonly string[]>();
  const stopped = new Set<OwnedProcess>();
  const events: string[] = [];
  let imagePresent = false; let networkPresent = false; let containerPresent = false; let volumePresent = false; let supervisorStopped = false;
  let loadLedger: Ledger | undefined;
  const ledger = async (): Promise<Ledger> => JSON.parse(await readFile(join(privateDir, 'docker.json'), 'utf8'));
  const server = createServer(async (req, res) => {
    requestEvents.push(`${req.method} ${req.url}`);
    const records = await ledger(); const builder = records.resources.find((entry) => entry.kind === 'builder'); const image = records.resources.find((entry) => entry.kind === 'image');
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://fixture').pathname);
    res.setHeader('content-type', 'application/json');
    if (req.method === 'POST' && path === '/images/load') { loadLedger = records; imagePresent = true; res.end('{"stream":"loaded"}'); return; }
    if (path.startsWith('/containers/') && path !== '/containers/json' && containerPresent && builder && [builder.containerName, 'a'.repeat(64)].includes(path.split('/')[2] ?? '')) {
      if (req.method === 'DELETE') { containerPresent = false; events.push('builder-container-deleted'); res.writeHead(204); res.end(); return; }
      res.end(JSON.stringify({ Id: 'a'.repeat(64), Name: `/${builder.containerName}`, Image: otherId, Config: { Image: 'moby/buildkit:buildx-stable-1', Labels: {} }, State: { Running: true, ExitCode: 0 }, HostConfig: { NetworkMode: 'bridge', Privileged: false, PortBindings: null, LogConfig: { Type: 'none', Config: {} } }, NetworkSettings: { Networks: {}, Ports: null }, Mounts: [{ Type: 'volume', Name: builder.volumeName, Destination: '/var/lib/buildkit' }] })); return;
    }
    if (path === '/containers/json') { res.end('[]'); return; }
    if (path === `/volumes/${builder?.volumeName}` && volumePresent) {
      if (req.method === 'DELETE') { volumePresent = false; events.push('builder-volume-deleted'); res.writeHead(204); res.end(); return; }
      res.end(JSON.stringify({ Name: builder?.volumeName, Driver: 'local', CreatedAt: '2026-11-03T00:00:00Z' })); return;
    }
    if (path.startsWith('/networks/') && networkPresent) {
      const network = records.resources.find((entry) => entry.kind === 'network');
      if (network && [network.name, 'e'.repeat(64)].includes(path.split('/')[2] ?? '')) {
        if (req.method === 'DELETE') { networkPresent = false; res.writeHead(204); res.end(); return; }
        res.end(JSON.stringify({ Id: 'e'.repeat(64), Name: network.name, Labels: network.labels })); return;
      }
    }
    if (path.startsWith('/images/') && imagePresent && image && [image.name, options.returnedId ?? id].includes(path.split('/')[2] ?? '')) {
      if (req.method === 'DELETE') { imagePresent = false; events.push('image-deleted'); res.end('[]'); return; }
      res.end(JSON.stringify(imageObservation(image))); return;
    }
    res.writeHead(404); res.end('{"message":"absent"}');
  });
  const imageObservation = (image: RecordResource): unknown => { const value = { Id: options.returnedId ?? id, RepoTags: [image.name], Os: 'linux', Architecture: 'arm64', Config: { Labels: options.foreignImage ? { foreign: 'preserve' } : image.labels } }; return options.image ? options.image(value) : value; };
  const socket = join(root, 'daemon.sock'); await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); }); probe.endpoint = `unix://${socket}`;
  const ok = { code: 0, signal: null, spawnError: null } as const;
  const supervisor: Supervisor = {
    async spawn(spec) {
      if (controller.signal.aborted || supervisorStopped) throw failure(10, 'DEADLINE_EXCEEDED', 'execution', 'Stopped fixture.', 'Retry.');
      const argv = spec.argv.slice(5); commands.push([...argv]);
      if (argv[0] === 'container' && argv[1] === 'create') throw new Error('container creation observed');
      let stdout = ''; let alive = true;
      const exited = (async (): Promise<ProcessExit> => {
        if (argv[0] === 'buildx' && argv[1] === 'create') { containerPresent = true; volumePresent = true; return ok; }
        if (argv[0] === 'buildx' && argv[1] === 'build') {
          events.push('export-start');
          const defaults = async () => {
            const output = argv[argv.indexOf('--output') + 1] ?? '';
            expect(output).toMatch(/^type=docker,dest=docker-export-[a-f0-9]{24}\/image.tar$/);
            const archivePath = join(spec.cwd, output.split('dest=')[1]!);
            await writeFile(archivePath, Buffer.concat([Buffer.from('trusted synthetic exporter'.padEnd(512, '\0')), Buffer.alloc(1024)]));
            await writeFile(argv[argv.indexOf('--iidfile') + 1]!, `${id}\n`);
            await writeFile(argv[argv.indexOf('--metadata-file') + 1]!, JSON.stringify(options.metadata ? options.metadata(argv[argv.indexOf('--tag') + 1]!) : { 'containerimage.config.digest': id, 'buildx.build.provenance': { materials: [{ uri: 'pkg:docker/example/base@latest', digest: { sha256: 'e'.repeat(64) } }] } }));
          };
          const result = options.export ? await options.export(spec, defaults) : await defaults(); events.push('export-closed'); return result ?? ok;
        }
        if (argv[0] === 'image' && argv[1] === 'load') {
          events.push('load-start');
          if (options.load) return await options.load() ?? ok;
          await new Promise<void>((resolve, reject) => { const call = request({ socketPath: socket, path: '/images/load', method: 'POST' }, (response) => { response.resume(); response.on('end', resolve); }); call.on('error', reject); call.end('synthetic Docker archive stream'); });
        }
        if (argv[0] === 'network' && argv[1] === 'create') { networkPresent = true; stdout = 'e'.repeat(64); }
        if (argv[0] === 'image' && argv[1] === 'inspect') { const image = (await ledger()).resources.find((entry) => entry.kind === 'image')!; stdout = JSON.stringify([imageObservation(image)]); }
        return ok;
      })().finally(() => { alive = false; });
      const child: OwnedProcess = { id: String(started.size), pid: 1, groupId: 1, exited, stdin: null, isAlive: () => alive, output: () => ({ stdout, stderr: '', truncated: false }) };
      started.set(child, argv); return child;
    },
    async adopt() { throw new Error('No adoption in this fixture.'); },
    async stop(child) { if (!stopped.has(child)) { await options.stop?.(started.get(child)!); stopped.add(child); events.push(`stopped-${started.get(child)?.slice(0, 2).join('-')}`); } },
    async stopAll() { supervisorStopped = true; await Promise.all([...started.keys()].map((child) => supervisor.stop(child))); return { status: 'ok', errors: [] }; },
  };
  const resources: ResourceRegistry = { register(resource) { registered.push(resource); }, async disposeAll() {
    await supervisor.stopAll(); const errors = [];
    for (const kind of ['builder', 'network', 'image', 'private-dir']) for (const resource of registered.filter((r) => r.kind === kind)) { try { await resource.dispose(performance.now() + 30_000); } catch (error) { errors.push(error); } }
    return { status: errors.length ? 'failed' : 'ok', errors: errors.map(() => ({ code: 'CLEANUP_FAILED', phase: 'cleanup', message: 'fixture cleanup', hint: 'inspect' })) };
  } };
  const run: RunContext = { runId: '20261103T000000000Z-aaaaaaaaaaaaaaaa', paths: { repoRoot: root, runDir: root, privateDir, tempDir: join(privateDir, 'workspaces'), framesDir: '', composedDir: '' }, startedAt: new Date().toISOString(), startedMonotonicMs: performance.now(), deadlineMs: performance.now() + 60_000, signal: controller.signal, diagnostics: { event() {} }, resources, supervisor, redactions: { add() {}, text(value) { return value; } } };
  const workspace: Workspace = { side: 'before', root: source, commit: 'a'.repeat(40), kind: 'commit', label: 'synthetic', materializedHash: 'b'.repeat(64), inventory: [], sourceSettings: { generatedDirs: [], maxFiles: 10, maxBytes: 1024 } };
  const docker = await DockerRuntime.create(run, true);
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
  return { run, controller, registered, commands, requestEvents, events, ledger, workspace, docker, source, privateDir, loadLedger: () => loadLedger, setImagePresent: (present: boolean) => { imagePresent = present; }, archiveDirectories: async () => (await readdir(privateDir)).filter((name) => name.startsWith('docker-export-')) };
}

test('exports into a registered private sibling, stops its producer, then persists intent before Engine load and exact image inspection', async () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  f = await fixture({ from: 'FROM example/base:latest\n', export: async (spec, write) => {
    const before = await f.ledger(); const image = before.resources.find((entry) => entry.kind === 'image')!;
    expect(before.pendingCreates).not.toContain(image.name); expect(f.requestEvents.some((event) => event.startsWith('POST'))).toBe(false);
    const directory = f.registered.find((entry) => entry.kind === 'private-dir')!.identity;
    expect(dirname(directory)).toBe(f.privateDir); expect(directory.startsWith(f.source)).toBe(false); expect((await lstat(directory)).mode & 0o777).toBe(0o700);
    expect(spec.argv).not.toContain('--load'); expect(spec.argv).toContain('--provenance=false'); expect(spec.env?.BUILDX_METADATA_PROVENANCE).toBe('max'); await write();
  } });
  const built = await f.docker.build(f.workspace, '.', 'Dockerfile');
  expect(built.imageId).toBe(id); expect(built.baseImages).toEqual([`pkg:docker/example/base@latest@sha256:${'e'.repeat(64)}`]);
  const records = await f.ledger(); const image = records.resources.find((entry) => entry.kind === 'image')!;
  expect(f.loadLedger()?.pendingCreates).toContain(image.name); expect(records.pendingCreates).toEqual([]);
  expect(f.events.indexOf('stopped-buildx-build')).toBeLessThan(f.events.indexOf('load-start'));
  expect(f.requestEvents).toContain(`GET /images/${encodeURIComponent(image.name)}/json`);
  expect(await f.archiveDirectories()).toEqual([]); expect(f.events).toContain('builder-volume-deleted'); expect(await readdir(f.run.paths.tempDir)).toEqual(['before']);
  expect((await f.run.resources.disposeAll()).status).toBe('ok');
});

test.each(['SIGINT', 'SIGTERM', 'DEADLINE_EXCEEDED'])('cancellation during export by %s issues no image creation and removes the archive after producer stop', async (code) => {
  const entered = barrier(); const finish = barrier(); const stopped = barrier();
  const f = await fixture({ export: async (_spec, write) => { await write(); entered.release(); await finish.waiting; }, stop: async (argv) => { if (argv[0] === 'buildx' && argv[1] === 'build') await stopped.waiting; } });
  const build = f.docker.build(f.workspace, '.', 'Dockerfile'); const rejected = expect(build).rejects.toMatchObject({ detail: { code } });
  await entered.waiting; f.controller.abort(failure(10, code, 'execution', 'cancelled', 'retry'));
  const cleanup = f.run.resources.disposeAll(); finish.release();
  expect(await f.archiveDirectories()).toHaveLength(1); expect(f.requestEvents.some((event) => event.startsWith('POST'))).toBe(false);
  stopped.release(); await rejected; expect((await cleanup).status).toBe('ok');
  expect((await f.ledger()).pendingCreates).toEqual([]); expect(await f.archiveDirectories()).toEqual([]);
});

test.each(['missing', 'partial', 'symlink', 'bad-iid', 'mismatched-iid', 'missing-provenance', 'failed-export'])('rejects %s export before load', async (kind) => {
  const f = await fixture({ from: 'FROM example/base:latest\n', export: async (spec, defaults) => {
    await defaults(); const args = spec.argv; const path = join(spec.cwd, (args[args.indexOf('--output') + 1]!).split('dest=')[1]!);
    if (kind === 'missing') await rm(path);
    if (kind === 'partial') await writeFile(path, 'truncated export');
    if (kind === 'symlink') { await rm(path); await symlink(join(f.source, 'Dockerfile'), path); }
    if (kind === 'bad-iid') await writeFile(args[args.indexOf('--iidfile') + 1]!, 'not-an-image');
    if (kind === 'mismatched-iid') await writeFile(args[args.indexOf('--iidfile') + 1]!, otherId);
    if (kind === 'missing-provenance') await writeFile(args[args.indexOf('--metadata-file') + 1]!, JSON.stringify({ 'containerimage.config.digest': id }));
    if (kind === 'failed-export') return { code: 1, signal: null, spawnError: null };
  } });
  await expect(f.docker.build(f.workspace, '.', 'Dockerfile')).rejects.toThrow();
  expect(f.requestEvents.some((event) => event.startsWith('POST'))).toBe(false); expect(f.commands.some((argv) => argv[0] === 'image' && argv[1] === 'load')).toBe(false);
  expect((await f.ledger()).pendingCreates).toEqual([]); expect(await f.archiveDirectories()).toEqual([]); expect(await readFile(join(f.source, 'Dockerfile'), 'utf8')).toBe('FROM example/base:latest\n');
});

test('a lost load response retains image uncertainty across 404 while independently deleting the archive', async () => {
  const f = await fixture({ load: async () => ({ code: 1, signal: null, spawnError: null }) });
  await expect(f.docker.build(f.workspace, '.', 'Dockerfile')).rejects.toThrow();
  const records = await f.ledger(); const image = records.resources.find((entry) => entry.kind === 'image')!;
  expect(records.pendingCreates).toEqual([image.name]); expect(await f.archiveDirectories()).toEqual([]);
  expect((await f.run.resources.disposeAll()).status).toBe('failed'); expect((await f.ledger()).pendingCreates).toEqual([image.name]);
  expect(f.requestEvents.some((event) => event.startsWith('DELETE /images/'))).toBe(false);
});

test('foreign ownership labels remain undeleted after load and failed exact inspection', async () => {
  const f = await fixture({ foreignImage: true });
  await expect(f.docker.build(f.workspace, '.', 'Dockerfile')).rejects.toMatchObject({ detail: { code: 'DOCKER_OWNERSHIP_UNCERTAIN' } });
  expect((await f.run.resources.disposeAll()).status).toBe('failed'); expect(f.events).not.toContain('image-deleted'); expect((await f.ledger()).pendingCreates).toHaveLength(1); expect(await f.archiveDirectories()).toEqual([]);
});

test('an image ID mismatch is rejected before settling the pending load', async () => {
  const f = await fixture({ returnedId: otherId });
  await expect(f.docker.build(f.workspace, '.', 'Dockerfile')).rejects.toMatchObject({ detail: { code: 'DOCKER_OWNERSHIP_UNCERTAIN' } });
  expect((await f.ledger()).pendingCreates).toHaveLength(1); expect(await f.archiveDirectories()).toEqual([]);
});

test('a producer stop failure retains its archive and builder for inspection', async () => {
  const stopped = new Error('producer still active');
  const f = await fixture({ stop: async (argv) => { if (argv[0] === 'buildx' && argv[1] === 'build') throw stopped; } });
  await expect(f.docker.build(f.workspace, '.', 'Dockerfile')).rejects.toBe(stopped);
  await expect(f.registered.find((resource) => resource.kind === 'builder')!.dispose(performance.now() + 30_000)).rejects.toMatchObject({ detail: { code: 'PROCESS_CLEANUP_FAILED' } });
  expect(await f.archiveDirectories()).toHaveLength(1); expect(f.events).not.toContain('builder-container-deleted'); expect(f.requestEvents.some((event) => event.startsWith('POST'))).toBe(false);
});

test('directory replacement protects the foreign replacement from deletion', async () => {
  let replacement = '';
  const f = await fixture({ export: async (spec, defaults) => {
    await defaults(); const path = join(spec.cwd, (spec.argv[spec.argv.indexOf('--output') + 1]!).split('dest=')[1]!); replacement = dirname(path);
    await rename(replacement, `${replacement}-original`); await mkdir(replacement); await writeFile(join(replacement, 'foreign'), 'preserve');
  } });
  await expect(f.docker.build(f.workspace, '.', 'Dockerfile')).rejects.toMatchObject({ detail: { code: 'INVALID_IMAGE_ARCHIVE' } });
  expect(await readFile(join(replacement, 'foreign'), 'utf8')).toBe('preserve'); expect(f.requestEvents.some((event) => event.startsWith('POST'))).toBe(false);
});

test('cancellation while directory creation completes retains its identity until disposal', async () => {
  const f = await fixture(); const created = barrier(); const finishCreation = barrier();
  probe.created = async (path) => { if (path.includes('/docker-export-')) { expect(f.registered.some((resource) => resource.identity === path)).toBe(true); created.release(); await finishCreation.waiting; } };
  const build = f.docker.build(f.workspace, '.', 'Dockerfile'); const rejected = expect(build).rejects.toMatchObject({ detail: { code: 'CANCELLED' } });
  await created.waiting; f.controller.abort(failure(10, 'CANCELLED', 'execution', 'cancelled', 'retry'));
  const cleanup = f.run.resources.disposeAll(); expect(await f.archiveDirectories()).toHaveLength(1); finishCreation.release();
  await rejected; expect((await cleanup).status).toBe('ok'); expect(await f.archiveDirectories()).toEqual([]);
  expect(f.commands.some((argv) => argv[0] === 'buildx' && argv[1] === 'create')).toBe(false); expect((await f.ledger()).pendingCreates).toEqual([]);
});

test('cancellation at the durable load intent prevents spawn and truthfully retains the intent', async () => {
  const f = await fixture(); const persisted = barrier(); const releasePersist = barrier(); let gated = false;
  probe.written = async (path) => {
    if (path !== join(f.privateDir, 'docker.json') || gated) return;
    const records = await f.ledger(); const image = records.resources.find((resource) => resource.kind === 'image');
    if (image && records.pendingCreates.includes(image.name)) { gated = true; persisted.release(); await releasePersist.waiting; }
  };
  const build = f.docker.build(f.workspace, '.', 'Dockerfile'); const rejected = expect(build).rejects.toMatchObject({ detail: { code: 'CANCELLED' } });
  await persisted.waiting; f.controller.abort(failure(10, 'CANCELLED', 'execution', 'cancelled', 'retry'));
  const cleanup = f.run.resources.disposeAll();
  expect(f.requestEvents.some((event) => event.includes('/images/'))).toBe(false);
  releasePersist.release(); await rejected; expect((await cleanup).status).toBe('failed');
  expect(f.commands.some((argv) => argv[0] === 'image' && argv[1] === 'load')).toBe(false); expect(f.requestEvents.some((event) => event.startsWith('POST'))).toBe(false);
  expect((await f.ledger()).pendingCreates).toHaveLength(1); expect(await f.archiveDirectories()).toEqual([]);
});

test('manual cleanup cannot inspect the image or overtake a paused load issuance', async () => {
  const f = await fixture(); const persisted = barrier(); const releasePersist = barrier(); let gated = false;
  probe.written = async (path) => {
    if (path !== join(f.privateDir, 'docker.json') || gated) return;
    const records = await f.ledger(); const image = records.resources.find((resource) => resource.kind === 'image');
    if (image && records.pendingCreates.includes(image.name)) { gated = true; persisted.release(); await releasePersist.waiting; }
  };
  const build = f.docker.build(f.workspace, '.', 'Dockerfile'); const rejected = expect(build).rejects.toThrow();
  await persisted.waiting; const cleanup = f.run.resources.disposeAll();
  expect(f.requestEvents.some((event) => event.includes('/images/'))).toBe(false);
  releasePersist.release(); await rejected; expect((await cleanup).status).toBe('failed');
  expect(f.commands.some((argv) => argv[0] === 'image' && argv[1] === 'load')).toBe(false); expect(await f.archiveDirectories()).toEqual([]);
});

test('a replaced archive at the durable issuance boundary is retained as uncertain without reaching load', async () => {
  const f = await fixture(); let changed = false;
  probe.written = async (path) => {
    if (path !== join(f.privateDir, 'docker.json') || changed) return;
    const records = await f.ledger(); const image = records.resources.find((resource) => resource.kind === 'image');
    if (image && records.pendingCreates.includes(image.name)) { changed = true; const name = (await f.archiveDirectories())[0]!; await writeFile(join(f.privateDir, name, 'image.tar'), 'replaced'); }
  };
  await expect(f.docker.build(f.workspace, '.', 'Dockerfile')).rejects.toMatchObject({ detail: { code: 'INVALID_IMAGE_ARCHIVE' } });
  expect((await f.ledger()).pendingCreates).toHaveLength(1); expect(f.commands.some((argv) => argv[0] === 'image' && argv[1] === 'load')).toBe(false); expect(await f.archiveDirectories()).toEqual([]);
});

test('cancellation while load is active preserves uncertainty and waits for the consumer to stop before archive removal', async () => {
  const loading = barrier(); const finishLoad = barrier(); const stopped = barrier();
  const f = await fixture({ load: async () => { loading.release(); await finishLoad.waiting; }, stop: async (argv) => { if (argv[0] === 'image' && argv[1] === 'load') await stopped.waiting; } });
  const build = f.docker.build(f.workspace, '.', 'Dockerfile'); const rejected = expect(build).rejects.toMatchObject({ detail: { code: 'CANCELLED' } });
  await loading.waiting; f.controller.abort(failure(10, 'CANCELLED', 'execution', 'cancelled', 'retry')); const cleanup = f.run.resources.disposeAll(); finishLoad.release();
  expect(await f.archiveDirectories()).toHaveLength(1); expect((await f.ledger()).pendingCreates).toHaveLength(1);
  stopped.release(); await rejected; expect((await cleanup).status).toBe('failed'); expect(await f.archiveDirectories()).toEqual([]); expect((await f.ledger()).pendingCreates).toHaveLength(1);
});

test.each([1, 2])('ledger version %s requires export proof before reconciling a legacy pending image', async (schemaVersion) => {
  const f = await fixture(); const nonce = 'f'.repeat(32); const name = `swc-before-${nonce}:app`;
  await writeFile(join(f.privateDir, 'docker.json'), JSON.stringify({ schemaVersion, runId: f.run.runId, endpoint: probe.endpoint, configRelative: 'docker-client', ...(schemaVersion === 2 ? { pendingCreates: [name] } : {}), resources: [{ kind: 'image', side: 'before', name, id: null, labels: { 'io.show-what-changed.run': f.run.runId, 'io.show-what-changed.side': 'before', 'io.show-what-changed.nonce': nonce } }] }));
  await expect(DockerRuntime.recover(f.run.paths.runDir, f.run.runId)).rejects.toMatchObject({ detail: { code: 'DOCKER_CREATION_UNCERTAIN' } }); expect(f.events).not.toContain('image-deleted');
  f.setImagePresent(true); await expect(DockerRuntime.recover(f.run.paths.runDir, f.run.runId)).rejects.toThrow();
  expect(f.events).not.toContain('image-deleted'); expect((await f.ledger()).resources[0]?.id).toBeNull();
  await writeFile(join(f.privateDir, 'before-image-id'), id); await writeFile(join(f.privateDir, 'before-build-metadata.json'), JSON.stringify({ 'containerimage.config.digest': id, 'image.name': name }));
  expect(await DockerRuntime.recover(f.run.paths.runDir, f.run.runId)).toBe(true); expect(f.events).toContain('image-deleted');
  expect((await f.ledger()).pendingCreates).toEqual([]); expect(await DockerRuntime.recover(f.run.paths.runDir, f.run.runId)).toBe(false);
});

test('retained manifest identity is persisted, passed to container creation and removed by its actual Engine ID', async () => {
  const f = await fixture({ returnedId: manifestId, metadata: manifestMetadata, image: (value) => ({ ...value, Descriptor: { ...manifest, annotations: { engine: 'different informational annotations' } }, RootFS: { Type: 'layers', Layers: [otherId] } }) });
  const built = await f.docker.build(f.workspace, '.', 'Dockerfile');
  expect(built.imageId).toBe(manifestId); expect((await f.ledger()).resources.find((resource) => resource.kind === 'image')?.id).toBe(manifestId);
  const network = await f.docker.network('before');
  const inputsRoot = await realpath(await mkdtemp(join(tmpdir(), 'swc-container-inputs-'))); cleanups.push(() => rm(inputsRoot, { recursive: true, force: true }));
  const stateDir = join(inputsRoot, 'state'); const inputDir = join(inputsRoot, 'inputs'); await mkdir(stateDir); await mkdir(inputDir);
  await expect(f.docker.container({ side: 'before', image: built.imageId, network, alias: 'app', port: 4321, containerPort: 8080, env: {}, inputs: { directory: inputsRoot, stateDir, inputDir, files: new Map<string, string>() } })).rejects.toThrow('container creation observed');
  expect(f.commands.find((argv) => argv[0] === 'container' && argv[1] === 'create')?.at(-1)).toBe(manifestId);
  await f.registered.find((resource) => resource.kind === 'image')!.dispose(performance.now() + 30_000);
  expect(f.requestEvents).toContain(`DELETE /images/${encodeURIComponent(manifestId)}?force=0&noprune=1`);
  expect(f.requestEvents).not.toContain(`DELETE /images/${encodeURIComponent(id)}?force=0&noprune=1`);
});

test.each([false, true])('classic config-ID storage accepts consistent manifest evidence with Engine descriptor=%s', async (descriptor) => {
  const f = await fixture({ metadata: manifestMetadata, image: (value) => descriptor ? { ...value, Descriptor: manifest } : value });
  expect((await f.docker.build(f.workspace, '.', 'Dockerfile')).imageId).toBe(id);
  expect((await f.run.resources.disposeAll()).status).toBe('ok');
  expect(f.requestEvents).toContain(`DELETE /images/${encodeURIComponent(id)}?force=0&noprune=1`);
});

test('Docker schema2 manifest identity is accepted with matching Engine evidence', async () => {
  const descriptor = { ...manifest, mediaType: 'application/vnd.docker.distribution.manifest.v2+json' };
  const f = await fixture({ returnedId: manifestId, metadata: (tag) => ({ ...manifestMetadata(tag), 'containerimage.descriptor': descriptor, 'image.name': tag }), image: (value) => ({ ...value, Descriptor: descriptor }) });
  expect((await f.docker.build(f.workspace, '.', 'Dockerfile')).imageId).toBe(manifestId);
  expect((await f.run.resources.disposeAll()).status).toBe('ok');
});

const malformedMetadata = [
  ['missing config', (value: ReturnType<typeof manifestMetadata>) => ({ ...value, 'containerimage.config.digest': undefined })],
  ['invalid config', (value: ReturnType<typeof manifestMetadata>) => ({ ...value, 'containerimage.config.digest': 'not-a-digest' })],
  ['manifest without descriptor', (value: ReturnType<typeof manifestMetadata>) => ({ ...value, 'containerimage.descriptor': undefined })],
  ['descriptor without manifest', (value: ReturnType<typeof manifestMetadata>) => ({ ...value, 'containerimage.digest': undefined })],
  ['invalid manifest', (value: ReturnType<typeof manifestMetadata>) => ({ ...value, 'containerimage.digest': 'not-a-digest' })],
  ['null descriptor', (value: ReturnType<typeof manifestMetadata>) => ({ ...value, 'containerimage.descriptor': null })],
  ['conflicting descriptor', (value: ReturnType<typeof manifestMetadata>) => ({ ...value, 'containerimage.descriptor': { ...manifest, digest: otherId } })],
  ['index descriptor', (value: ReturnType<typeof manifestMetadata>) => ({ ...value, 'containerimage.descriptor': { ...manifest, mediaType: 'application/vnd.oci.image.index.v1+json' } })],
  ['zero descriptor size', (value: ReturnType<typeof manifestMetadata>) => ({ ...value, 'containerimage.descriptor': { ...manifest, size: 0 } })],
  ['fractional descriptor size', (value: ReturnType<typeof manifestMetadata>) => ({ ...value, 'containerimage.descriptor': { ...manifest, size: 1.5 } })],
  ['unsafe descriptor size', (value: ReturnType<typeof manifestMetadata>) => ({ ...value, 'containerimage.descriptor': { ...manifest, size: Number.MAX_SAFE_INTEGER + 1 } })],
  ['malformed platform', (value: ReturnType<typeof manifestMetadata>) => ({ ...value, 'containerimage.descriptor': { ...manifest, platform: { os: 'linux' } } })],
  ['wrong tag', (value: ReturnType<typeof manifestMetadata>) => ({ ...value, 'image.name': 'foreign:app' })],
  ['multiple metadata tags', (value: ReturnType<typeof manifestMetadata>) => ({ ...value, 'image.name': `${value['image.name']},foreign:app` })],
] as const;
test.each(malformedMetadata)('rejects metadata with %s before issuing load', async (_name, mutate) => {
  const f = await fixture({ metadata: (tag) => mutate(manifestMetadata(tag)) });
  await expect(f.docker.build(f.workspace, '.', 'Dockerfile')).rejects.toMatchObject({ detail: { code: 'INVALID_IMAGE_IDENTITY' } });
  expect(f.commands.some((argv) => argv[0] === 'image' && argv[1] === 'load')).toBe(false);
  expect((await f.ledger()).resources.find((resource) => resource.kind === 'image')?.id).toBeNull(); expect((await f.ledger()).pendingCreates).toEqual([]);
});

test.each(['missing iid', 'missing metadata', 'oversized iid', 'oversized metadata', 'malformed JSON'])('rejects %s before load', async (kind) => {
  const f = await fixture({ export: async (spec, defaults) => {
    await defaults(); const iid = spec.argv[spec.argv.indexOf('--iidfile') + 1]!; const metadata = spec.argv[spec.argv.indexOf('--metadata-file') + 1]!;
    if (kind === 'missing iid') await rm(iid);
    if (kind === 'missing metadata') await rm(metadata);
    if (kind === 'oversized iid') await writeFile(iid, Buffer.alloc(1025));
    if (kind === 'oversized metadata') await writeFile(metadata, Buffer.alloc(5 * 1024 * 1024 + 1));
    if (kind === 'malformed JSON') await writeFile(metadata, '{');
  } });
  await expect(f.docker.build(f.workspace, '.', 'Dockerfile')).rejects.toThrow();
  expect(f.commands.some((argv) => argv[0] === 'image' && argv[1] === 'load')).toBe(false); expect((await f.ledger()).pendingCreates).toEqual([]);
});

const invalidObservations = [
  ['unrelated ID', { Id: otherId }], ['missing descriptor', { Descriptor: undefined }], ['null descriptor', { Descriptor: null }],
  ['descriptor digest', { Descriptor: { ...manifest, digest: otherId } }], ['descriptor media type', { Descriptor: { ...manifest, mediaType: 'application/vnd.oci.image.index.v1+json' } }],
  ['descriptor size', { Descriptor: { ...manifest, size: 668 } }], ['descriptor platform', { Descriptor: { ...manifest, platform: { os: 'linux', architecture: 'amd64' } } }], ['missing OS', { Os: undefined }], ['malformed descriptor size', { Descriptor: { ...manifest, size: '669' } }],
  ['wrong tag', { RepoTags: ['foreign:app'] }], ['extra tag', { RepoTags: ['foreign:app', 'also:foreign'] }], ['missing tags', { RepoTags: undefined }],
  ['foreign labels', { Config: { Labels: { foreign: 'preserve' } } }], ['wrong OS', { Os: 'windows' }], ['wrong architecture', { Architecture: 'amd64' }], ['wrong variant', { Variant: 'v8' }],
] as const;
test.each(invalidObservations)('refuses %s after load and retains pending proof through cleanup and recovery', async (_name, changed) => {
  const f = await fixture({ returnedId: manifestId, metadata: manifestMetadata, image: (value) => ({ ...value, Descriptor: manifest, ...changed }) });
  await expect(f.docker.build(f.workspace, '.', 'Dockerfile')).rejects.toMatchObject({ detail: { code: 'DOCKER_OWNERSHIP_UNCERTAIN' } });
  const image = (await f.ledger()).resources.find((resource) => resource.kind === 'image')!;
  expect(image.id).toBeNull(); expect((await f.ledger()).pendingCreates).toEqual([image.name]);
  expect((await f.run.resources.disposeAll()).status).toBe('failed'); await expect(DockerRuntime.recover(f.run.paths.runDir, f.run.runId)).rejects.toThrow();
  expect(f.requestEvents.some((event) => event.startsWith('DELETE /images/'))).toBe(false); expect((await f.ledger()).resources.find((resource) => resource.kind === 'image')?.id).toBeNull();
});

test.each(['conflicting', 'malformed', 'without metadata'])('config-ID storage refuses a %s Engine descriptor', async (kind) => {
  const f = await fixture({ ...(kind === 'without metadata' ? {} : { metadata: manifestMetadata }), image: (value) => ({ ...value, Descriptor: kind === 'malformed' ? null : { ...manifest, ...(kind === 'conflicting' ? { digest: otherId } : {}) } }) });
  await expect(f.docker.build(f.workspace, '.', 'Dockerfile')).rejects.toMatchObject({ detail: { code: 'DOCKER_OWNERSHIP_UNCERTAIN' } });
  expect((await f.ledger()).pendingCreates).toHaveLength(1); expect((await f.ledger()).resources.find((resource) => resource.kind === 'image')?.id).toBeNull();
});

test('interrupted load recovers from durable proof after archive disposal and persists the actual ID before deletion', async () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  f = await fixture({ returnedId: manifestId, metadata: manifestMetadata, image: (value) => ({ ...value, Descriptor: manifest }), load: async () => { f.setImagePresent(true); return { code: 1, signal: null, spawnError: null }; } });
  await expect(f.docker.build(f.workspace, '.', 'Dockerfile')).rejects.toThrow(); expect(await f.archiveDirectories()).toEqual([]);
  expect((await f.ledger()).resources.find((resource) => resource.kind === 'image')?.id).toBeNull();
  const persisted: Ledger[] = []; probe.written = async (path) => { if (path === join(f.privateDir, 'docker.json')) persisted.push(await f.ledger()); };
  expect(await DockerRuntime.recover(f.run.paths.runDir, f.run.runId)).toBe(true);
  expect(persisted.some((records) => records.resources.some((resource) => resource.id === manifestId) && records.pendingCreates.length === 0)).toBe(true);
  expect(f.requestEvents).toContain(`DELETE /images/${encodeURIComponent(manifestId)}?force=0&noprune=1`); expect(await DockerRuntime.recover(f.run.paths.runDir, f.run.runId)).toBe(false);
});

test.each(['missing iid', 'missing metadata', 'malformed metadata', 'mismatched iid', 'wrong metadata tag', 'wrong Engine ID', '404'])('interrupted load with %s retains uncertainty after archive disposal', async (kind) => {
  let f: Awaited<ReturnType<typeof fixture>>;
  f = await fixture({ returnedId: kind === 'wrong Engine ID' ? otherId : manifestId, metadata: manifestMetadata, image: (value) => ({ ...value, Descriptor: manifest }), load: async () => { f.setImagePresent(kind !== '404'); return { code: 1, signal: null, spawnError: null }; } });
  await expect(f.docker.build(f.workspace, '.', 'Dockerfile')).rejects.toThrow(); expect(await f.archiveDirectories()).toEqual([]);
  if (kind === 'missing iid') await rm(join(f.privateDir, 'before-image-id'));
  if (kind === 'missing metadata') await rm(join(f.privateDir, 'before-build-metadata.json'));
  if (kind === 'malformed metadata') await writeFile(join(f.privateDir, 'before-build-metadata.json'), '{');
  if (kind === 'mismatched iid') await writeFile(join(f.privateDir, 'before-image-id'), otherId);
  if (kind === 'wrong metadata tag') await writeFile(join(f.privateDir, 'before-build-metadata.json'), JSON.stringify(manifestMetadata('foreign:app')));
  await expect(DockerRuntime.recover(f.run.paths.runDir, f.run.runId)).rejects.toThrow();
  expect((await f.ledger()).pendingCreates).toHaveLength(1); expect((await f.ledger()).resources.find((resource) => resource.kind === 'image')?.id).toBeNull(); expect(f.events).not.toContain('image-deleted');
});

test('an unissued registered image refuses a same-name collision even with matching proof and labels', async () => {
  const f = await fixture({ export: async (_spec, defaults) => { await defaults(); return { code: 1, signal: null, spawnError: null }; } });
  await expect(f.docker.build(f.workspace, '.', 'Dockerfile')).rejects.toThrow(); f.setImagePresent(true);
  expect((await f.ledger()).pendingCreates).toEqual([]); await expect(DockerRuntime.recover(f.run.paths.runDir, f.run.runId)).rejects.toMatchObject({ detail: { code: 'DOCKER_OWNERSHIP_UNCERTAIN' } });
  expect(f.events).not.toContain('image-deleted'); expect((await f.ledger()).resources.find((resource) => resource.kind === 'image')?.id).toBeNull();
});

test.each([1, 2])('confirmed historical ledger %s keeps exact cleanup without export evidence', async (schemaVersion) => {
  const f = await fixture(); const nonce = 'f'.repeat(32); const name = `swc-before-${nonce}:app`;
  await writeFile(join(f.privateDir, 'docker.json'), JSON.stringify({ schemaVersion, runId: f.run.runId, endpoint: probe.endpoint, configRelative: 'docker-client', ...(schemaVersion === 2 ? { pendingCreates: [] } : {}), resources: [{ kind: 'image', side: 'before', name, id, labels: { 'io.show-what-changed.run': f.run.runId, 'io.show-what-changed.side': 'before', 'io.show-what-changed.nonce': nonce } }] }));
  f.setImagePresent(true); expect(await DockerRuntime.recover(f.run.paths.runDir, f.run.runId)).toBe(true);
  expect(f.requestEvents).toContain(`DELETE /images/${encodeURIComponent(id)}?force=0&noprune=1`);
});

test('failed adoption persistence cannot return a build or delete the image and recovery uses the durable pending proof', async () => {
  const f = await fixture({ returnedId: manifestId, metadata: manifestMetadata, image: (value) => ({ ...value, Descriptor: manifest }) }); const refused = new Error('adoption persistence refused');
  probe.writing = async (source, target) => {
    if (target !== join(f.privateDir, 'docker.json')) return;
    const records: Ledger = JSON.parse(await readFile(source, 'utf8'));
    if (records.resources.some((resource) => resource.kind === 'image' && resource.id === manifestId)) throw refused;
  };
  await expect(f.docker.build(f.workspace, '.', 'Dockerfile')).rejects.toBe(refused);
  expect((await f.ledger()).resources.find((resource) => resource.kind === 'image')?.id).toBeNull(); expect((await f.ledger()).pendingCreates).toHaveLength(1);
  expect((await f.run.resources.disposeAll()).status).toBe('failed'); expect(f.events).not.toContain('image-deleted');
  probe.writing = undefined; expect(await DockerRuntime.recover(f.run.paths.runDir, f.run.runId)).toBe(true);
  expect(f.requestEvents).toContain(`DELETE /images/${encodeURIComponent(manifestId)}?force=0&noprune=1`);
});


test.each(['missing digest', 'invalid digest'])('a non-scratch base with %s cannot reach load', async (kind) => {
  const f = await fixture({ from: 'FROM example/base:latest\n', metadata: () => ({ 'containerimage.config.digest': id, 'buildx.build.provenance': { materials: [{ uri: 'pkg:docker/example/base@latest', digest: kind === 'missing digest' ? {} : { sha256: 'unresolved' } }] } }) });
  await expect(f.docker.build(f.workspace, '.', 'Dockerfile')).rejects.toThrow();
  expect(f.commands.some((argv) => argv[0] === 'image' && argv[1] === 'load')).toBe(false); expect((await f.ledger()).pendingCreates).toEqual([]);
});

test('matching platform variants in metadata, Engine descriptor and image are accepted', async () => {
  const platform = { os: 'linux', architecture: 'arm64', variant: 'v8' }; const descriptor = { ...manifest, platform };
  const f = await fixture({ returnedId: manifestId, metadata: (tag) => ({ ...manifestMetadata(tag), 'containerimage.descriptor': descriptor }), image: (value) => ({ ...value, Variant: 'v8', Descriptor: descriptor }) });
  expect((await f.docker.build(f.workspace, '.', 'Dockerfile')).imageId).toBe(manifestId); expect((await f.run.resources.disposeAll()).status).toBe('ok');
});


async function interruptedImage() {
  let f: Awaited<ReturnType<typeof fixture>>;
  f = await fixture({ returnedId: manifestId, metadata: manifestMetadata, image: (value) => ({ ...value, Descriptor: manifest }), load: async () => { f.setImagePresent(true); return { code: 1, signal: null, spawnError: null }; } });
  await expect(f.docker.build(f.workspace, '.', 'Dockerfile')).rejects.toMatchObject({ detail: { code: 'DOCKER_FAILED' } });
  return f;
}
function stalledProof(f: Awaited<ReturnType<typeof fixture>>, file: string) {
  const entered = barrier(); const release = barrier(); const finished = barrier();
  const path = join(f.privateDir, file);
  probe.reading = async (reading) => { if (reading === path) { entered.release(); await release.waiting; } };
  probe.read = (read) => { if (read === path) finished.release(); };
  cleanups.unshift(async () => { release.release(); });
  return { entered, release, finished };
}
async function releaseProof(stalled: Pick<ReturnType<typeof stalledProof>, 'release' | 'finished'>) {
  const reads = [...probe.reads];
  stalled.release.release(); await stalled.finished.waiting;
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(probe.reads).toEqual(reads);
}
async function expectPendingImage(f: Awaited<ReturnType<typeof fixture>>, original: string) {
  expect(await readFile(join(f.privateDir, 'docker.json'), 'utf8')).toBe(original);
  expect(f.requestEvents.some((event) => event.startsWith('DELETE /images/'))).toBe(false);
  const records: Ledger = JSON.parse(original);
  expect(f.docker).toMatchObject({ ledger: { pendingCreates: records.pendingCreates, resources: expect.arrayContaining([expect.objectContaining({ kind: 'image', id: null })]) } });
}
const proofFiles = ['before-image-id', 'before-build-metadata.json'] as const;
const cleanupModes = ['recovery', 'residue inspection', 'ordinary disposal'] as const;
for (const mode of cleanupModes) test.each(proofFiles)(`${mode} bounds a stalled %s and never adopts its late completion`, async (file) => {
  const f = await interruptedImage(); const original = await readFile(join(f.privateDir, 'docker.json'), 'utf8');
  const stalled = stalledProof(f, file); let writes = 0;
  probe.writing = async (_source, target) => { if (target === join(f.privateDir, 'docker.json')) writes++; };
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const started = performance.now(); const clock = vi.spyOn(performance, 'now').mockReturnValue(started);
  const deadline = started + 30_000;
  if (mode === 'ordinary disposal') runCleanupLifetime(f.run).begin(deadline);
  const operation = mode === 'ordinary disposal' ? f.registered.find((resource) => resource.kind === 'image')!.dispose(deadline) : DockerRuntime.recover(f.run.paths.runDir, f.run.runId, mode === 'recovery');
  const rejected = expect(operation).rejects.toMatchObject({ detail: { code: 'CLEANUP_TIMEOUT' } });
  await stalled.entered.waiting;
  clock.mockReturnValue(deadline + 1);
  await vi.advanceTimersByTimeAsync(30_001); await rejected;
  await expectPendingImage(f, original); expect(writes).toBe(0);
  await releaseProof(stalled);
  await expectPendingImage(f, original); expect(writes).toBe(0);
});
for (const mode of cleanupModes) test.each(proofFiles)(`${mode} refuses %s released after the original deadline before its timer fires`, async (file) => {
  const f = await interruptedImage(); const original = await readFile(join(f.privateDir, 'docker.json'), 'utf8');
  const stalled = stalledProof(f, file); let writes = 0;
  probe.writing = async (_source, target) => { if (target === join(f.privateDir, 'docker.json')) writes++; };
  const started = performance.now(); const clock = vi.spyOn(performance, 'now').mockReturnValue(started);
  const deadline = started + 30_000;
  const operation = mode === 'ordinary disposal' ? f.registered.find((resource) => resource.kind === 'image')!.dispose(deadline) : DockerRuntime.recover(f.run.paths.runDir, f.run.runId, mode === 'recovery');
  const rejected = expect(operation).rejects.toThrow();
  await stalled.entered.waiting; clock.mockReturnValue(deadline + 1);
  stalled.release.release(); await rejected;
  await expectPendingImage(f, original); expect(writes).toBe(0);
});
for (const stage of ['before load', 'after load'] as const) test.each(proofFiles)(`execution ${stage} bounds a stalled %s by the original run deadline`, async (file) => {
  const f = await fixture({ returnedId: manifestId, metadata: manifestMetadata, image: (value) => ({ ...value, Descriptor: manifest }) });
  const entered = barrier(); const release = barrier(); const finished = barrier(); const path = join(f.privateDir, file);
  probe.reading = async (reading) => { if (reading === path && f.events.includes('load-start') === (stage === 'after load')) { entered.release(); await release.waiting; } };
  probe.read = (read) => { if (read === path && f.events.includes('load-start') === (stage === 'after load')) finished.release(); };
  cleanups.unshift(async () => { release.release(); });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const build = f.docker.build(f.workspace, '.', 'Dockerfile'); const rejected = expect(build).rejects.toMatchObject({ detail: { code: 'CLEANUP_TIMEOUT' } });
  await entered.waiting; const original = await readFile(join(f.privateDir, 'docker.json'), 'utf8');
  vi.spyOn(performance, 'now').mockReturnValue(f.run.deadlineMs + 1);
  await vi.advanceTimersByTimeAsync(60_001); await rejected;
  await releaseProof({ release, finished });
  await expectPendingImage(f, original);
  expect(f.commands.filter((argv) => argv[0] === 'image' && argv[1] === 'load')).toHaveLength(stage === 'after load' ? 1 : 0);
});
for (const stage of ['before load', 'after load'] as const) test.each(proofFiles)(`caller cancellation ${stage} settles a stalled %s and forbids late adoption`, async (file) => {
  const f = await fixture({ returnedId: manifestId, metadata: manifestMetadata, image: (value) => ({ ...value, Descriptor: manifest }) });
  const entered = barrier(); const release = barrier(); const finished = barrier(); const path = join(f.privateDir, file);
  probe.reading = async (reading) => { if (reading === path && f.events.includes('load-start') === (stage === 'after load')) { entered.release(); await release.waiting; } };
  probe.read = (read) => { if (read === path && f.events.includes('load-start') === (stage === 'after load')) finished.release(); };
  cleanups.unshift(async () => { release.release(); });
  const build = f.docker.build(f.workspace, '.', 'Dockerfile'); const cancelled = failure(130, 'SIGINT', 'execution', 'cancelled proof read', 'retry');
  const rejected = expect(build).rejects.toBe(cancelled);
  await entered.waiting; const original = await readFile(join(f.privateDir, 'docker.json'), 'utf8');
  f.controller.abort(cancelled); await rejected;
  await releaseProof({ release, finished });
  await expectPendingImage(f, original);
  expect(f.commands.filter((argv) => argv[0] === 'image' && argv[1] === 'load')).toHaveLength(stage === 'after load' ? 1 : 0);
});
test('iid and metadata share the original cleanup deadline and parsing cannot extend it', async () => {
  const f = await interruptedImage(); const original = await readFile(join(f.privateDir, 'docker.json'), 'utf8');
  const metadata = await readFile(join(f.privateDir, 'before-build-metadata.json'), 'utf8');
  const deadline = performance.now() + 30_000; const clock = vi.spyOn(performance, 'now');
  probe.read = (path) => { if (path === join(f.privateDir, 'before-image-id')) clock.mockReturnValue(deadline - 1); };
  const parse = JSON.parse;
  vi.spyOn(JSON, 'parse').mockImplementation((text, reviver) => { const value: unknown = parse(text, reviver); if (text === metadata) clock.mockReturnValue(deadline + 1); return value; });
  await expect(f.registered.find((resource) => resource.kind === 'image')!.dispose(deadline)).rejects.toThrow();
  await expectPendingImage(f, original);
});


test.each(proofFiles)('a run cleanup deadline started during a stalled %s shortens the execution wait', async (file) => {
  const f = await fixture(); const stalled = stalledProof(f, file);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const build = f.docker.build(f.workspace, '.', 'Dockerfile'); const rejected = expect(build).rejects.toMatchObject({ detail: { code: 'CLEANUP_TIMEOUT' } });
  await stalled.entered.waiting; const original = await readFile(join(f.privateDir, 'docker.json'), 'utf8');
  const deadline = runCleanupLifetime(f.run).begin(performance.now() + 1000);
  expect(deadline).toBeLessThan(f.run.deadlineMs);
  vi.spyOn(performance, 'now').mockReturnValue(deadline + 1);
  await vi.advanceTimersByTimeAsync(1001); await rejected;
  await releaseProof(stalled);
  await expectPendingImage(f, original);
  expect(f.commands.some((argv) => argv[0] === 'image' && argv[1] === 'load')).toBe(false);
});
