import { createServer } from 'node:http';
import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { DockerRuntime } from '../../src/runtime/docker.js';
import { atomicPrivateFile, safeDirectory } from '../../src/runtime/files.js';

test.each([1, 2])('private ledger%s preserves an aborted creation across404 and reconciles later exact observation', async (version) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'swc-intents-')));
  const privateDir = join(root, 'private'); await safeDirectory(privateDir, true);
  const runId = '20261102T000000000Z-aaaaaaaaaaaaaaaa'; const nonce = 'b'.repeat(32); const name = `swc-before-${nonce}`; const id = 'c'.repeat(64);
  const labels = { 'io.show-what-changed.run': runId, 'io.show-what-changed.side': 'before', 'io.show-what-changed.nonce': nonce };
  let created = false; const deleted: string[] = [];
  const server = createServer((request, response) => {
    if (request.method === 'DELETE' && request.url === `/networks/${id}` && created) { deleted.push(id); created = false; response.writeHead(204); response.end(); return; }
    if (request.method === 'GET' && [`/networks/${name}`, `/networks/${id}`].includes(request.url ?? '') && created) { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ Id: id, Name: name, Labels: labels, Containers: {} })); return; }
    response.writeHead(404, { 'content-type': 'application/json' }); response.end(JSON.stringify({ message: 'not present yet' }));
  });
  const socket = join(root, 'daemon.sock'); await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
  await atomicPrivateFile(privateDir, 'docker.json', JSON.stringify({ schemaVersion: version, runId, endpoint: `unix://${socket}`, configRelative: 'docker-client', ...(version === 2 ? { pendingCreates: [name] } : {}), resources: [{ kind: 'network', side: 'before', name, labels, id: null }] }), false);
  try {
    await expect(DockerRuntime.recover(root, runId)).rejects.toMatchObject({ exitCode: 5, detail: { code: 'DOCKER_CREATION_UNCERTAIN' } });
    const retained = JSON.parse(await readFile(join(privateDir, 'docker.json'), 'utf8')); expect(retained.resources[0].id).toBeNull(); if (version === 2) expect(retained.pendingCreates).toEqual([name]); expect(deleted).toEqual([]);
    created = true;
    expect(await DockerRuntime.recover(root, runId)).toBe(true); expect(deleted).toEqual([id]);
    expect(JSON.parse(await readFile(join(privateDir, 'docker.json'), 'utf8')).pendingCreates).toEqual([]);
    expect(await DockerRuntime.recover(root, runId)).toBe(false);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});

test('a pending builder bootstrap retains uncertainty when both exact infrastructure names are absent', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'swc-builder-intent-'))); const privateDir = join(root, 'private'); await safeDirectory(privateDir, true);
  const nonce = 'd'.repeat(24); const name = `swc-builder-${nonce}`; const node = `swc-before-${nonce}`; const runId = '20261102T000000000Z-aaaaaaaaaaaaaaaa';
  const server = createServer((_request, response) => { response.writeHead(404, { 'content-type': 'application/json' }); response.end('{"message":"not present yet"}'); });
  const socket = join(root, 'daemon.sock'); await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
  await atomicPrivateFile(privateDir, 'docker.json', JSON.stringify({ schemaVersion: 2, runId, endpoint: `unix://${socket}`, configRelative: 'docker-client', pendingCreates: [name], resources: [{ kind: 'builder', side: 'before', name, node, containerName: `buildx_buildkit_${node}`, volumeName: `buildx_buildkit_${node}_state`, containerId: null, volumeCreatedAt: null }] }), false);
  try { await expect(DockerRuntime.recover(root, runId)).rejects.toMatchObject({ exitCode: 5, detail: { code: 'DOCKER_CREATION_UNCERTAIN' } }); expect(JSON.parse(await readFile(join(privateDir, 'docker.json'), 'utf8')).pendingCreates).toEqual([name]); }
  finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});

test('one unresolved creation cannot prevent exact removal of another confirmed resource', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'swc-mixed-intent-'))); const privateDir = join(root, 'private'); await safeDirectory(privateDir, true);
  const runId = '20261102T000000000Z-aaaaaaaaaaaaaaaa'; const pendingName = `swc-before-${'e'.repeat(32)}`; const name = `swc-before-${'f'.repeat(32)}`; const id = 'a'.repeat(64); let present = true;
  const labels = { 'io.show-what-changed.run': runId, 'io.show-what-changed.side': 'before', 'io.show-what-changed.nonce': 'f'.repeat(32) };
  const server = createServer((request, response) => { if (request.url === `/networks/${id}` && present) { if (request.method === 'DELETE') { present = false; response.writeHead(204); response.end(); } else response.end(JSON.stringify({ Id: id, Name: name, Labels: labels, Containers: {} })); } else { response.writeHead(404); response.end('{"message":"absent"}'); } });
  const socket = join(root, 'daemon.sock'); await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
  await atomicPrivateFile(privateDir, 'docker.json', JSON.stringify({ schemaVersion: 2, runId, endpoint: `unix://${socket}`, configRelative: 'docker-client', pendingCreates: [pendingName], resources: [{ kind: 'network', side: 'before', name: pendingName, labels: { ...labels, 'io.show-what-changed.nonce': 'e'.repeat(32) }, id: null }, { kind: 'network', side: 'before', name, labels, id }] }), false);
  try { await expect(DockerRuntime.recover(root, runId)).rejects.toMatchObject({ detail: { code: 'DOCKER_CREATION_UNCERTAIN' } }); expect(present).toBe(false); expect(JSON.parse(await readFile(join(privateDir, 'docker.json'), 'utf8')).pendingCreates).toEqual([pendingName]); }
  finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});

test('an unknown image load retains its run lock until exact owned image observation resolves the intent', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'swc-image-intent-'))); const runId = '20261102T000000000Z-aaaaaaaaaaaaaaaa'; const runDir = join(root, '.show-what-changed', 'runs', runId); const privateDir = join(runDir, 'private'); await safeDirectory(privateDir, true);
  const nonce = 'b'.repeat(32); const name = `swc-before-${nonce}:app`; const id = `sha256:${'c'.repeat(64)}`; let present = false; const deleted: string[] = [];
  const labels = { 'io.show-what-changed.run': runId, 'io.show-what-changed.side': 'before', 'io.show-what-changed.nonce': nonce };
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://model'); const target = decodeURIComponent(url.pathname.split('/')[2] ?? '');
    if (request.method === 'GET' && present && [name, id].includes(target)) { response.end(JSON.stringify({ Id: id, RepoTags: [name], Config: { Labels: labels, Volumes: null, WorkingDir: '/app' } })); return; }
    if (request.method === 'DELETE' && present && target === id && url.searchParams.get('force') === '0' && url.searchParams.get('noprune') === '1') { present = false; deleted.push(id); response.end(JSON.stringify([{ Deleted: id }])); return; }
    response.writeHead(404); response.end('{"message":"absent"}');
  });
  const socket = join(root, 'daemon.sock'); await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
  await atomicPrivateFile(runDir, '.owner.json', JSON.stringify({ schemaVersion: 1, tool: 'show-what-changed', runId, repoRoot: root, runDir, tempDir: join(privateDir, 'workspaces'), owner: { pid: 99999999, parent: 0, group: 99999999, started: 'absent synthetic owner' }, nonce: 'd'.repeat(32), state: 'active' }), false);
  await atomicPrivateFile(privateDir, 'docker.json', JSON.stringify({ schemaVersion: 2, runId, endpoint: `unix://${socket}`, configRelative: 'docker-client', pendingCreates: [name], resources: [{ kind: 'image', side: 'before', name, labels, id: null }] }), false);
  try {
    const { cleanOwnedRun } = await import('../../src/runtime/ownership.js');
    await expect(cleanOwnedRun(root, runId)).rejects.toMatchObject({ detail: { code: 'DOCKER_CREATION_UNCERTAIN' } });
    expect((await lstat(join(root, '.show-what-changed', 'run.lock'))).isDirectory()).toBe(true);
    expect(JSON.parse(await readFile(join(privateDir, 'docker.json'), 'utf8')).pendingCreates).toEqual([name]); expect(deleted).toEqual([]);
    present = true; await expect(DockerRuntime.recover(runDir, runId)).rejects.toThrow(); expect(deleted).toEqual([]);
    expect((await lstat(join(root, '.show-what-changed', 'run.lock'))).isDirectory()).toBe(true);
    expect(JSON.parse(await readFile(join(privateDir, 'docker.json'), 'utf8')).pendingCreates).toEqual([name]);
    await writeFile(join(privateDir, 'before-image-id'), id); await writeFile(join(privateDir, 'before-build-metadata.json'), JSON.stringify({ 'containerimage.config.digest': id, 'image.name': name }));
    expect(await DockerRuntime.recover(runDir, runId)).toBe(true); expect(deleted).toEqual([id]);
    expect(JSON.parse(await readFile(join(privateDir, 'docker.json'), 'utf8')).pendingCreates).toEqual([]); expect(await DockerRuntime.recover(runDir, runId)).toBe(false);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
}, 10_000);
