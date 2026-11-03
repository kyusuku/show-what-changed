import { createServer } from 'node:http';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { DockerRuntime } from '../../src/runtime/docker.js';
import { atomicPrivateFile, safeDirectory } from '../../src/runtime/files.js';
async function inspectBuilder(image: string, invalid?: 'container-id' | 'mount' | 'volume-time' | 'driver'): Promise<boolean> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'swc-builder-model-'))); const privateDir = join(root, 'private'); await safeDirectory(privateDir, true);
  const runId = '20261102T000000000Z-aaaaaaaaaaaaaaaa'; const nonce = 'd'.repeat(24); const node = `swc-before-${nonce}`; const name = `swc-builder-${nonce}`; const containerName = `buildx_buildkit_${node}`; const volumeName = `${containerName}_state`;
  const container = { Id: 'a'.repeat(64), Name: `/${containerName}`, Image: `sha256:${'b'.repeat(64)}`, Config: { Image: image, Labels: {} }, State: { Running: true, ExitCode: 0 }, HostConfig: { NetworkMode: 'bridge', Privileged: false, PortBindings: null, LogConfig: { Type: 'none', Config: {} } }, NetworkSettings: { Networks: {}, Ports: null }, Mounts: [{ Type: invalid === 'mount' ? 'bind' : 'volume', Name: volumeName, Destination: '/var/lib/buildkit' }] };
  const volume = { Name: volumeName, Driver: invalid === 'driver' ? 'nfs' : 'local', CreatedAt: '2026-11-02T00:00:00Z' };
  const server = createServer((request, response) => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(request.url?.startsWith('/containers/') ? container : volume)); });
  const socket = join(root, 'daemon.sock'); await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
  await atomicPrivateFile(privateDir, 'docker.json', JSON.stringify({ schemaVersion: 2, runId, endpoint: `unix://${socket}`, configRelative: 'docker-client', pendingCreates: [name], resources: [{ kind: 'builder', side: 'before', name, node, containerName, volumeName, containerId: invalid === 'container-id' ? 'e'.repeat(64) : null, volumeCreatedAt: invalid === 'volume-time' ? '2025-01-01T00:00:00Z' : null }] }), false);
  try { return await DockerRuntime.recover(root, runId, false); }
  finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
}
test.each(['moby/buildkit:buildx-stable-1', `moby/buildkit@sha256:${'c'.repeat(64)}`])('accepts registered builder infrastructure using %s', async (image) => { expect(await inspectBuilder(image)).toBe(true); });
test.each([`other/buildkit@sha256:${'c'.repeat(64)}`, `moby/buildkit@sha256:${'c'.repeat(63)}`, `moby/buildkit@sha256:${'c'.repeat(64)}suffix`])('rejects builder image lookalikes %s', async (image) => { await expect(inspectBuilder(image)).rejects.toMatchObject({ detail: { code: 'BUILDER_OWNERSHIP_UNCERTAIN' } }); });
test.each(['container-id', 'mount', 'volume-time', 'driver'] as const)('keeps %s ownership checks with a valid digest image', async (invalid) => { await expect(inspectBuilder(`moby/buildkit@sha256:${'c'.repeat(64)}`, invalid)).rejects.toMatchObject({ detail: { code: 'BUILDER_OWNERSHIP_UNCERTAIN' } }); });
