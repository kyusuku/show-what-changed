import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { request } from 'node:http';
import { isAbsolute, join, normalize, parse, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';

const MAX_LEDGER_BYTES = 1024 * 1024;
const MAX_BODY_BYTES = 64 * 1024;
const FILE_TIMEOUT_MS = 1000;
const REQUEST_TIMEOUT_MS = 1000;
const TOTAL_TIMEOUT_MS = 5000;
const runIdPattern = /^\d{8}T\d{9}Z-[a-f0-9]{16}$/;
const sideSchema = z.enum(['before', 'after']);
const labelsSchema = z.strictObject({
  'io.show-what-changed.run': z.string().min(1),
  'io.show-what-changed.side': sideSchema,
  'io.show-what-changed.nonce': z.string().regex(/^[a-f0-9]{32}$/),
});
const namedSchema = z.strictObject({
  kind: z.enum(['container', 'network', 'image']), side: sideSchema,
  name: z.string().regex(/^swc-[a-z0-9-]+(?::app)?$/), labels: labelsSchema,
  id: z.string().min(1).max(512).nullable(),
});
const builderSchema = z.strictObject({
  kind: z.literal('builder'), side: sideSchema,
  name: z.string().regex(/^swc-builder-[a-f0-9]{24}$/),
  node: z.string().regex(/^swc-[a-z0-9-]+$/),
  containerName: z.string().regex(/^buildx_buildkit_swc-[a-z0-9-]+$/),
  volumeName: z.string().regex(/^buildx_buildkit_swc-[a-z0-9-]+_state$/),
  containerId: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  volumeCreatedAt: z.string().max(512).nullable(),
});
const ledgerSchema = z.strictObject({
  schemaVersion: z.literal(2), runId: z.string().regex(runIdPattern), endpoint: z.string().max(4096),
  configRelative: z.literal('docker-client'), resources: z.array(z.union([namedSchema, builderSchema])).max(32),
  pendingCreates: z.array(z.string().min(1).max(512)).max(32),
});

export class DockerResidueError extends Error {
  constructor(code) {
    super(code);
    this.name = 'DockerResidueError';
    this.code = code;
  }
}

function fail(code) { throw new DockerResidueError(code); }

async function bounded(operation, timeoutMs, code) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new DockerResidueError(code)), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

async function canonicalDirectory(path) {
  let cursor = parse(path).root;
  for (const part of path.slice(cursor.length).split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    const info = await lstat(cursor);
    if (!info.isDirectory() || info.isSymbolicLink()) fail('DOCKER_LEDGER_UNREADABLE');
  }
  if (await realpath(path) !== path) fail('DOCKER_LEDGER_UNREADABLE');
}

async function readLedger(runDir) {
  await canonicalDirectory(runDir);
  const privateDir = join(runDir, 'private');
  try { await lstat(privateDir); }
  catch (error) { if (error?.code === 'ENOENT') return undefined; throw error; }
  await canonicalDirectory(privateDir);
  const path = join(privateDir, 'docker.json');
  let named;
  try { named = await lstat(path); }
  catch (error) { if (error?.code === 'ENOENT') return undefined; throw error; }
  if (!named.isFile() || named.isSymbolicLink() || named.size > MAX_LEDGER_BYTES) fail('DOCKER_LEDGER_UNREADABLE');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > MAX_LEDGER_BYTES || before.ino !== named.ino || before.dev !== named.dev) fail('DOCKER_LEDGER_UNREADABLE');
    const bytes = Buffer.alloc(before.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const read = await file.read(bytes, size, bytes.length - size, null);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    const after = await file.stat();
    const current = await lstat(path);
    await canonicalDirectory(privateDir);
    if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || current.ino !== before.ino || current.dev !== before.dev || !current.isFile()) fail('DOCKER_LEDGER_UNREADABLE');
    try { return JSON.parse(bytes.subarray(0, size).toString('utf8')); }
    catch { fail('DOCKER_LEDGER_INVALID'); }
  } finally { await file.close(); }
}

function socketPath(endpoint) {
  try {
    const url = new URL(endpoint);
    const path = decodeURIComponent(url.pathname);
    if (!endpoint.startsWith('unix:///') || /[?#]/.test(endpoint) || url.protocol !== 'unix:' || url.host || url.username || url.password || !isAbsolute(path) || path !== normalize(path) || /[\x00-\x1f\x7f]/.test(path)) fail('DOCKER_ENDPOINT_UNSUPPORTED');
    return path;
  } catch { fail('DOCKER_ENDPOINT_UNSUPPORTED'); }
}

function inspectionPaths(ledger, runId) {
  if (ledger.runId !== runId) fail('DOCKER_LEDGER_IDENTITY_MISMATCH');
  if (new Set(ledger.resources.map((resource) => resource.name)).size !== ledger.resources.length || new Set(ledger.pendingCreates).size !== ledger.pendingCreates.length || ledger.pendingCreates.some((name) => !ledger.resources.some((resource) => resource.name === name))) fail('DOCKER_LEDGER_INVALID');
  const paths = [];
  for (const resource of ledger.resources) {
    if (resource.kind === 'builder') {
      if (resource.node !== `swc-${resource.side}-${resource.name.slice('swc-builder-'.length)}` || resource.containerName !== `buildx_buildkit_${resource.node}` || resource.volumeName !== `${resource.containerName}_state`) fail('DOCKER_LEDGER_IDENTITY_MISMATCH');
      paths.push(`/containers/${encodeURIComponent(resource.containerId ?? resource.containerName)}/json`, `/volumes/${encodeURIComponent(resource.volumeName)}`);
    } else {
      if (resource.labels['io.show-what-changed.run'] !== runId || resource.labels['io.show-what-changed.side'] !== resource.side || resource.name !== `swc-${resource.side}-${resource.labels['io.show-what-changed.nonce']}${resource.kind === 'image' ? ':app' : ''}`) fail('DOCKER_LEDGER_IDENTITY_MISMATCH');
      if (resource.id !== null && !(resource.kind === 'image' ? /^sha256:[a-f0-9]{64}$/ : /^[a-f0-9]{64}$/).test(resource.id)) fail('DOCKER_LEDGER_INVALID');
      const target = encodeURIComponent(resource.id ?? resource.name);
      paths.push(resource.kind === 'network' ? `/networks/${target}` : `/${resource.kind}s/${target}/json`);
    }
  }
  if (ledger.pendingCreates.length) fail('DOCKER_CREATION_UNCERTAIN');
  return paths;
}

async function assertAbsent(socket, path, deadline) {
  const remaining = Math.floor(deadline - performance.now());
  if (remaining <= 0) fail('DOCKER_INSPECTION_TIMEOUT');
  return new Promise((resolveRequest, reject) => {
    let settled = false;
    let call;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code) { call?.destroy(); reject(new DockerResidueError(code)); }
      else resolveRequest();
    };
    const timer = setTimeout(() => finish('DOCKER_INSPECTION_TIMEOUT'), Math.min(REQUEST_TIMEOUT_MS, remaining));
    try {
      call = request({ socketPath: socket, method: 'GET', path, agent: false, headers: { Host: 'localhost' } }, (response) => {
        response.on('error', () => finish('DOCKER_RESPONSE_INCOMPLETE'));
        if (response.statusCode === 200) { finish('DOCKER_RESIDUE_FOUND'); return; }
        if (response.statusCode !== 404) { finish('DOCKER_INSPECTION_FAILED'); return; }
        let bytes = 0;
        response.on('data', (chunk) => { bytes += chunk.length; if (bytes > MAX_BODY_BYTES) finish('DOCKER_RESPONSE_TOO_LARGE'); });
        response.on('aborted', () => finish('DOCKER_RESPONSE_INCOMPLETE'));
        response.on('end', () => finish(response.complete ? undefined : 'DOCKER_RESPONSE_INCOMPLETE'));
      });
      call.on('error', () => finish('DOCKER_DAEMON_UNAVAILABLE'));
      call.end();
    } catch { finish('DOCKER_DAEMON_UNAVAILABLE'); }
  });
}

export async function assertNoDockerResidue(runDir, runId) {
  if (typeof runDir !== 'string' || !isAbsolute(runDir) || resolve(runDir) !== runDir) fail('DOCKER_RUN_DIRECTORY_INVALID');
  if (typeof runId !== 'string' || !runIdPattern.test(runId)) fail('DOCKER_RUN_ID_INVALID');
  const deadline = performance.now() + TOTAL_TIMEOUT_MS;
  let value;
  try { value = await bounded(readLedger(runDir), FILE_TIMEOUT_MS, 'DOCKER_LEDGER_TIMEOUT'); }
  catch (error) { if (error instanceof DockerResidueError) throw error; fail('DOCKER_LEDGER_UNREADABLE'); }
  if (value === undefined) return { checkedResources: 0 };
  const parsed = ledgerSchema.safeParse(value);
  if (!parsed.success) fail('DOCKER_LEDGER_INVALID');
  const socket = socketPath(parsed.data.endpoint);
  const paths = inspectionPaths(parsed.data, runId);
  for (const path of paths) await assertAbsent(socket, path, deadline);
  return { checkedResources: paths.length };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length !== 4) {
    console.error('Usage: node scripts/verify-docker-residue.mjs RUN_DIR RUN_ID');
    process.exitCode = 2;
  } else {
    try { console.log(JSON.stringify(await assertNoDockerResidue(process.argv[2], process.argv[3]))); }
    catch (error) { console.error(error instanceof DockerResidueError ? error.code : 'DOCKER_INSPECTION_FAILED'); process.exitCode = 1; }
  }
}
