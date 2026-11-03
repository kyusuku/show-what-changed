import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { chmod, lstat, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { DockerRuntime, inspectDockerResidue } from '../../src/runtime/docker.js';
import { atomicPrivateFile, safeDirectory } from '../../src/runtime/files.js';
import { cleanOwnedRun } from '../../src/runtime/ownership.js';
import { systemProbe } from '../../src/runtime/process-table.js';

const disposals: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const dispose of disposals.splice(0)) await dispose(); });
async function fixture(options: { container?: boolean; volume?: boolean; definition?: boolean; pending?: boolean; confirmed?: boolean; version?: number } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'swc-builder-recovery-')));
  const runId = '20261102T000000000Z-aaaaaaaaaaaaaaaa'; const privateDir = join(root, 'private'); await safeDirectory(privateDir, true);
  const node = `swc-before-${'d'.repeat(24)}`; const name = `swc-builder-${'d'.repeat(24)}`; const containerName = `buildx_buildkit_${node}`; const volumeName = `${containerName}_state`;
  const id = 'a'.repeat(64); const created = '2026-11-02T00:00:00Z';
  const container = { Id: id, Name: `/${containerName}`, Image: `sha256:${'b'.repeat(64)}`, Config: { Image: 'moby/buildkit:buildx-stable-1', Labels: {} }, State: { Running: true, ExitCode: 0 }, HostConfig: { NetworkMode: 'bridge', Privileged: false, PortBindings: null, LogConfig: { Type: 'none', Config: {} } }, NetworkSettings: { Networks: {}, Ports: null }, Mounts: [{ Type: 'volume', Name: volumeName, Destination: '/var/lib/buildkit' }] };
  const volume = { Name: volumeName, Driver: 'local', CreatedAt: created };
  const state = { container: options.container === false ? null : container, volume: options.volume === false ? null : volume, references: [] as { Id: string; Mounts: { Type: string; Name: string }[] }[] };
  const calls: string[] = []; const deletes: string[] = []; let intercept: ((request: IncomingMessage, response: ServerResponse) => boolean) | undefined;
  const server = createServer((request, response) => {
    const path = request.url ?? ''; calls.push(`${request.method} ${path}`);
    if (intercept?.(request, response)) return;
    const result = (status: number, value: unknown) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(status === 204 ? undefined : JSON.stringify(value)); };
    if (request.method === 'GET') {
      if (path.startsWith('/containers/json?')) { result(200, state.references); return; }
      if ([`/containers/${containerName}/json`, `/containers/${id}/json`].includes(path) && state.container && (path.includes(containerName) || state.container.Id === id)) { result(200, state.container); return; }
      if (path === `/volumes/${volumeName}` && state.volume) { result(200, state.volume); return; }
      result(404, { message: 'absent' }); return;
    }
    if (request.method === 'DELETE') {
      deletes.push(path);
      if (path === `/containers/${id}?force=1&v=0` && state.container?.Id === id) { state.container = null; result(204, null); return; }
      if (path === `/volumes/${volumeName}?force=0` && state.volume) { state.volume = null; result(204, null); return; }
    }
    result(500, { message: 'unexpected request' });
  });
  const socket = join(root, 'daemon.sock'); await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
  disposals.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
  const resource = { kind: 'builder' as const, side: 'before' as const, name, node, containerName, volumeName, containerId: options.confirmed === false ? null : id as string | null, volumeCreatedAt: options.confirmed === false ? null : created as string | null };
  const ledger = { schemaVersion: options.version ?? 2, runId, endpoint: `unix://${socket}`, configRelative: 'docker-client', ...(options.version === 1 ? {} : { pendingCreates: options.pending ? [name] : [] }), resources: [resource] };
  const persist = () => atomicPrivateFile(privateDir, 'docker.json', JSON.stringify(ledger), true); await persist();
  const definitionPath = join(privateDir, 'docker-client', 'buildx', 'instances', name);
  const definition = { Name: name, Driver: 'docker-container', Nodes: [{ Name: node, Endpoint: ledger.endpoint }], Dynamic: false };
  if (options.definition) await atomicPrivateFile(privateDir, `docker-client/buildx/instances/${name}`, JSON.stringify(definition), false);
  const recover = (cleanup = true) => DockerRuntime.recover(root, runId, cleanup);
  return { root, privateDir, runId, ledger, resource, persist, state, container, volume, calls, deletes, definition, definitionPath, recover, intercept: (handler: typeof intercept) => { intercept = handler; } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function fakeCli(f: Fixture, behavior = 'remove') {
  await atomicPrivateFile(f.root, 'behavior', behavior, true);
  await atomicPrivateFile(f.root, 'docker', `#!${process.execPath}
const fs = require('node:fs'); const path = require('node:path'); const args = process.argv.slice(2); const root = __dirname;
fs.appendFileSync(path.join(root, 'cli.jsonl'), JSON.stringify({args, dockerConfig: process.env.DOCKER_CONFIG, buildxConfig: process.env.BUILDX_CONFIG})+'\\n');
const config = args[1]; const command = args.slice(4); const behavior = fs.readFileSync(path.join(root,'behavior'),'utf8');
if (command[0] === 'buildx') {
  if (JSON.stringify(command.slice(0,4)) !== JSON.stringify(['buildx','rm','--force','--keep-daemon'])) process.exit(7);
  if (behavior === 'fail') process.exit(1);
  if (behavior === 'hang') setInterval(() => {}, 1000);
  else { fs.unlinkSync(path.join(config,'buildx','instances',command[4])); process.exit(behavior === 'lost' ? 1 : 0); }
}
if (behavior === command[0]) process.stdout.write('synthetic-residue\\n');
`, true);
  await chmod(join(f.root, 'docker'), 0o700); vi.stubEnv('PATH', `${f.root}:${process.env.PATH ?? ''}`);
  vi.stubEnv('DOCKER_CONFIG', join(f.root, 'foreign-client')); vi.stubEnv('BUILDX_CONFIG', join(f.root, 'foreign-buildx'));
}
async function cliCalls(f: Fixture): Promise<{ args: string[]; dockerConfig?: string; buildxConfig?: string }[]> { return (await readFile(join(f.root, 'cli.jsonl'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map((line) => JSON.parse(line)); }

test.each([[true, true], [true, false], [false, true], [false, false]])('confirmed container=%s volume=%s converges with exact deletion and repeat absence', async (container, volume) => {
  const f = await fixture({ container, volume });
  expect(await f.recover(false)).toBe(container || volume); expect(f.deletes).toEqual([]);
  expect(await f.recover()).toBe(container || volume);
  expect(f.deletes).toEqual([...(container ? [`/containers/${f.resource.containerId}?force=1&v=0`] : []), ...(volume ? [`/volumes/${f.resource.volumeName}?force=0`] : [])]);
  expect(await f.recover()).toBe(false); expect(f.state).toMatchObject({ container: null, volume: null });
  expect(JSON.parse(await readFile(join(f.privateDir, 'docker.json'), 'utf8')).resources[0]).toEqual(f.resource);
});
test.each([[false, false], [false, true], [true, false]])('pending incomplete pair container=%s volume=%s retains intent and definition', async (container, volume) => {
  const f = await fixture({ container, volume, pending: true, confirmed: false, definition: true });
  await expect(f.recover()).rejects.toMatchObject({ detail: { code: 'DOCKER_CREATION_UNCERTAIN' } });
  expect(f.deletes).toEqual([]); expect(await lstat(f.definitionPath)).toBeDefined();
  expect(JSON.parse(await readFile(join(f.privateDir, 'docker.json'), 'utf8')).pendingCreates).toEqual([f.resource.name]);
});
test('a full pending pair is persisted before its first deletion and read-only inspection does not confirm it', async () => {
  const f = await fixture({ pending: true, confirmed: false }); const before = await readFile(join(f.privateDir, 'docker.json'), 'utf8');
  expect(await f.recover(false)).toBe(true); expect(await readFile(join(f.privateDir, 'docker.json'), 'utf8')).toBe(before);
  let recorded: Promise<string> | undefined;
  f.intercept((request) => { if (request.method === 'DELETE' && !recorded) recorded = readFile(join(f.privateDir, 'docker.json'), 'utf8'); return false; });
  expect(await f.recover()).toBe(true); expect(recorded).toBeDefined();
  expect(JSON.parse(await recorded!)).toMatchObject({ pendingCreates: [], resources: [{ containerId: f.container.Id, volumeCreatedAt: f.volume.CreatedAt }] });
});
test.each([1, 2])('ledger version %s rejects either incomplete recorded identity before mutation', async (version) => {
  for (const field of ['containerId', 'volumeCreatedAt'] as const) { const f = await fixture({ version }); f.resource[field] = null; await f.persist(); await expect(f.recover()).rejects.toMatchObject({ detail: { code: 'BUILDER_OWNERSHIP_UNCERTAIN' } }); expect(f.deletes).toEqual([]); }
});
test.each(['container', 'volume', 'definition'] as const)('never-issued registration cannot adopt a matching %s', async (present) => {
  const f = await fixture({ confirmed: false, container: present === 'container', volume: present === 'volume', definition: present === 'definition' });
  await expect(f.recover()).rejects.toMatchObject({ detail: { code: 'BUILDER_OWNERSHIP_UNCERTAIN' } }); expect(f.deletes).toEqual([]);
});
test('never-issued registration with no resources is already clean', async () => { expect(await (await fixture({ confirmed: false, container: false, volume: false })).recover()).toBe(false); });
test.each(['container-id', 'container-name', 'mount', 'image', 'volume-name', 'volume-driver', 'volume-time', 'empty-time'])('preserves resources with changed %s', async (invalid) => {
  const f = await fixture();
  if (invalid === 'container-id') f.container.Id = 'e'.repeat(64);
  if (invalid === 'container-name') f.container.Name = '/renamed';
  if (invalid === 'mount') f.container.Mounts[0]!.Name = 'other';
  if (invalid === 'image') f.container.Config.Image = 'other/buildkit:latest';
  if (invalid === 'volume-name') f.volume.Name = 'other';
  if (invalid === 'volume-driver') f.volume.Driver = 'nfs';
  if (invalid === 'volume-time') f.volume.CreatedAt = '2027-01-01T00:00:00Z';
  if (invalid === 'empty-time') f.resource.volumeCreatedAt = ''; await f.persist();
  await expect(f.recover()).rejects.toMatchObject({ detail: { code: 'BUILDER_OWNERSHIP_UNCERTAIN' } }); expect(f.deletes).toEqual([]);
});
test.each(['container', 'volume'] as const)('rejects a %s replacement observed after initial inspection', async (member) => {
  const f = await fixture({ container: member === 'container' }); let inspections = 0;
  f.intercept((request) => { if (request.method === 'GET' && request.url === `/volumes/${f.resource.volumeName}` && ++inspections === 2) { if (member === 'volume') f.volume.CreatedAt = 'replacement'; else f.container.Id = 'e'.repeat(64); } return false; });
  await expect(f.recover()).rejects.toMatchObject({ detail: { code: 'BUILDER_OWNERSHIP_UNCERTAIN' } }); expect(f.deletes).toEqual([]);
});
test.each(['container', 'volume'] as const)('recovers a lost %s DELETE response after Engine applied it', async (member) => {
  const f = await fixture(); let lost = false;
  f.intercept((request, response) => { if (!lost && request.method === 'DELETE' && request.url?.startsWith(`/${member}s/`)) { lost = true; f.state[member] = null; response.destroy(); return true; } return false; });
  expect(await f.recover()).toBe(true); expect(lost).toBe(true); expect(await f.recover()).toBe(false);
  expect(f.calls.filter((call) => call.startsWith(`DELETE /${member}s/`))).toHaveLength(1);
});
test.each(['container', 'volume'] as const)('retries a lost %s DELETE once only after revalidation', async (member) => {
  const f = await fixture(); let lost = false;
  f.intercept((request, response) => { if (!lost && request.method === 'DELETE' && request.url?.startsWith(`/${member}s/`)) { lost = true; response.destroy(); return true; } return false; });
  expect(await f.recover()).toBe(true); expect(f.calls.filter((call) => call.startsWith(`DELETE /${member}s/`))).toHaveLength(2);
});
test('two lost responses leave the same volume and preserve cleanup state for a later call', async () => {
  const f = await fixture({ container: false });
  f.intercept((request, response) => { if (request.method === 'DELETE') { response.destroy(); return true; } return false; });
  await expect(f.recover()).rejects.toMatchObject({ detail: { code: 'DOCKER_FAILED' } });
  expect(f.calls.filter((call) => call.startsWith('DELETE '))).toHaveLength(2); expect(f.state.volume).not.toBeNull();
  f.intercept(undefined); expect(await f.recover()).toBe(true);
});
test('interruption after container removal resumes with only the confirmed volume', async () => {
  const f = await fixture();
  f.intercept((request, response) => { if (request.method === 'DELETE' && request.url?.startsWith('/volumes/')) { response.writeHead(500); response.end('{}'); return true; } return false; });
  await expect(f.recover()).rejects.toMatchObject({ detail: { code: 'BUILDER_CLEANUP_FAILED' } }); expect(f.state.container).toBeNull(); expect(f.state.volume).not.toBeNull();
  f.intercept(undefined); expect(await f.recover()).toBe(true); expect(await f.recover()).toBe(false);
});
test('a foreign container reference blocks builder deletion and is never removed', async () => {
  const f = await fixture(); f.state.references = [{ Id: 'f'.repeat(64), Mounts: [{ Type: 'volume', Name: f.resource.volumeName }] }];
  await expect(f.recover()).rejects.toMatchObject({ detail: { code: 'BUILDER_VOLUME_IN_USE' } }); expect(f.deletes).toEqual([]);
});
test('Engine in-use refusal after the reference check preserves the volume without force or retry', async () => {
  const f = await fixture({ container: false });
  f.intercept((request, response) => { if (request.method === 'DELETE') { response.writeHead(409); response.end('{"message":"in use"}'); return true; } return false; });
  await expect(f.recover()).rejects.toMatchObject({ detail: { code: 'BUILDER_CLEANUP_FAILED' } }); expect(f.state.volume).not.toBeNull();
  expect(f.calls.filter((call) => call.startsWith('DELETE '))).toEqual([`DELETE /volumes/${f.resource.volumeName}?force=0`]);
});
test.each(['500', 'malformed', 'truncated'])('an uncertain %s inspection never becomes absence', async (kind) => {
  const f = await fixture({ container: false });
  f.intercept((request, response) => { if (request.url?.startsWith('/volumes/')) { if (kind === 'truncated') { response.writeHead(200, { 'Content-Length': 1000 }); response.write('{'); response.destroy(); } else { response.writeHead(kind === '500' ? 500 : 200); response.end(kind === 'malformed' ? '{}' : '{"message":"unavailable"}'); } return true; } return false; });
  await expect(f.recover()).rejects.toThrow(); expect(f.deletes).toEqual([]);
});
test('deadline exhaustion between inspection and deletion issues no mutation', async () => {
  const f = await fixture({ container: false }); let offset = 0; const now = performance.now.bind(performance); vi.spyOn(performance, 'now').mockImplementation(() => now() + offset);
  f.intercept((request) => { if (request.url?.startsWith('/containers/json?')) offset = 40_000; return false; });
  await expect(f.recover()).rejects.toMatchObject({ detail: { code: 'DOCKER_DEADLINE_EXCEEDED' } }); expect(f.deletes).toEqual([]);
});
test.each([[true, true], [true, false], [false, true], [false, false]])('private metadata cleanup follows container=%s volume=%s absence and repeats safely', async (container, volume) => {
  const f = await fixture({ container, volume, definition: true }); await fakeCli(f);
  const sentinel = join(f.privateDir, 'docker-client', 'buildx', 'instances', 'unrelated'); await writeFile(sentinel, 'preserve');
  expect(await f.recover()).toBe(true); expect(f.state).toMatchObject({ container: null, volume: null });
  expect(await readFile(sentinel, 'utf8')).toBe('preserve'); await expect(lstat(f.definitionPath)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await cliCalls(f)).toEqual([{ args: ['--config', join(f.privateDir, 'docker-client'), '--host', f.ledger.endpoint, 'buildx', 'rm', '--force', '--keep-daemon', f.resource.name] }]);
  expect(await f.recover()).toBe(false); expect(await cliCalls(f)).toHaveLength(1);
}, 10_000);
test.each(['name', 'driver', 'node', 'endpoint', 'multiple-nodes', 'json', 'symlink'])('an invalid private definition %s prevents Engine deletion', async (invalid) => {
  const f = await fixture({ definition: true });
  if (invalid === 'name') f.definition.Name = 'other'; if (invalid === 'driver') f.definition.Driver = 'remote';
  if (invalid === 'node') f.definition.Nodes[0]!.Name = 'other'; if (invalid === 'endpoint') f.definition.Nodes[0]!.Endpoint = 'unix:///other.sock';
  if (invalid === 'multiple-nodes') f.definition.Nodes.push({ ...f.definition.Nodes[0]! });
  await writeFile(f.definitionPath, invalid === 'json' ? '{' : JSON.stringify(f.definition));
  if (invalid === 'symlink') { await rm(f.definitionPath); await symlink(join(f.privateDir, 'docker.json'), f.definitionPath); }
  await expect(f.recover()).rejects.toThrow(); expect(f.deletes).toEqual([]);
});
test.each(['fail', 'lost', 'hang'])('metadata command %s is settled by its contained file postcondition', async (behavior) => {
  const f = await fixture({ container: false, volume: false, definition: true }); await fakeCli(f, behavior);
  if (behavior !== 'lost') { await expect(f.recover()).rejects.toThrow(); expect(await lstat(f.definitionPath)).toBeDefined(); }
  else expect(await f.recover()).toBe(true);
  expect(f.deletes).toEqual([]);
}, 10_000);
test('an expired cleanup deadline does not spawn the metadata command', async () => {
  const f = await fixture({ container: false, volume: false, definition: true }); await fakeCli(f); let offset = 0; let volumes = 0;
  const now = performance.now.bind(performance); vi.spyOn(performance, 'now').mockImplementation(() => now() + offset);
  f.intercept((request) => { if (request.url?.startsWith('/volumes/') && ++volumes === 4) offset = 40_000; return false; });
  await expect(f.recover()).rejects.toMatchObject({ detail: { code: 'DOCKER_DEADLINE_EXCEEDED' } }); expect(await cliCalls(f)).toEqual([]); expect(await lstat(f.definitionPath)).toBeDefined();
});
test.each(['volume', 'definition', 'absent'])('doctor reports %s residue without removing or confirming anything', async (kind) => {
  const f = await fixture({ container: false, volume: kind === 'volume', definition: kind === 'definition' }); await fakeCli(f, kind);
  const ledger = await readFile(join(f.privateDir, 'docker.json'), 'utf8');
  expect(await inspectDockerResidue(f.root, f.runId)).toBe(kind !== 'absent'); expect(f.deletes).toEqual([]);
  expect(await readFile(join(f.privateDir, 'docker.json'), 'utf8')).toBe(ledger); expect((await cliCalls(f)).every((call) => call.args.includes('ls'))).toBe(true);
});
test('uncertain builder cleanup retains the owned run and repository lock', async () => {
  const f = await fixture({ pending: true, confirmed: false, container: false });
  const repo = join(f.root, 'repo'); const runDir = join(repo, '.show-what-changed', 'runs', f.runId); await safeDirectory(join(runDir, 'private'), true);
  await atomicPrivateFile(runDir, 'private/docker.json', JSON.stringify(f.ledger), false);
  await atomicPrivateFile(runDir, '.owner.json', JSON.stringify({ schemaVersion: 1, tool: 'show-what-changed', runId: f.runId, repoRoot: repo, runDir, tempDir: join(runDir, 'private', 'workspaces'), owner: { pid: 99999999, parent: 0, group: 99999999, started: 'absent synthetic owner' }, nonce: 'd'.repeat(32), state: 'active' }), false);
  await expect(cleanOwnedRun(repo, f.runId)).rejects.toMatchObject({ detail: { code: 'DOCKER_CREATION_UNCERTAIN' } });
  expect((await lstat(join(repo, '.show-what-changed', 'run.lock'))).isDirectory()).toBe(true); expect(await lstat(runDir)).toBeDefined(); expect(f.deletes).toEqual([]);
}, 10_000);

test.skipIf(process.env.SWC_BUILDX_METADATA_TESTS !== '1').each(['absent', 'running', 'stopped'])('installed Buildx keep-daemon preserves %s Engine resources while removing its private definition', async (presence) => {
  const f = await fixture({ container: false, volume: false, definition: true });
  const pluginDirectories = (process.env.SWC_BUILDX_PLUGIN_DIRS ?? '/Applications/Docker.app/Contents/Resources/cli-plugins').split(':');
  await atomicPrivateFile(f.privateDir, 'docker-client/config.json', JSON.stringify({ cliPluginsExtraDirs: pluginDirectories }), false);
  const sentinel = join(f.privateDir, 'docker-client', 'buildx', 'instances', 'unrelated'); await writeFile(sentinel, JSON.stringify({ ...f.definition, Name: 'unrelated' }));
  f.intercept((request, response) => {
    if (request.url?.endsWith('/_ping')) { response.setHeader('API-Version', '1.54'); response.end('OK'); return true; }
    if (request.method === 'GET' && request.url?.endsWith(`/containers/${f.resource.containerName}/json`) && presence !== 'absent') { response.end(JSON.stringify({ ...f.container, State: { Running: presence === 'running', ExitCode: 0 } })); return true; }
    return false;
  });
  const prefix = ['docker', '--config', join(f.privateDir, 'docker-client'), '--host', f.ledger.endpoint];
  const version = await systemProbe([...prefix, 'buildx', 'version'], 5000); expect(version.code).toBe(0);
  const result = await systemProbe([...prefix, 'buildx', 'rm', '--force', '--keep-daemon', f.resource.name], 5000);
  expect(result.code, result.stderr).toBe(0); expect(f.calls.every((call) => call.startsWith('GET ') || call.startsWith('HEAD ')), JSON.stringify(f.calls)).toBe(true);
  await expect(lstat(f.definitionPath)).rejects.toMatchObject({ code: 'ENOENT' }); expect(await lstat(sentinel)).toBeDefined();
  process.stdout.write(`Verified ${presence} metadata-only Buildx ${version.stdout.trim()} requests=${JSON.stringify(f.calls)}\n`);
}, 10_000);


test.each([[false, false], [false, true], [true, false]])('a pending intent still blocks a confirmed incomplete pair container=%s volume=%s', async (container, volume) => {
  const f = await fixture({ container, volume, pending: true });
  await expect(f.recover()).rejects.toMatchObject({ detail: { code: 'DOCKER_CREATION_UNCERTAIN' } }); expect(f.deletes).toEqual([]);
});
test('legacy unconfirmed absence remains pending rather than becoming safe absence', async () => {
  const f = await fixture({ version: 1, container: false, volume: false, confirmed: false });
  await expect(f.recover()).rejects.toMatchObject({ detail: { code: 'DOCKER_CREATION_UNCERTAIN' } }); expect(f.deletes).toEqual([]);
});
test('a replacement container arriving at DELETE is preserved and prevents clean success', async () => {
  const f = await fixture({ volume: false });
  f.intercept((request, response) => { if (request.method === 'DELETE') { f.container.Id = 'f'.repeat(64); response.writeHead(404); response.end('{}'); return true; } return false; });
  await expect(f.recover()).rejects.toMatchObject({ detail: { code: 'BUILDER_OWNERSHIP_UNCERTAIN' } });
  expect(f.calls.filter((call) => call.startsWith('DELETE '))).toEqual([`DELETE /containers/${f.resource.containerId}?force=1&v=0`]); expect(f.state.container?.Id).toBe('f'.repeat(64));
});
test('a replacement volume after a lost deletion response cannot authorize a retry', async () => {
  const f = await fixture({ container: false });
  f.intercept((request, response) => { if (request.method === 'DELETE') { f.volume.CreatedAt = 'replacement'; response.destroy(); return true; } return false; });
  await expect(f.recover()).rejects.toMatchObject({ detail: { code: 'BUILDER_OWNERSHIP_UNCERTAIN' } });
  expect(f.calls.filter((call) => call.startsWith('DELETE '))).toHaveLength(1); expect(f.state.volume?.CreatedAt).toBe('replacement');
});
test('a builder ownership error does not block another confirmed network cleanup', async () => {
  const f = await fixture(); f.volume.CreatedAt = 'replacement';
  const nonce = 'b'.repeat(32); const name = `swc-before-${nonce}`; const id = 'c'.repeat(64); let present = true;
  const network = { kind: 'network', side: 'before', name, id, labels: { 'io.show-what-changed.run': f.runId, 'io.show-what-changed.side': 'before', 'io.show-what-changed.nonce': nonce } };
  await atomicPrivateFile(f.privateDir, 'docker.json', JSON.stringify({ ...f.ledger, resources: [...f.ledger.resources, network] }), true);
  f.intercept((request, response) => { if (request.url === `/networks/${id}`) { if (request.method === 'DELETE') { present = false; response.writeHead(204); response.end(); } else if (present) response.end(JSON.stringify({ Id: id, Name: name, Labels: network.labels })); else { response.writeHead(404); response.end('{}'); } return true; } return false; });
  await expect(f.recover()).rejects.toMatchObject({ detail: { code: 'BUILDER_OWNERSHIP_UNCERTAIN' } }); expect(present).toBe(false); expect(f.state.container).not.toBeNull(); expect(f.state.volume).not.toBeNull();
});
