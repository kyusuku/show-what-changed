import { request } from 'node:http';
import { randomBytes } from 'node:crypto';
import { access, mkdir, realpath } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import { homedir, loadavg } from 'node:os';
import { constants } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import type { ProcessExit, RunContext, Supervisor, Workspace } from '../schema/contracts.js';
import type { Side } from '../schema/index.js';
import { cancellation, checkCancelled, failure } from '../schema/errors.js';
import { sha256 } from '../schema/io.js';
import { atomicPrivateFile, hasCode, readContainedFile, readRunFile, safeDirectory } from './files.js';
import { systemProbe } from './process-table.js';
import { createSupervisor } from './supervisor.js';
import { assertSettledAbsence, creationIssued, creationObserved, DockerCreationIntentsSchema } from './docker-intents.js';
import type { SideInputs } from './recipe.js';
import { DockerImageArchive } from './docker-archive.js';
import { CleanupLifetime, runCleanupLifetime } from './cleanup-lifetime.js';

const OwnershipLabelsSchema = z.strictObject({ 'io.show-what-changed.run': z.string().min(1), 'io.show-what-changed.side': z.enum(['before', 'after']), 'io.show-what-changed.nonce': z.string().regex(/^[a-f0-9]{32}$/) });
const NamedResourceSchema = z.strictObject({ kind: z.enum(['network', 'container', 'image']), side: z.enum(['before', 'after']), name: z.string().regex(/^swc-[a-z0-9-]+(?::app)?$/), labels: OwnershipLabelsSchema, id: z.string().nullable() });
const BuilderSchema = z.strictObject({ kind: z.literal('builder'), side: z.enum(['before', 'after']), name: z.string().regex(/^swc-[a-z0-9-]+$/), node: z.string().regex(/^swc-[a-z0-9-]+$/), containerName: z.string().regex(/^buildx_buildkit_swc-[a-z0-9-]+$/), volumeName: z.string().regex(/^buildx_buildkit_swc-[a-z0-9-]+_state$/), containerId: z.string().nullable(), volumeCreatedAt: z.string().nullable() });
const ResourceSchema = z.union([NamedResourceSchema, BuilderSchema]);
const LedgerFields = { runId: z.string(), endpoint: z.string().regex(/^unix:\/\/\//), configRelative: z.literal('docker-client'), resources: z.array(ResourceSchema).max(32) };
const LegacyLedgerSchema = z.strictObject({ schemaVersion: z.literal(1), ...LedgerFields });
const LedgerSchema = z.strictObject({ schemaVersion: z.literal(2), ...LedgerFields, pendingCreates: DockerCreationIntentsSchema }).refine((ledger) => ledger.pendingCreates.every((name) => ledger.resources.some((resource) => resource.name === name)), 'Every pending creation must identify a registered resource');
type DockerResource = z.infer<typeof ResourceSchema>;
type NamedResource = z.infer<typeof NamedResourceSchema>;
type BuilderResource = z.infer<typeof BuilderSchema>;
type Ledger = z.infer<typeof LedgerSchema>;
function parseDockerLedger(value: unknown): Ledger {
  const parsed = z.union([LedgerSchema, LegacyLedgerSchema]).parse(value);
  if (parsed.schemaVersion === 2) return parsed;
  return { ...parsed, schemaVersion: 2, pendingCreates: parsed.resources.filter((resource) => resource.kind === 'builder' ? resource.containerId === null || resource.volumeCreatedAt === null : resource.id === null).map((resource) => resource.name) };
}
type RequestTrace = { phase: string; startedMonotonicMs: number; operationDeadlineMs: number; runDeadlineMs: number; loadStart: number[]; loadEnd: number[]; method: string; path: string; attempt: number; mode: 'execution' | 'cleanup'; startedAt: string; timeoutMs: number; remainingMs: number; events: { event: string; elapsedMs: number }[]; status: number | null; bytes: number; bodySha256: string | null; bodyComplete: boolean; elapsedMs: number; runAborted: boolean; runAbortCode: string | null; timeoutAborted: boolean; errorName: string | null; errorCode: string | null };

const LabelsSchema = z.record(z.string(), z.string()).nullable();
const ImageSchema = z.object({ Id: z.string().regex(/^sha256:[a-f0-9]{64}$/), RepoDigests: z.array(z.string()).optional(), Config: z.object({ Labels: LabelsSchema.optional(), Volumes: z.record(z.string(), z.unknown()).nullable().optional(), WorkingDir: z.string().optional(), Entrypoint: z.array(z.string()).nullable().optional(), Cmd: z.array(z.string()).nullable().optional() }) });
const ContainerSchema = z.object({ Id: z.string().regex(/^[a-f0-9]{64}$/), Name: z.string(), Image: z.string(), Config: z.object({ Labels: LabelsSchema.optional(), Image: z.string() }), State: z.object({ Running: z.boolean(), ExitCode: z.number().int() }), HostConfig: z.object({ NetworkMode: z.string(), Privileged: z.boolean(), PortBindings: z.record(z.string(), z.array(z.object({ HostIp: z.string(), HostPort: z.string() })).nullable()).nullable(), Tmpfs: z.record(z.string(), z.string()).nullable().optional(), LogConfig: z.object({ Type: z.string(), Config: z.record(z.string(), z.string()).nullable() }) }), NetworkSettings: z.object({ Networks: z.record(z.string(), z.object({ NetworkID: z.string(), Aliases: z.array(z.string()).nullable().optional() })), Ports: z.record(z.string(), z.array(z.object({ HostIp: z.string(), HostPort: z.string() })).nullable()).nullable() }), Mounts: z.array(z.object({ Type: z.string(), Source: z.string().optional(), Destination: z.string(), RW: z.boolean().optional(), Name: z.string().optional() })) });
const NetworkSchema = z.object({ Id: z.string(), Name: z.string(), Labels: LabelsSchema, Containers: z.record(z.string(), z.unknown()).nullable().optional() });
const VolumeSchema = z.object({ Name: z.string(), Driver: z.string(), CreatedAt: z.string(), Labels: LabelsSchema.optional(), Options: z.record(z.string(), z.string()).nullable().optional() });
const BuilderDefinitionSchema = z.object({ Name: z.string(), Driver: z.literal('docker-container'), Nodes: z.array(z.object({ Name: z.string(), Endpoint: z.string() })).length(1) });
type BuilderPresence = { container: z.infer<typeof ContainerSchema> | null; volume: z.infer<typeof VolumeSchema> | null; definition: z.infer<typeof BuilderDefinitionSchema> | null };
function hasBuilderResidue(presence: BuilderPresence): boolean { return Boolean(presence.container || presence.volume || presence.definition); }
function confirmedBuilder(resource: BuilderResource): boolean {
  if (resource.containerId === null && resource.volumeCreatedAt === null) return false;
  if (!resource.containerId || !/^[a-f0-9]{64}$/.test(resource.containerId) || !resource.volumeCreatedAt) dockerError('BUILDER_OWNERSHIP_UNCERTAIN');
  return true;
}
async function builderDefinition(privateDir: string, endpoint: string, resource: BuilderResource): Promise<BuilderPresence['definition']> {
  let bytes: Buffer;
  try { bytes = await readContainedFile(privateDir, `docker-client/buildx/instances/${resource.name}`, 1024 * 1024); }
  catch (error) { if (hasCode(error, 'ENOENT')) return null; throw error; }
  const parsed = BuilderDefinitionSchema.safeParse(JSON.parse(bytes.toString('utf8')));
  if (!parsed.success || parsed.data.Name !== resource.name || parsed.data.Nodes[0]?.Name !== resource.node || parsed.data.Nodes[0].Endpoint !== endpoint) dockerError('BUILDER_OWNERSHIP_UNCERTAIN');
  return parsed.data;
}
const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/).brand<'ImageDigest'>();
const PlatformSchema = z.object({ os: z.string().min(1), architecture: z.string().min(1), variant: z.string().min(1).optional() });
const ManifestIdentitySchema = z.object({ digest: DigestSchema, mediaType: z.enum(['application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json']), size: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), platform: PlatformSchema.optional() });
const MetadataSchema = z.object({ 'containerimage.config.digest': DigestSchema, 'containerimage.digest': DigestSchema.optional(), 'containerimage.descriptor': ManifestIdentitySchema.optional(), 'image.name': z.string().optional(), 'buildx.build.provenance': z.object({ materials: z.array(z.object({ uri: z.string(), digest: z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/).optional() }).catchall(z.string()) })).optional() }).optional() });
const ExportedImageSchema = ImageSchema.extend({ RepoTags: z.array(z.string()).length(1), Descriptor: ManifestIdentitySchema.optional(), Os: z.string().min(1).optional(), Architecture: z.string().min(1).optional(), Variant: z.string().optional() });
type ExportIdentity = Readonly<{ configDigest: z.infer<typeof DigestSchema>; manifest: z.infer<typeof ManifestIdentitySchema> | null; baseImages: string[] }>;
function parseExportIdentity(iid: string, metadata: unknown, expectedTag: string): ExportIdentity {
  const config = DigestSchema.safeParse(iid.trim());
  const parsed = MetadataSchema.safeParse(metadata);
  if (!config.success || !parsed.success) dockerError('INVALID_IMAGE_IDENTITY');
  const value = parsed.data;
  const manifest = value['containerimage.descriptor'] ?? null;
  if (config.data !== value['containerimage.config.digest'] || (value['containerimage.digest'] === undefined) !== (manifest === null) || manifest && manifest.digest !== value['containerimage.digest']) dockerError('INVALID_IMAGE_IDENTITY');
  if (value['image.name'] !== undefined && ![expectedTag, `docker.io/library/${expectedTag}`].includes(value['image.name'])) dockerError('INVALID_IMAGE_IDENTITY');
  const baseImages = (value['buildx.build.provenance']?.materials ?? []).flatMap((material) => material.uri.startsWith('pkg:docker/') && material.digest.sha256 ? [`${material.uri}@sha256:${material.digest.sha256}`] : []);
  return { configDigest: config.data, manifest, baseImages };
}
function verifyExportedImage(exported: ExportIdentity, observation: unknown, expected: Pick<NamedResource, 'name' | 'labels'>): z.infer<typeof ExportedImageSchema> {
  const parsed = ExportedImageSchema.safeParse(observation);
  if (!parsed.success) dockerError('DOCKER_OWNERSHIP_UNCERTAIN');
  const value = parsed.data;
  const manifest = exported.manifest;
  const descriptor = value.Descriptor;
  if (!labelsMatch(value.Config.Labels, expected.labels) || value.RepoTags[0] !== expected.name) dockerError('DOCKER_OWNERSHIP_UNCERTAIN');
  if (value.Id !== exported.configDigest && (value.Id !== manifest?.digest || !descriptor)) dockerError('DOCKER_OWNERSHIP_UNCERTAIN');
  if (descriptor && (!manifest || descriptor.digest !== manifest.digest || descriptor.mediaType !== manifest.mediaType || descriptor.size !== manifest.size)) dockerError('DOCKER_OWNERSHIP_UNCERTAIN');
  for (const platform of [manifest?.platform, descriptor?.platform]) if (platform && (value.Os !== platform.os || value.Architecture !== platform.architecture || (value.Variant || undefined) !== platform.variant)) dockerError('DOCKER_OWNERSHIP_UNCERTAIN');
  return value;
}
function labelsMatch(actual: Record<string, string> | null | undefined, expected: NamedResource['labels']): boolean { return Object.entries(expected).every(([key, value]) => actual?.[key] === value); }
const transportFailures = new WeakSet<Error>();
function dockerError(code = 'DOCKER_FAILED'): never { throw failure(6, code, 'starting', 'An owned Docker operation failed or could not be verified.', 'Inspect private Docker diagnostics and run doctor before retrying.'); }
function parseList<T>(output: string, schema: z.ZodType<T>): T | null { const rows = z.array(schema).max(1).parse(JSON.parse(output)); return rows[0] ?? null; }
function overlaps(a: string, b: string): boolean { return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`) || a === '/' || b === '/'; }
export function declaredTmpfs(image: z.infer<typeof ImageSchema>, application = false): string[] {
  const volumes = Object.keys(image.Config.Volumes ?? {});
  if (volumes.length > 16) dockerError('UNSAFE_IMAGE_VOLUME');
  const executable = [...image.Config.Entrypoint ?? [], ...image.Config.Cmd ?? []].filter((entry) => entry.startsWith('/'));
  const protectedPaths = ['/swc-state', '/swc-inputs', '/bin', '/sbin', '/usr', '/etc', '/opt', '/app', '/workspace', '/src', ...(application && image.Config.WorkingDir ? [image.Config.WorkingDir] : []), ...executable];
  for (const path of volumes) if (!path.startsWith('/') || path !== posix.normalize(path) || /[,:\x00-\x1f]/.test(path) || protectedPaths.some((protectedPath) => overlaps(path, protectedPath))) dockerError('UNSAFE_IMAGE_VOLUME');
  return volumes;
}
export async function dockerCapabilities(signal?: AbortSignal): Promise<{ available: boolean; version: string | null; buildx: string | null }> {
  try { const result = await systemProbe(['docker', 'version', '--format', '{{.Server.Version}}'], 5000, signal); const buildx = await systemProbe(['docker', 'buildx', 'version'], 5000, signal); return { available: result.code === 0, version: result.code === 0 ? result.stdout.trim() : null, buildx: buildx.code === 0 ? buildx.stdout.trim() : null }; }
  catch { return { available: false, version: null, buildx: null }; }
}
export type ContainerHandle = Readonly<{ id: string; imageId: string; exited: Promise<ProcessExit>; verify: (running: boolean) => Promise<void> }>;
export type BuiltImage = Readonly<{ imageId: string; dockerfileSha256: string; baseImages: string[] }>;
export class DockerRuntime {
  private writes = Promise.resolve();
  private readonly requestTraces: RequestTrace[] = [];
  private phase = 'initialization';
  private cleanupSupervisor: Supervisor | undefined;
  private cleanupOnlyDeadline: number | undefined;
  private constructor(private readonly run: RunContext, private readonly ledger: Ledger) {}
  static async create(run: RunContext, requireBuildx = false): Promise<DockerRuntime> {
    const context = await systemProbe(['docker', 'context', 'show'], 5000, run.signal);
    if (context.code !== 0 || !context.stdout.trim()) dockerError('DOCKER_UNAVAILABLE');
    const selected = await systemProbe(['docker', 'context', 'inspect', context.stdout.trim(), '--format', '{{.Endpoints.docker.Host}}'], 5000, run.signal);
    const endpoint = process.env.DOCKER_HOST ?? selected.stdout.trim();
    if (selected.code !== 0 || !/^unix:\/\/\/[^\x00\r\n]+$/.test(endpoint) || process.env.DOCKER_TLS_VERIFY) dockerError('UNSUPPORTED_DOCKER_ENDPOINT');
    const directory = join(run.paths.privateDir, 'docker-client');
    await mkdir(directory, { mode: 0o700 });
    const pluginDirectories: string[] = [];
    for (const candidate of ['/Applications/Docker.app/Contents/Resources/cli-plugins', '/usr/local/lib/docker/cli-plugins', '/usr/local/libexec/docker/cli-plugins', '/usr/lib/docker/cli-plugins', '/usr/libexec/docker/cli-plugins', join(homedir(), '.docker', 'cli-plugins')]) {
      try { const binary = await realpath(join(candidate, 'docker-buildx')); await access(binary, constants.X_OK); pluginDirectories.push(dirname(binary)); } catch { /* Only executable plugin locations are selected. */ }
    }
    await atomicPrivateFile(directory, 'config.json', JSON.stringify({ cliPluginsExtraDirs: [...new Set(pluginDirectories)] }), false);
    const runtime = new DockerRuntime(run, { schemaVersion: 2, runId: run.runId, endpoint, configRelative: 'docker-client', resources: [], pendingCreates: [] });
    await runtime.persist();
    await runtime.command(['version', '--format', '{{.Server.Version}}']);
    if (requireBuildx) await runtime.command(['buildx', 'version'], undefined, 5000);
    return runtime;
  }
  private prefix(): string[] { return ['docker', '--config', join(this.run.paths.privateDir, this.ledger.configRelative), '--host', this.ledger.endpoint]; }
  private async persist(): Promise<void> { this.writes = this.writes.then(() => atomicPrivateFile(this.run.paths.privateDir, 'docker.json', JSON.stringify(this.ledger), true)); await this.writes; }
  private async issued(name: string): Promise<void> { this.ledger.pendingCreates = creationIssued(this.ledger.pendingCreates, name); await this.persist(); }
  private async observed(name: string): Promise<void> { this.ledger.pendingCreates = creationObserved(this.ledger.pendingCreates, name); await this.persist(); }
  private async command(argv: readonly string[], env?: Readonly<Record<string, string>>, timeoutMs = 300_000, cleanupDeadline?: number, missingImage?: string, archive?: DockerImageArchive): Promise<string> {
    cleanupDeadline ??= this.cleanupOnlyDeadline;
    if (cleanupDeadline === undefined) checkCancelled(this.run.signal);
    if (performance.now() >= (cleanupDeadline ?? this.run.deadlineMs)) dockerError('DOCKER_DEADLINE_EXCEEDED');
    let lane = this.run.supervisor;
    if (cleanupDeadline !== undefined) {
      if (!this.cleanupSupervisor) {
        const directory = join(this.run.paths.privateDir, 'docker-cleanup');
        await safeDirectory(directory, true);
        this.cleanupSupervisor = createSupervisor({ runId: this.run.runId, privateDir: directory, signal: new AbortController().signal, deadlineMs: cleanupDeadline, diagnostics: this.run.diagnostics, redactText: this.run.redactions.text });
      }
      lane = this.cleanupSupervisor;
    }
    const remaining = (cleanupDeadline ?? this.run.deadlineMs) - performance.now();
    if (remaining <= 0) dockerError('DOCKER_DEADLINE_EXCEEDED');
    const releaseArchive = archive?.holdProcess();
    const child = await lane.spawn({ argv: [...this.prefix(), ...argv], cwd: this.run.paths.privateDir, purpose: 'docker', timeoutMs: Math.min(timeoutMs, remaining), ...(env ? { env, sensitiveValues: Object.values(env) } : {}) });
    try {
      const result = await child.exited;
      if (cleanupDeadline === undefined) checkCancelled(this.run.signal);
      if (result.code === 1 && missingImage && child.output().stdout.trim() === '[]' && child.output().stderr.includes(`No such image: ${missingImage}`)) return '[]';
      if (result.code !== 0 || result.spawnError || child.output().truncated) { await atomicPrivateFile(this.run.paths.privateDir, 'docker-last-failure.json', JSON.stringify({ argv, result, output: this.run.redactions.text(child.output().stderr) }), true); dockerError(); }
      return child.output().stdout.trim();
    } finally { await lane.stop(child); releaseArchive?.(); }
  }
  private async daemon(path: string, method = 'GET', deadline?: number, attempt = 0): Promise<{ status: number; body: unknown }> {
    deadline ??= this.cleanupOnlyDeadline;
    if (deadline === undefined) checkCancelled(this.run.signal);
    const started = performance.now();
    const remainingMs = (deadline ?? this.run.deadlineMs) - started;
    if (remainingMs <= 0) dockerError('DOCKER_DEADLINE_EXCEEDED');
    const limit = Math.max(1, Math.floor(Math.min(5000, remainingMs)));
    const timeout = AbortSignal.timeout(limit);
    const signal = deadline === undefined ? AbortSignal.any([this.run.signal, timeout]) : timeout;
    const trace: RequestTrace = { phase: this.phase, startedMonotonicMs: started, operationDeadlineMs: deadline ?? this.run.deadlineMs, runDeadlineMs: this.run.deadlineMs, loadStart: loadavg(), loadEnd: [], method, path, attempt, mode: deadline === undefined ? 'execution' : 'cleanup', startedAt: new Date().toISOString(), timeoutMs: limit, remainingMs, events: [], status: null, bytes: 0, bodySha256: null, bodyComplete: false, elapsedMs: 0, runAborted: false, runAbortCode: null, timeoutAborted: false, errorName: null, errorCode: null };
    this.requestTraces.push(trace); if (this.requestTraces.length > 128) this.requestTraces.shift();
    const event = (name: string): void => { if (trace.events.length < 32) trace.events.push({ event: name, elapsedMs: performance.now() - started }); };
    const markTimeout = (): void => event('timeout-abort'); timeout.addEventListener('abort', markTimeout, { once: true });
    const finish = (): void => { trace.loadEnd = loadavg(); trace.elapsedMs = performance.now() - started; trace.runAborted = this.run.signal.aborted; trace.runAbortCode = cancellation(this.run.signal)?.detail.code ?? null; trace.timeoutAborted = timeout.aborted; };
    const requestFailure = () => {
      const cancelled = deadline === undefined ? cancellation(this.run.signal) : null;
      if (cancelled) return cancelled;
      const error = failure(6, 'DOCKER_FAILED', 'starting', 'The owned Docker request failed or exceeded its deadline.', 'Inspect the local Docker daemon and remaining owned resources.');
      transportFailures.add(error); return error;
    };
    try {
      return await new Promise((resolve, reject) => {
        const call = request({ socketPath: decodeURIComponent(new URL(this.ledger.endpoint).pathname), path, method, headers: { Host: 'localhost' }, agent: false, signal }, (response) => {
          event('headers'); trace.status = response.statusCode ?? null;
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => { if (!trace.bytes) event('first-data'); trace.bytes += chunk.length; if (trace.bytes > 5 * 1024 * 1024) call.destroy(new Error('Docker response exceeded its bound')); else chunks.push(chunk); });
          response.on('aborted', () => event('response-aborted'));
          response.on('close', () => event('response-close'));
          response.on('error', (error: Error) => { event('response-error'); trace.errorName = error.name; if ('code' in error && typeof error.code === 'string') trace.errorCode = error.code; reject(requestFailure()); });
          response.on('end', () => {
            event('body-end'); trace.bodyComplete = response.complete;
            if (!response.complete) { reject(requestFailure()); return; }
            try { const bytes = Buffer.concat(chunks); trace.bodySha256 = sha256(bytes); const data = bytes.toString('utf8'); resolve({ status: response.statusCode ?? 0, body: data ? JSON.parse(data) : null }); }
            catch { reject(failure(6, 'DOCKER_FAILED', 'starting', 'The Docker daemon returned an invalid resource record.', 'Use a supported local Docker daemon.')); }
          });
        });
        call.on('socket', (socket) => { event('socket'); socket.on('connect', () => event('connect')); socket.on('close', () => event('socket-close')); });
        call.on('finish', () => event('request-sent'));
        call.on('error', (error: Error) => { event('request-error'); trace.errorName = error.name; if ('code' in error && typeof error.code === 'string') trace.errorCode = error.code; reject(requestFailure()); });
        call.end();
      });
    } catch (error) {
      finish();
      await atomicPrivateFile(this.run.paths.privateDir, 'docker-request-trace.json', JSON.stringify(this.requestTraces), true).catch(() => {});
      await atomicPrivateFile(this.run.paths.privateDir, 'docker-last-request-failure.json', JSON.stringify(trace), true).catch(() => {});
      if (method === 'GET' && error instanceof Error && transportFailures.has(error) && attempt === 0 && performance.now() + 1000 < (deadline ?? this.run.deadlineMs) && (deadline !== undefined || !this.run.signal.aborted)) return this.daemon(path, method, deadline, 1);
      throw error;
    } finally { finish(); timeout.removeEventListener('abort', markTimeout); }
  }
  private async inspect(resource: NamedResource, deadline?: number): Promise<z.infer<typeof ContainerSchema> | z.infer<typeof NetworkSchema> | z.infer<typeof ImageSchema> | null> {
    deadline ??= this.cleanupOnlyDeadline;
    const target = encodeURIComponent(resource.id ?? resource.name);
    const path = resource.kind === 'container' ? `/containers/${target}/json` : resource.kind === 'image' ? `/images/${target}/json` : `/networks/${target}`;
    const response = await this.daemon(path, 'GET', deadline);
    if (response.status === 404) { assertSettledAbsence(this.ledger.pendingCreates, resource.name); return null; }
    if (response.status !== 200) dockerError('DOCKER_INSPECTION_FAILED');
    if (resource.kind === 'container') {
      const value = ContainerSchema.parse(response.body);
      if (!labelsMatch(value.Config.Labels, resource.labels) || resource.id && resource.id !== value.Id || value.Name !== `/${resource.name}`) dockerError('DOCKER_OWNERSHIP_UNCERTAIN');
      if (resource.id === null || this.ledger.pendingCreates.includes(resource.name)) { resource.id = value.Id; await this.observed(resource.name); }
      return value;
    }
    if (resource.kind === 'network') {
      const value = NetworkSchema.parse(response.body);
      if (!labelsMatch(value.Labels, resource.labels) || resource.id && resource.id !== value.Id || value.Name !== resource.name) dockerError('DOCKER_OWNERSHIP_UNCERTAIN');
      if (resource.id === null || this.ledger.pendingCreates.includes(resource.name)) { resource.id = value.Id; await this.observed(resource.name); }
      return value;
    }
    if (resource.id === null || this.ledger.pendingCreates.includes(resource.name)) {
      if (!this.ledger.pendingCreates.includes(resource.name)) dockerError('DOCKER_OWNERSHIP_UNCERTAIN');
      const value = verifyExportedImage(await this.readExportIdentity(resource, deadline), response.body, resource);
      this.assertExportIdentityActive(deadline);
      if (resource.id && resource.id !== value.Id) dockerError('DOCKER_OWNERSHIP_UNCERTAIN');
      resource.id = value.Id;
      await this.observed(resource.name);
      return value;
    }
    const value = ImageSchema.parse(response.body);
    if (!labelsMatch(value.Config.Labels, resource.labels) || resource.id !== value.Id) dockerError('DOCKER_OWNERSHIP_UNCERTAIN');
    return value;
  }
  private assertExportIdentityActive(deadline?: number): void {
    if (deadline === undefined) checkCancelled(this.run.signal);
    runCleanupLifetime(this.run).assertRemaining();
    if (performance.now() >= (deadline ?? this.run.deadlineMs)) dockerError('DOCKER_DEADLINE_EXCEEDED');
  }
  private async readExportIdentity(resource: NamedResource, deadline = this.cleanupOnlyDeadline): Promise<ExportIdentity> {
    const lifetime = new CleanupLifetime();
    lifetime.begin(deadline ?? this.run.deadlineMs);
    const assertActive = (): void => { lifetime.assertRemaining(); this.assertExportIdentityActive(deadline); };
    let abort = (): void => {};
    try {
      this.assertExportIdentityActive(deadline);
      const aborted = new Promise<never>((_, reject) => {
        abort = () => { const error = cancellation(this.run.signal); if (error) reject(error); };
        if (deadline === undefined) { this.run.signal.addEventListener('abort', abort, { once: true }); abort(); }
      });
      const read = (async () => {
        assertActive();
        const iid = await readContainedFile(this.run.paths.privateDir, `${resource.side}-image-id`, 1024);
        assertActive();
        const metadata = await readContainedFile(this.run.paths.privateDir, `${resource.side}-build-metadata.json`, 5 * 1024 * 1024);
        assertActive();
        const identity = parseExportIdentity(iid.toString('utf8'), JSON.parse(metadata.toString('utf8')), resource.name);
        assertActive();
        return identity;
      })();
      const identity = await lifetime.wait(runCleanupLifetime(this.run).wait(Promise.race([read, aborted])));
      assertActive();
      return identity;
    } finally { this.run.signal.removeEventListener('abort', abort); lifetime.finish(); }
  }
  private async register(kind: NamedResource['kind'], side: Side): Promise<NamedResource> {
    const nonce = randomBytes(16).toString('hex');
    const resource: NamedResource = { kind, side, name: `swc-${side}-${nonce}${kind === 'image' ? ':app' : ''}`, labels: { 'io.show-what-changed.run': this.run.runId, 'io.show-what-changed.side': side, 'io.show-what-changed.nonce': nonce }, id: null };
    this.ledger.resources.push(resource);
    this.run.resources.register({ kind, identity: resource.name, dispose: (deadline) => this.removeNamed(resource, deadline) });
    await this.persist();
    return resource;
  }
  private labelArgs(resource: NamedResource): string[] { return Object.entries(resource.labels).flatMap(([key, value]) => ['--label', `${key}=${value}`]); }
  async network(side: Side): Promise<string> {
    this.phase = 'network-create';
    const resource = await this.register('network', side);
    await this.issued(resource.name);
    resource.id = await this.command(['network', 'create', ...this.labelArgs(resource), resource.name]);
    await this.persist(); await this.inspect(resource);
    return resource.name;
  }
  async image(image: string): Promise<z.infer<typeof ImageSchema>> {
    this.phase = 'service-image';
    await this.command(['pull', image]);
    const result = parseList(await this.command(['image', 'inspect', image]), ImageSchema);
    if (!result) dockerError();
    return result;
  }
  async build(workspace: Workspace, context: string, dockerfile: string): Promise<BuiltImage> {
    this.phase = 'builder-bootstrap';
    const resource = await this.register('image', workspace.side);
    const nonce = randomBytes(12).toString('hex');
    const node = `swc-${workspace.side}-${nonce}`;
    const builder: BuilderResource = { kind: 'builder', side: workspace.side, name: `swc-builder-${nonce}`, node, containerName: `buildx_buildkit_${node}`, volumeName: `buildx_buildkit_${node}_state`, containerId: null, volumeCreatedAt: null };
    this.ledger.resources.push(builder);
    let archive: DockerImageArchive | undefined;
    let builderRemoval: Promise<boolean> | undefined;
    const removeBuilder = (deadline: number): Promise<boolean> => builderRemoval ??= this.removeBuilder(builder, deadline);
    this.run.resources.register({ kind: 'builder', identity: builder.name, dispose: async (deadline) => { if (archive) await archive.dispose(deadline); else await removeBuilder(deadline); } });
    archive = new DockerImageArchive(this.run, `docker-export-${nonce}`, removeBuilder);
    const ownedArchive = archive;
    let operationFailed = false;
    try {
      return await ownedArchive.runOperation(async () => {
        await this.persist();
        await this.issued(builder.name);
        await this.command(['buildx', 'create', '--name', builder.name, '--node', node, '--driver', 'docker-container', '--bootstrap']);
        const presence = await this.inspectBuilder(builder);
        if (!presence.container || !presence.volume) dockerError('BUILDER_OWNERSHIP_UNCERTAIN');
        await this.persist();
        const contextRoot = join(workspace.root, context);
        await safeDirectory(contextRoot);
        const dockerfileBytes = await readContainedFile(workspace.root, dockerfile, 1024 * 1024);
        const metadata = join(this.run.paths.privateDir, `${workspace.side}-build-metadata.json`);
        const iid = join(this.run.paths.privateDir, `${workspace.side}-image-id`);
        this.phase = 'application-image-build';
        ownedArchive.assertOpen();
        await this.command(['buildx', 'build', '--builder', builder.name, '--output', `type=docker,dest=${ownedArchive.relativePath}`, '--provenance=false', '--metadata-file', metadata, '--iidfile', iid, '--file', join(workspace.root, dockerfile), '--tag', resource.name, ...this.labelArgs(resource), contextRoot], { BUILDX_METADATA_PROVENANCE: 'max' }, 3_600_000, undefined, undefined, ownedArchive);
        await ownedArchive.validate();
        const { baseImages } = await this.readExportIdentity(resource);
        if (/^\s*FROM\s+(?!scratch(?:\s|$))/im.test(dockerfileBytes.toString('utf8')) && !baseImages.length) dockerError('UNRESOLVED_BASE_IMAGE');
        await ownedArchive.assertUnchanged();
        this.phase = 'application-image-load';
        await this.issued(resource.name);
        await ownedArchive.assertUnchanged();
        await this.command(['image', 'load', '--input', ownedArchive.relativePath], undefined, 3_600_000, undefined, undefined, ownedArchive);
        this.phase = 'application-image-inspection';
        const inspected = await this.inspect(resource);
        if (!inspected || !('Config' in inspected)) dockerError('INVALID_IMAGE_IDENTITY');
        return { imageId: inspected.Id, dockerfileSha256: sha256(dockerfileBytes), baseImages };
      });
    } catch (error) {
      operationFailed = true;
      throw error;
    } finally {
      try { await ownedArchive.dispose(performance.now() + 30_000); }
      catch (error) { if (!operationFailed) throw error; }
    }
  }

  async container(options: { side: Side; image: string; network: string; alias: string; port: number; containerPort: number; env: Readonly<Record<string, string>>; inputs: SideInputs }): Promise<ContainerHandle> {
    this.phase = 'container-create';
    await safeDirectory(options.inputs.stateDir); await safeDirectory(options.inputs.inputDir);
    const image = parseList(await this.command(['image', 'inspect', options.image]), ImageSchema);
    if (!image) dockerError();
    const tmpfs = declaredTmpfs(image, this.ledger.resources.some((entry) => entry.kind === 'image' && entry.id === image.Id));
    const network = this.ledger.resources.find((entry) => entry.kind === 'network' && entry.name === options.network);
    if (!network || network.kind !== 'network' || !network.id || !await this.inspect(network)) dockerError('INVALID_CONTAINER_NETWORK');
    const expectedNetworkId = network.id;
    const resource = await this.register('container', options.side);
    const bindings = [['/swc-state', options.inputs.stateDir, 'rw'], ...(options.inputs.files.size ? [['/swc-inputs', options.inputs.inputDir, 'ro']] : [])];
    if (bindings.some((entry) => entry.some((value) => value.includes(',') || value.includes('\n')))) dockerError('UNSAFE_CONTAINER_MOUNT');
    const env = { ...options.env };
    delete env.PATH;
    const args = ['container', 'create', '--name', resource.name, '--log-driver', 'none', '--attach', 'stdout', '--attach', 'stderr', ...this.labelArgs(resource), '--network', options.network, '--network-alias', options.alias, '--publish', `127.0.0.1:${options.port}:${options.containerPort}`, ...tmpfs.flatMap((path) => ['--tmpfs', `${path}:rw,nosuid,nodev,size=268435456`]), ...bindings.flatMap(([target, source, mode]) => ['--mount', `type=bind,source=${source},target=${target}${mode === 'ro' ? ',readonly' : ''}`]), ...Object.keys(env).flatMap((name) => ['--env', name]), options.image];
    await this.issued(resource.name);
    resource.id = await this.command(args, env);
    await this.persist();
    const verify = async (running: boolean): Promise<void> => {
      this.phase = running ? 'container-verify-running' : 'container-verify-created';
      const value = await this.inspect(resource);
      if (running && value && 'State' in value && !value.State.Running) dockerError('CONTAINER_EXITED');
      if (!value || !('Mounts' in value) || value.Image !== image.Id || value.State.Running !== running || value.HostConfig.Privileged || value.HostConfig.LogConfig.Type !== 'none' || Object.keys(value.HostConfig.LogConfig.Config ?? {}).length !== 0 || value.HostConfig.NetworkMode !== options.network || Object.keys(value.NetworkSettings.Networks).length !== 1 || !value.NetworkSettings.Networks[options.network]?.Aliases?.includes(options.alias)) dockerError('INVALID_CONTAINER_IDENTITY');
      const mappings = value.HostConfig.PortBindings ?? {};
      const mapping = mappings[`${options.containerPort}/tcp`];
      if (Object.keys(mappings).length !== 1 || mapping?.length !== 1 || mapping[0]?.HostIp !== '127.0.0.1' || mapping[0].HostPort !== String(options.port)) dockerError('INVALID_CONTAINER_PORT');
      if (running) { if (value.NetworkSettings.Networks[options.network]?.NetworkID !== expectedNetworkId) dockerError('INVALID_CONTAINER_NETWORK'); const active = value.NetworkSettings.Ports?.[`${options.containerPort}/tcp`]; if (active?.length !== 1 || active[0]?.HostIp !== '127.0.0.1' || active[0].HostPort !== String(options.port)) dockerError('INVALID_CONTAINER_PORT'); }
      const actual = value.Mounts;
      if (actual.some((mount) => mount.Type !== 'bind' && mount.Type !== 'tmpfs') || actual.filter((mount) => mount.Type === 'bind').length !== bindings.length || actual.some((mount) => mount.Type === 'bind' && !bindings.some(([target, source, mode]) => mount.Destination === target && mount.Source === source && mount.RW === (mode === 'rw'))) || actual.some((mount) => mount.Type === 'tmpfs' && !tmpfs.includes(mount.Destination))) dockerError('INVALID_CONTAINER_MOUNT');
      const inspectedTmpfs = value.HostConfig.Tmpfs ?? {};
      if (Object.keys(inspectedTmpfs).length !== tmpfs.length || tmpfs.some((path) => inspectedTmpfs[path] !== 'rw,nosuid,nodev,size=268435456')) dockerError('INVALID_CONTAINER_MOUNT');
    };
    await verify(false);
    const process = await this.run.supervisor.spawn({ argv: [...this.prefix(), 'container', 'start', '--attach', resource.id], cwd: this.run.paths.privateDir, purpose: 'server', side: options.side, sensitiveValues: Object.values(options.env) });
    const startupDeadline = Math.min(this.run.deadlineMs, performance.now() + 10_000);
    while (performance.now() < startupDeadline) {
      checkCancelled(this.run.signal);
      this.phase = 'container-start-poll';
      const current = await this.inspect(resource);
      if (current && 'State' in current && current.State.Running) {
        await verify(true);
        return { id: resource.id, imageId: image.Id, exited: process.exited, verify };
      }
      if (!process.isAlive()) dockerError('CONTAINER_EXITED');
      await delay(25, undefined, { signal: this.run.signal }).catch(() => checkCancelled(this.run.signal));
    }
    checkCancelled(this.run.signal);
    dockerError('CONTAINER_START_TIMEOUT');
  }
  private async inspectBuilder(resource: BuilderResource, deadline?: number, observe = true): Promise<BuilderPresence> {
    const confirmed = confirmedBuilder(resource);
    const definition = await builderDefinition(this.run.paths.privateDir, this.ledger.endpoint, resource);
    const inspected = await this.daemon(`/containers/${encodeURIComponent(resource.containerName)}/json`, 'GET', deadline);
    if (![200, 404].includes(inspected.status)) dockerError('BUILDER_OWNERSHIP_UNCERTAIN');
    const container = inspected.status === 200 ? ContainerSchema.parse(inspected.body) : null;
    if (confirmed) {
      const original = await this.daemon(`/containers/${resource.containerId}/json`, 'GET', deadline);
      if (original.status !== inspected.status || original.status === 200 && (ContainerSchema.parse(original.body).Id !== resource.containerId || ContainerSchema.parse(original.body).Name !== `/${resource.containerName}`)) dockerError('BUILDER_OWNERSHIP_UNCERTAIN');
    }
    const inspectedVolume = await this.daemon(`/volumes/${encodeURIComponent(resource.volumeName)}`, 'GET', deadline);
    if (![200, 404].includes(inspectedVolume.status)) dockerError('BUILDER_OWNERSHIP_UNCERTAIN');
    const volume = inspectedVolume.status === 200 ? VolumeSchema.parse(inspectedVolume.body) : null;
    if (container && (container.Name !== `/${resource.containerName}` || confirmed && resource.containerId !== container.Id || container.Mounts.length !== 1 || container.Mounts[0]?.Type !== 'volume' || container.Mounts[0].Name !== resource.volumeName || container.Mounts[0].Destination !== '/var/lib/buildkit' || !(container.Config.Image.startsWith('moby/buildkit:') || /^moby\/buildkit@sha256:[a-f0-9]{64}$/.test(container.Config.Image)))) dockerError('BUILDER_OWNERSHIP_UNCERTAIN');
    if (volume && (volume.Name !== resource.volumeName || volume.Driver !== 'local' || !volume.CreatedAt || confirmed && volume.CreatedAt !== resource.volumeCreatedAt)) dockerError('BUILDER_OWNERSHIP_UNCERTAIN');
    const presence = { container, volume, definition };
    if (this.ledger.pendingCreates.includes(resource.name)) {
      if (!container || !volume) assertSettledAbsence(this.ledger.pendingCreates, resource.name);
      if (observe && container && volume) { resource.containerId = container.Id; resource.volumeCreatedAt = volume.CreatedAt; await this.observed(resource.name); }
    } else if (!confirmed && hasBuilderResidue(presence)) dockerError('BUILDER_OWNERSHIP_UNCERTAIN');
    return presence;
  }
  private async verifyBuilderVolumeReferences(resource: BuilderResource, deadline: number): Promise<void> {
    const filters = encodeURIComponent(JSON.stringify({ volume: [resource.volumeName] }));
    const response = await this.daemon(`/containers/json?all=1&filters=${filters}`, 'GET', deadline);
    if (response.status !== 200) dockerError('BUILDER_OWNERSHIP_UNCERTAIN');
    const containers = z.array(z.object({ Id: z.string().regex(/^[a-f0-9]{64}$/), Mounts: z.array(z.object({ Type: z.string(), Name: z.string().optional() })) })).max(10000).parse(response.body);
    if (containers.some((container) => container.Id !== resource.containerId && container.Mounts.some((mount) => mount.Type === 'volume' && mount.Name === resource.volumeName))) dockerError('BUILDER_VOLUME_IN_USE');
  }
  private async removeBuilder(resource: BuilderResource, deadline: number): Promise<boolean> {
    this.phase = 'builder-cleanup';
    const initial = await this.inspectBuilder(resource, deadline);
    for (const member of ['container', 'volume'] as const) {
      for (let attempt = 0; attempt < 2; attempt++) {
        let current = await this.inspectBuilder(resource, deadline);
        if (!current[member]) break;
        if (current.volume) await this.verifyBuilderVolumeReferences(resource, deadline);
        current = await this.inspectBuilder(resource, deadline);
        if (!current[member]) break;
        const path = member === 'container' ? `/containers/${resource.containerId}?force=1&v=0` : `/volumes/${encodeURIComponent(resource.volumeName)}?force=0`;
        try {
          const response = await this.daemon(path, 'DELETE', deadline, attempt);
          if (![200, 204, 404].includes(response.status)) dockerError('BUILDER_CLEANUP_FAILED');
        } catch (error) {
          if (!(error instanceof Error) || !transportFailures.has(error) || performance.now() + 1000 >= deadline) throw error;
          if (!(await this.inspectBuilder(resource, deadline))[member]) break;
          if (attempt === 1) throw error;
          continue;
        }
        if ((await this.inspectBuilder(resource, deadline))[member]) dockerError('BUILDER_CLEANUP_FAILED');
        break;
      }
    }
    const final = await this.inspectBuilder(resource, deadline);
    if (final.container || final.volume) dockerError('BUILDER_CLEANUP_FAILED');
    if (final.definition && await builderDefinition(this.run.paths.privateDir, this.ledger.endpoint, resource)) {
      try { await this.command(['buildx', 'rm', '--force', '--keep-daemon', resource.name], undefined, 5000, deadline); }
      catch (error) { if (await builderDefinition(this.run.paths.privateDir, this.ledger.endpoint, resource)) throw error; }
      if (await builderDefinition(this.run.paths.privateDir, this.ledger.endpoint, resource)) dockerError('BUILDER_CLEANUP_FAILED');
    }
    return hasBuilderResidue(initial);
  }
  private async removeNamed(resource: NamedResource, deadline: number): Promise<void> {
    this.phase = `${resource.kind}-cleanup`;
    const current = await this.inspect(resource, deadline);
    if (!current) return;
    resource.id = current.Id; await this.persist();
    const target = encodeURIComponent(resource.id);
    const remove = async (): Promise<void> => {
      const response = await this.daemon(resource.kind === 'container' ? `/containers/${target}?force=1&v=0` : resource.kind === 'image' ? `/images/${target}?force=0&noprune=1` : `/networks/${target}`, 'DELETE', deadline);
      if (![200, 204, 404].includes(response.status)) dockerError('DOCKER_CLEANUP_FAILED');
    };
    try { await remove(); }
    catch (error) {
      if (!(error instanceof Error) || !transportFailures.has(error) || performance.now() + 1000 >= deadline) throw error;
      if (!await this.inspect(resource, deadline)) return;
      await remove();
    }
    if (await this.inspect(resource, deadline)) dockerError('DOCKER_CLEANUP_FAILED');
  }
  static async recover(runDir: string, runId: string, cleanup = true): Promise<boolean> {
    let ledger: Ledger;
    try { ledger = parseDockerLedger(JSON.parse((await readRunFile(runDir, 'private/docker.json', 1024 * 1024)).toString('utf8'))); }
    catch (error) { if (hasCode(error, 'ENOENT')) return false; throw failure(2, 'DOCKER_OWNERSHIP_UNCERTAIN', 'cleanup', 'Docker ownership records are invalid.', 'Inspect this exact run manually.'); }
    if (ledger.runId !== runId || ledger.resources.some((resource) => resource.kind === 'builder' ? resource.containerName !== `buildx_buildkit_${resource.node}` || resource.volumeName !== `${resource.containerName}_state` || resource.node !== `swc-${resource.side}-${resource.name.slice('swc-builder-'.length)}` : resource.labels['io.show-what-changed.run'] !== runId || resource.labels['io.show-what-changed.side'] !== resource.side || resource.name !== `swc-${resource.side}-${resource.labels['io.show-what-changed.nonce']}${resource.kind === 'image' ? ':app' : ''}`)) dockerError('DOCKER_OWNERSHIP_UNCERTAIN');
    const privateDir = join(runDir, 'private');
    const resources = { register() {}, async disposeAll() { return { status: 'ok' as const, errors: [] }; } };
    const deadlineMs = performance.now() + 30_000;
    const supervisor = createSupervisor({ runId, privateDir: join(privateDir, 'docker-cleanup'), signal: new AbortController().signal, deadlineMs, diagnostics: { event() {} } });
    await safeDirectory(join(privateDir, 'docker-cleanup'), true);
    const runtime = new DockerRuntime({ runId, paths: { repoRoot: '', runDir, privateDir, tempDir: '', framesDir: '', composedDir: '' }, startedAt: new Date().toISOString(), startedMonotonicMs: performance.now(), deadlineMs, signal: new AbortController().signal, diagnostics: { event() {} }, resources, supervisor, redactions: { add() {}, text(value) { return value; } } }, ledger);
    runtime.cleanupOnlyDeadline = deadlineMs;
    let residue = false; const errors: unknown[] = [];
    try {
      for (const kind of ['builder', 'container', 'network', 'image']) for (const resource of ledger.resources.filter((entry) => entry.kind === kind)) {
        try {
          if (resource.kind === 'builder') { const found = cleanup ? await runtime.removeBuilder(resource, deadlineMs) : hasBuilderResidue(await runtime.inspectBuilder(resource, deadlineMs, false)); residue ||= found; }
          else if (await runtime.inspect(resource)) { residue = true; if (cleanup) await runtime.removeNamed(resource, deadlineMs); }
        } catch (error) { errors.push(error); }
      }
      if (errors.length) throw errors[0];
      return residue;
    } finally { await supervisor.stopAll(); await runtime.cleanupSupervisor?.stopAll(); }
  }
}

export async function inspectDockerResidue(runDir: string, runId: string): Promise<boolean> {
  let ledger: Ledger;
  try { ledger = parseDockerLedger(JSON.parse((await readRunFile(runDir, 'private/docker.json', 1024 * 1024)).toString('utf8'))); }
  catch (error) { if (hasCode(error, 'ENOENT')) return false; throw error; }
  if (ledger.runId !== runId) throw new Error('Docker run identity changed');
  if (ledger.pendingCreates.length) return true;
  const prefix = ['docker', '--config', join(runDir, 'private', ledger.configRelative), '--host', ledger.endpoint];
  for (const resource of ledger.resources) {
    const argv = resource.kind === 'builder' ? ['container', 'ls', '--all', '--quiet', '--filter', `name=^/${resource.containerName}$`] : [resource.kind, 'ls', '--quiet', ...(resource.kind === 'container' ? ['--all'] : []), '--filter', resource.kind === 'image' ? `reference=${resource.name}` : `name=^${resource.kind === 'container' ? '/' : ''}${resource.name}$`];
    const result = await systemProbe([...prefix, ...argv], 5000);
    if (result.code !== 0) throw new Error('Docker residue could not be inspected');
    if (result.stdout.trim()) return true;
    if (resource.kind === 'builder') {
      const volume = await systemProbe([...prefix, 'volume', 'ls', '--quiet', '--filter', `name=^${resource.volumeName}$`], 5000);
      if (volume.code !== 0) throw new Error('Docker residue could not be inspected');
      if (volume.stdout.trim() || await builderDefinition(join(runDir, 'private'), ledger.endpoint, resource)) return true;
    }
  }
  return false;
}
