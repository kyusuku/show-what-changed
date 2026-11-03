import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { assertNoDockerResidue, DockerResidueError } from '../../scripts/verify-docker-residue.mjs';

const runId = '20261103T010203004Z-0123456789abcdef';

function named(kind, side = 'before', id = 'a'.repeat(64)) {
  const nonce = { container: 'a', network: 'b', image: 'c' }[kind].repeat(32);
  return {
    kind, side, name: `swc-${side}-${nonce}${kind === 'image' ? ':app' : ''}`, id,
    labels: { 'io.show-what-changed.run': runId, 'io.show-what-changed.side': side, 'io.show-what-changed.nonce': nonce },
  };
}

function builder(containerId = 'd'.repeat(64)) {
  const nonce = 'd'.repeat(24);
  const node = `swc-after-${nonce}`;
  const containerName = `buildx_buildkit_${node}`;
  return { kind: 'builder', side: 'after', name: `swc-builder-${nonce}`, node, containerName, volumeName: `${containerName}_state`, containerId, volumeCreatedAt: null };
}

async function fixture(run, handler = (_request, response) => { response.writeHead(404); response.end('{}'); }) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'swc-dr-'));
  const privateDir = join(root, 'private');
  const path = join(privateDir, 'docker.json');
  const socket = join(root, 'api');
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ method: request.method, path: request.url });
    handler(request, response);
  });
  const ledger = { schemaVersion: 2, runId, endpoint: `unix://${socket}`, configRelative: 'docker-client', pendingCreates: [], resources: [] };
  const save = async (value = ledger) => writeFile(path, JSON.stringify(value));
  try {
    await mkdir(privateDir);
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
    await run({ root, privateDir, path, socket, ledger, save, requests });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
}

test('missing and validated empty ledgers pass without contacting Docker', async () => {
  await fixture(async ({ root, save, requests }) => {
    expect(await assertNoDockerResidue(root, runId)).toEqual({ checkedResources: 0 });
    await save();
    expect(await assertNoDockerResidue(root, runId)).toEqual({ checkedResources: 0 });
    expect(requests).toEqual([]);
  });
});

test('every recorded resource and both builder identities require exact GET 404 results without changing the ledger', async () => {
  await fixture(async ({ root, path, ledger, save, requests }) => {
    const container = named('container');
    const network = named('network', 'after', 'b'.repeat(64));
    const image = named('image', 'before', `sha256:${'c'.repeat(64)}`);
    const build = builder();
    ledger.resources = [container, network, image, build];
    await save();
    const before = await readFile(path);
    const entries = await readdir(join(root, 'private'));
    expect(await assertNoDockerResidue(root, runId)).toEqual({ checkedResources: 5 });
    expect(requests).toEqual([
      { method: 'GET', path: `/containers/${container.id}/json` },
      { method: 'GET', path: `/networks/${network.id}` },
      { method: 'GET', path: `/images/${encodeURIComponent(image.id)}/json` },
      { method: 'GET', path: `/containers/${build.containerId}/json` },
      { method: 'GET', path: `/volumes/${build.volumeName}` },
    ]);
    expect(await readFile(path)).toEqual(before);
    expect(await readdir(join(root, 'private'))).toEqual(entries);
  });
});

test('unobserved IDs use only the exact registered names and encode each path component', async () => {
  await fixture(async ({ root, ledger, save, requests }) => {
    const image = named('image', 'after', null);
    const build = builder(null);
    ledger.resources = [image, build];
    await save();
    expect(await assertNoDockerResidue(root, runId)).toEqual({ checkedResources: 3 });
    expect(requests.map((entry) => entry.path)).toEqual([
      `/images/${encodeURIComponent(image.name)}/json`, `/containers/${build.containerName}/json`, `/volumes/${build.volumeName}`,
    ]);
  });
});

test('an existing named resource fails even when the daemon returns private response text', async () => {
  await fixture(async ({ root, ledger, save, requests }) => {
    ledger.resources = [named('container')];
    await save();
    const error = await assertNoDockerResidue(root, runId).catch((failure) => failure);
    expect(error).toBeInstanceOf(DockerResidueError);
    expect(error.code).toBe('DOCKER_RESIDUE_FOUND');
    expect(error.message).toBe('DOCKER_RESIDUE_FOUND');
    expect(JSON.stringify(error)).not.toContain(root);
    expect(JSON.stringify(error)).not.toContain('private-response-canary');
    expect(requests).toHaveLength(1);
  }, (_request, response) => { response.writeHead(200); response.end('private-response-canary'); });
});

test('a builder volume left behind fails after its container is confirmed absent', async () => {
  await fixture(async ({ root, ledger, save, requests }) => {
    const build = builder();
    ledger.resources = [build];
    await save();
    await expect(assertNoDockerResidue(root, runId)).rejects.toMatchObject({ code: 'DOCKER_RESIDUE_FOUND' });
    expect(requests).toEqual([
      { method: 'GET', path: `/containers/${build.containerId}/json` },
      { method: 'GET', path: `/volumes/${build.volumeName}` },
    ]);
  }, (request, response) => { response.writeHead(request.url.startsWith('/volumes/') ? 200 : 404); response.end('{}'); });
});

test('pending creation intent fails before any absence query can hide it', async () => {
  await fixture(async ({ root, ledger, save, requests }) => {
    ledger.resources = [named('network', 'before', null)];
    ledger.pendingCreates = [ledger.resources[0].name];
    await save();
    await expect(assertNoDockerResidue(root, runId)).rejects.toMatchObject({ code: 'DOCKER_CREATION_UNCERTAIN' });
    expect(requests).toEqual([]);
  });
});

test('unavailable daemon and unexpected status fail closed', async () => {
  await fixture(async ({ root, ledger, socket, save, requests }) => {
    ledger.resources = [named('container')];
    ledger.endpoint = `unix://${socket}-missing`;
    await save();
    await expect(assertNoDockerResidue(root, runId)).rejects.toMatchObject({ code: 'DOCKER_DAEMON_UNAVAILABLE' });
    ledger.endpoint = `unix://${socket}`;
    await save();
    await expect(assertNoDockerResidue(root, runId)).rejects.toMatchObject({ code: 'DOCKER_INSPECTION_FAILED' });
    expect(requests).toHaveLength(1);
  }, (_request, response) => { response.writeHead(503); response.end('{}'); });
});

test('a daemon that sends no headers reaches the request deadline', async () => {
  await fixture(async ({ root, ledger, save }) => {
    ledger.resources = [named('container')];
    await save();
    await expect(assertNoDockerResidue(root, runId)).rejects.toMatchObject({ code: 'DOCKER_INSPECTION_TIMEOUT' });
  }, () => {});
});

test('an unfinished 404 body reaches the same request deadline', async () => {
  await fixture(async ({ root, ledger, save }) => {
    ledger.resources = [named('container')];
    await save();
    await expect(assertNoDockerResidue(root, runId)).rejects.toMatchObject({ code: 'DOCKER_INSPECTION_TIMEOUT' });
  }, (_request, response) => { response.writeHead(404); response.write('{'); });
});

test('an oversized or truncated 404 body cannot establish absence', async () => {
  let oversized = true;
  await fixture(async ({ root, ledger, save }) => {
    ledger.resources = [named('container')];
    await save();
    await expect(assertNoDockerResidue(root, runId)).rejects.toMatchObject({ code: 'DOCKER_RESPONSE_TOO_LARGE' });
    oversized = false;
    await expect(assertNoDockerResidue(root, runId)).rejects.toMatchObject({ code: 'DOCKER_RESPONSE_INCOMPLETE' });
  }, (_request, response) => {
    if (oversized) { response.writeHead(404); response.end('x'.repeat(64 * 1024 + 1)); }
    else { response.writeHead(404, { 'Content-Length': '100' }); response.end('{}'); }
  });
});

test('invalid schema, run identities, and resource ownership fail before any query', async () => {
  await fixture(async ({ root, ledger, save, requests }) => {
    const resource = named('network');
    const cases = [
      [null, 'DOCKER_LEDGER_INVALID'],
      [{ ...ledger, schemaVersion: 1 }, 'DOCKER_LEDGER_INVALID'],
      [{ ...ledger, runId: '20261103T010203004Z-ffffffffffffffff' }, 'DOCKER_LEDGER_IDENTITY_MISMATCH'],
      [{ ...ledger, extra: true }, 'DOCKER_LEDGER_INVALID'],
      [{ ...ledger, resources: [resource, resource] }, 'DOCKER_LEDGER_INVALID'],
      [{ ...ledger, resources: [{ ...resource, id: '../other-resource' }] }, 'DOCKER_LEDGER_INVALID'],
      [{ ...ledger, pendingCreates: ['unregistered'] }, 'DOCKER_LEDGER_INVALID'],
      [{ ...ledger, resources: [{ ...resource, name: 'swc-before-unregistered' }] }, 'DOCKER_LEDGER_IDENTITY_MISMATCH'],
      [{ ...ledger, resources: [{ ...resource, labels: { ...resource.labels, 'io.show-what-changed.run': 'other-run' } }] }, 'DOCKER_LEDGER_IDENTITY_MISMATCH'],
      [{ ...ledger, resources: [{ ...builder(), volumeName: 'buildx_buildkit_swc-other_state' }] }, 'DOCKER_LEDGER_IDENTITY_MISMATCH'],
      [{ ...ledger, endpoint: 'tcp://127.0.0.1:2375' }, 'DOCKER_ENDPOINT_UNSUPPORTED'],
      [{ ...ledger, endpoint: 'unix://remote-host/engine.sock' }, 'DOCKER_ENDPOINT_UNSUPPORTED'],
      [{ ...ledger, endpoint: 'unix:relative' }, 'DOCKER_ENDPOINT_UNSUPPORTED'],
      [{ ...ledger, endpoint: 'unix:///engine.sock?remote=true' }, 'DOCKER_ENDPOINT_UNSUPPORTED'],
      [{ ...ledger, endpoint: 'unix:///engine%00.sock' }, 'DOCKER_ENDPOINT_UNSUPPORTED'],
    ];
    for (const [value, code] of cases) {
      await save(value);
      await expect(assertNoDockerResidue(root, runId)).rejects.toMatchObject({ code });
    }
    expect(requests).toEqual([]);
  });
});

test('malformed, oversized, nonregular, and linked ledgers fail without modification', async () => {
  await fixture(async ({ root, privateDir, path, ledger, save, requests }) => {
    await writeFile(path, '{');
    await expect(assertNoDockerResidue(root, runId)).rejects.toMatchObject({ code: 'DOCKER_LEDGER_INVALID' });
    await writeFile(path, ' '.repeat(1024 * 1024 + 1));
    await expect(assertNoDockerResidue(root, runId)).rejects.toMatchObject({ code: 'DOCKER_LEDGER_UNREADABLE' });
    await rm(path);
    await mkdir(path);
    await expect(assertNoDockerResidue(root, runId)).rejects.toMatchObject({ code: 'DOCKER_LEDGER_UNREADABLE' });
    await rm(path, { recursive: true });
    const other = join(privateDir, 'other.json');
    await writeFile(other, JSON.stringify(ledger));
    await symlink(other, path);
    await expect(assertNoDockerResidue(root, runId)).rejects.toMatchObject({ code: 'DOCKER_LEDGER_UNREADABLE' });
    expect(await readFile(other, 'utf8')).toBe(JSON.stringify(ledger));
    await rm(path);
    await save();
    const alias = join(root, 'alias');
    await symlink(privateDir, alias);
    await expect(assertNoDockerResidue(alias, runId)).rejects.toMatchObject({ code: 'DOCKER_LEDGER_UNREADABLE' });
    expect(requests).toEqual([]);
  });
});

test('invalid call identities fail with fixed errors and never reveal arguments', async () => {
  await expect(assertNoDockerResidue('private-relative-canary', runId)).rejects.toMatchObject({ code: 'DOCKER_RUN_DIRECTORY_INVALID', message: 'DOCKER_RUN_DIRECTORY_INVALID' });
  await expect(assertNoDockerResidue('/private/path-canary', 'private-id-canary')).rejects.toMatchObject({ code: 'DOCKER_RUN_ID_INVALID', message: 'DOCKER_RUN_ID_INVALID' });
});
