import { createConnection, createServer } from 'node:net';
import { access, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { satisfies, valid } from 'semver';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import type { OwnedProcess, RunContext, RuntimeResult, Server, WorkspacePair } from '../schema/contracts.js';
import type { Plan, RuntimeSideProvenance, Side } from '../schema/index.js';
import { checkCancelled, failure, ToolFailure } from '../schema/errors.js';
import { processTable, systemProbe } from './process-table.js';
import { reservePort } from './ports.js';
import { atomicPrivateFile } from './files.js';
import { DockerRuntime } from './docker.js';
import { applicationEnvironment, bindEnvironment, commandArguments, commandCwd, prepareInputs, readAuthState, readBoundInputs } from './recipe.js';
import type { BoundEnvironment, Consumer, ServiceEndpoint, SideInputs } from './recipe.js';
import type { RecipeCommand, ExecutionRecipe } from '../schema/recipe.js';

type Listener = { pid: number; address: string };
export async function listeners(port: number): Promise<Listener[]> {
  const result = await systemProbe(['lsof', '-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpn']);
  if (result.code === 1 && !result.stdout.trim()) return [];
  if (result.code !== 0) throw failure(8, 'LISTENER_INSPECTION_FAILED', 'starting', 'Listening sockets could not be inspected.', 'Install lsof and allow process inspection.');
  const rows: Listener[] = []; let pid: number | null = null;
  for (const line of result.stdout.split('\n')) {
    if (line.startsWith('p')) { const parsed = Number(line.slice(1)); if (!Number.isSafeInteger(parsed) || parsed <= 0) throw failure(8, 'LISTENER_INSPECTION_FAILED', 'starting', 'Listener process data was invalid.', 'Use a supported lsof installation.'); pid = parsed; }
    if (line.startsWith('n')) { if (pid === null) throw failure(8, 'LISTENER_INSPECTION_FAILED', 'starting', 'Listener process ownership was missing.', 'Use a supported lsof installation.'); rows.push({ pid, address: line.slice(1) }); }
  }
  return rows;
}
async function portFree(port: number): Promise<boolean> {
  if ((await listeners(port)).length) return false;
  return new Promise<boolean>((resolve) => { const server = createServer(); server.once('error', () => resolve(false)); server.listen(port, '127.0.0.1', () => server.close(() => resolve(true))); });
}
export async function allocatePorts(count: number, used = new Set<number>(), run?: RunContext): Promise<number[]> {
  const picked: number[] = [];
  for (let port = 4310; port <= 4499; port++) {
    if (!used.has(port) && await portFree(port) && (!run || await reservePort(port, run))) { picked.push(port); used.add(port); }
    if (picked.length === count) return picked;
  }
  throw failure(6, 'PORTS_UNAVAILABLE', 'starting', 'Free loopback ports in 4310 through 4499 are required.', 'Stop conflicting local services or retry later.');
}
export async function verifyListeners(port: number, process: OwnedProcess): Promise<boolean> {
  const active = await listeners(port);
  if (!active.length) return false;
  const rows = await processTable();
  for (const listener of active) {
    if (!rows.some((row) => row.pid === listener.pid && row.group === process.groupId)) throw failure(6, 'UNOWNED_LISTENER', 'starting', 'An unrelated process owns the allocated server port.', 'Retry after the port conflict is resolved.');
    if (listener.address !== `127.0.0.1:${port}` && listener.address !== `[::1]:${port}` && listener.address !== `::1:${port}`) throw failure(6, 'NON_LOOPBACK_LISTENER', 'starting', 'The server bound a wildcard or non-loopback address.', 'Configure the server to bind 127.0.0.1 and honor the assigned port.');
  }
  if (!process.isAlive()) throw failure(6, 'SERVER_EXITED', 'starting', 'The owned server exited before readiness.', 'Inspect the private server log.');
  return true;
}
type HttpReady = ExecutionRecipe['ready'];
async function readyRequest(origin: string, ready: HttpReady, run: RunContext): Promise<boolean> {
  let url = new URL(ready.path, origin);
  const signal = AbortSignal.any([run.signal, AbortSignal.timeout(1000)]);
  for (let redirects = 0; redirects <= 5; redirects++) {
    const response = await fetch(url, { redirect: 'manual', signal });
    await response.body?.cancel();
    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      const next = new URL(location, url);
      if (next.origin !== origin) throw failure(6, 'READINESS_REDIRECT', 'starting', 'Readiness redirected outside the owned server origin.', 'Use a local readiness path that does not redirect externally.');
      if (ready.statuses.includes(response.status)) return true;
      url = next; continue;
    }
    return ready.statuses.includes(response.status);
  }
  return false;
}
async function tcpReady(port: number, run: RunContext): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port, signal: AbortSignal.any([run.signal, AbortSignal.timeout(1000)]) });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => { socket.destroy(); resolve(false); });
  });
}
async function waitReady(options: { port: number; ready: HttpReady | ExecutionRecipe['services'][number]['ready']; run: RunContext; process?: OwnedProcess; container?: Awaited<ReturnType<DockerRuntime['container']>> }): Promise<void> {
  const { port, ready, run, process, container } = options;
  const deadline = Math.min(run.deadlineMs, performance.now() + ready.timeoutMs);
  let exited = false;
  if (container) void container.exited.then(() => { exited = true; });
  while (performance.now() < deadline) {
    checkCancelled(run.signal);
    if (process && !process.isAlive() || exited) {
      if (process) {
        const occupied = await listeners(port); const rows = occupied.length ? await processTable() : [];
        if (occupied.some((listener) => !rows.some((row) => row.pid === listener.pid && row.group === process.groupId))) throw failure(6, 'PORT_CONFLICT', 'starting', 'An unrelated process claimed the allocated server port.', 'Retry after the port conflict is resolved.');
      }
      throw failure(6, 'SERVER_EXITED', 'starting', 'An owned server exited before readiness.', 'Inspect the private process log.');
    }
    let owned = false;
    if (process) owned = await verifyListeners(port, process);
    else if (container) { await container.verify(true); owned = true; }
    if (owned) {
      try { if ('kind' in ready && ready.kind === 'tcp' ? await tcpReady(port, run) : await readyRequest(`http://127.0.0.1:${port}`, ready, run)) { if (process) await verifyListeners(port, process); else await container?.verify(true); return; } }
      catch (error) { if (error instanceof ToolFailure) throw error; checkCancelled(run.signal); }
    }
    await delay(Math.min(100, Math.max(1, deadline - performance.now())), undefined, { signal: run.signal }).catch(() => checkCancelled(run.signal));
  }
  checkCancelled(run.signal);
  throw failure(6, 'SERVER_TIMEOUT', 'starting', 'The server did not become ready on its exact assigned port.', 'Check the readiness condition and assigned loopback port.');
}
async function executable(argv0: string, path: string, cwd: string): Promise<string> {
  const candidates = argv0.includes('/') ? [isAbsolute(argv0) ? argv0 : join(cwd, argv0)] : path.split(':').filter(Boolean).map((directory) => join(directory, argv0));
  for (const candidate of candidates) try { await access(candidate, constants.X_OK); return await realpath(candidate); } catch { /* Try the next explicitly selected executable directory. */ }
  throw failure(8, 'PREREQUISITE_MISSING', 'starting', 'A declared application executable is unavailable.', 'Install the selected application runtime or correct its PATH.');
}
async function runCommand(command: RecipeCommand, purpose: 'setup' | 'bootstrap', consumer: Consumer, binding: BoundEnvironment, workspace: WorkspacePair[Side], recipe: ExecutionRecipe, run: RunContext): Promise<void> {
  const child = await run.supervisor.spawn({ argv: commandArguments(command.argv, consumer), cwd: await commandCwd(workspace, command.cwd), purpose, side: consumer.side, port: consumer.port, env: applicationEnvironment(recipe.env, binding, consumer), sensitiveValues: binding.sensitiveValues, timeoutMs: command.timeoutMs });
  const result = await child.exited;
  checkCancelled(run.signal);
  if (result.code !== 0 || result.spawnError) throw failure(5, purpose === 'setup' ? 'SETUP_FAILED' : 'BOOTSTRAP_FAILED', 'starting', 'A declared application command failed.', 'Inspect its private diagnostic log and correct the recipe.');
}
async function executeRecipe(workspaces: WorkspacePair, plan: Plan, run: RunContext): Promise<RuntimeResult> {
  checkCancelled(run.signal);
  const recipe = plan.config.execution;
  const binding = await bindEnvironment(recipe, run);
  const boundInputs = await readBoundInputs(plan, run);
  const ports = await allocatePorts(2 * (recipe.services.length + 1), new Set(), run);
  const makeSide = async (side: Side, offset: number): Promise<{ inputs: SideInputs; app: Consumer; endpoints: ServiceEndpoint[] }> => {
    const inputs = await prepareInputs(plan, run, side, boundInputs);
    const port = ports[offset];
    if (port === undefined) throw new Error('Missing allocated application port');
    const endpoints = recipe.services.map((service, index): ServiceEndpoint => {
      const servicePort = ports[offset + index + 1];
      if (servicePort === undefined) throw new Error('Missing allocated service port');
      return service.kind === 'process' ? { kind: 'process', id: service.id, port: servicePort } : { kind: 'container', id: service.id, port: servicePort, alias: `service-${service.id}`, containerPort: service.containerPort };
    });
    return { inputs, endpoints, app: { side, port, origin: `http://127.0.0.1:${port}`, container: false, inputs, services: endpoints, runId: run.runId } };
  };
  const sides = { before: await makeSide('before', 0), after: await makeSide('after', recipe.services.length + 1) };
  const privatePrerequisites: { side: Side; executable: string; version: string }[] = [];
  // Validate both sides before any setup, service, or application command can run.
  for (const side of ['before', 'after'] as const) {
    const consumer = sides[side].app;
    applicationEnvironment(recipe.env, binding, consumer);
    for (const command of [...recipe.setup, ...recipe.bootstrap]) { commandArguments(command.argv, consumer); await commandCwd(workspaces[side], command.cwd); }
    if (recipe.start.kind === 'process') { commandArguments(recipe.start.argv, consumer); await commandCwd(workspaces[side], recipe.start.cwd); }
    else applicationEnvironment(recipe.env, binding, { ...consumer, container: true, port: recipe.start.containerPort });
    for (const [index, service] of recipe.services.entries()) {
      const endpoint = sides[side].endpoints[index];
      if (!endpoint) throw new Error('Missing allocated service endpoint');
      const serviceConsumer = { ...consumer, port: endpoint.kind === 'container' ? endpoint.containerPort : endpoint.port, container: endpoint.kind === 'container', services: sides[side].endpoints.slice(0, index) };
      applicationEnvironment(service.env, binding, serviceConsumer);
      if (service.kind === 'process') { commandArguments(service.argv, serviceConsumer); await commandCwd(workspaces[side], service.cwd); for (const command of service.setup) { commandArguments(command.argv, serviceConsumer); await commandCwd(workspaces[side], command.cwd); } }
    }
  }
  for (const side of ['before', 'after'] as const) for (const requirement of recipe.requires) {
    const consumer = sides[side].app;
    const argv = commandArguments(requirement.argv, consumer);
    const cwd = await commandCwd(workspaces[side], plan.config.appDir);
    const command = argv[0]; if (!command) throw new Error('Missing prerequisite executable');
    const resolved = await executable(command, binding.path, cwd);
    const child = await run.supervisor.spawn({ argv: [resolved, ...argv.slice(1)], cwd, purpose: 'probe', side, port: consumer.port, env: applicationEnvironment(recipe.env, binding, consumer), sensitiveValues: binding.sensitiveValues, timeoutMs: 30_000 });
    const result = await child.exited; checkCancelled(run.signal);
    const text = `${child.output().stdout}\n${child.output().stderr}`;
    const version = /\bv?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?![\d.])/.exec(text)?.[1];
    if (result.code !== 0 || !version || !valid(version) || !satisfies(version, requirement.expectedVersion)) throw failure(8, 'PREREQUISITE_VERSION', 'starting', 'A declared application prerequisite is incompatible.', 'Select an executable matching the declared version range.');
    privatePrerequisites.push({ side, executable: resolved, version });
  }
  await atomicPrivateFile(run.paths.privateDir, 'execution.json', JSON.stringify({ prerequisites: privatePrerequisites, inputs: plan.inputs.map((input) => ({ id: input.id, path: input.path, sha256: input.sha256, executable: input.executable })) }), true);
  const docker = recipe.start.kind === 'container' || recipe.services.some((service) => service.kind === 'container') ? await DockerRuntime.create(run, recipe.start.kind === 'container') : null;
  const launch = async (side: Side): Promise<{ server: Server; provenance: RuntimeSideProvenance }> => {
    const selected = sides[side]; const workspace = workspaces[side]; const consumer = selected.app;
    const services: RuntimeSideProvenance['services'] = [];
    const network = docker ? await docker.network(side) : null;
    for (const [index, service] of recipe.services.entries()) {
      const endpoint = selected.endpoints[index]; if (!endpoint) throw new Error('Missing service endpoint');
      const serviceConsumer = { ...consumer, container: false, port: endpoint.port, services: selected.endpoints.slice(0, index) };
      if (service.kind === 'process') {
        for (const command of service.setup) await runCommand(command, 'setup', serviceConsumer, binding, workspace, { ...recipe, env: service.env }, run);
        if ((await listeners(endpoint.port)).length) throw failure(6, 'PORT_CONFLICT', 'starting', 'A service port was claimed before startup.', 'Retry with free local ports.');
        const child = await run.supervisor.spawn({ argv: commandArguments(service.argv, serviceConsumer), cwd: await commandCwd(workspace, service.cwd), purpose: 'service', side, port: endpoint.port, env: applicationEnvironment(service.env, binding, serviceConsumer), sensitiveValues: binding.sensitiveValues });
        await waitReady({ port: endpoint.port, ready: service.ready, run, process: child });
        services.push({ id: service.id, kind: service.kind, identity: `process-group-${child.groupId}`, imageId: null });
      } else {
        if (!docker || !network || endpoint.kind !== 'container') throw new Error('Missing container service network');
        const image = await docker.image(service.image);
        const container = await docker.container({ side, image: image.Id, network, alias: endpoint.alias, port: endpoint.port, containerPort: endpoint.containerPort, env: applicationEnvironment(service.env, binding, { ...serviceConsumer, container: true, port: endpoint.containerPort }), inputs: selected.inputs });
        await waitReady({ port: endpoint.port, ready: service.ready, run, container });
        services.push({ id: service.id, kind: service.kind, identity: container.id, imageId: container.imageId });
      }
    }
    for (const command of recipe.setup) await runCommand(command, 'setup', consumer, binding, workspace, recipe, run);
    let exited: Server['exited']; let provenance: RuntimeSideProvenance;
    const common = { state: recipe.state.kind, seedId: recipe.state.kind === 'isolated' ? recipe.state.seedId : null, dependencyReproducibility: recipe.setup.length ? 'unverified' as const : 'none' as const, services };
    if (recipe.start.kind === 'process') {
      if ((await listeners(consumer.port)).length) throw failure(6, 'PORT_CONFLICT', 'starting', 'An application port was claimed before startup.', 'Retry with free local ports.');
      const child = await run.supervisor.spawn({ argv: commandArguments(recipe.start.argv, consumer), cwd: await commandCwd(workspace, recipe.start.cwd), purpose: 'server', side, port: consumer.port, env: applicationEnvironment(recipe.env, binding, consumer), sensitiveValues: binding.sensitiveValues });
      await waitReady({ port: consumer.port, ready: recipe.ready, run, process: child });
      exited = child.exited; provenance = { ...common, kind: 'process', buildArtifacts: 'unverified' };
    } else {
      if (!docker || !network) throw new Error('Missing application container network');
      const build = await docker.build(workspace, recipe.start.build.context, recipe.start.build.dockerfile);
      const container = await docker.container({ side, image: build.imageId, network, alias: 'application', port: consumer.port, containerPort: recipe.start.containerPort, env: applicationEnvironment(recipe.env, binding, { ...consumer, container: true, port: recipe.start.containerPort }), inputs: selected.inputs });
      await waitReady({ port: consumer.port, ready: recipe.ready, run, container });
      exited = container.exited; provenance = { ...common, dependencyReproducibility: 'unverified', kind: 'container', ...build };
    }
    for (const command of recipe.bootstrap) await runCommand(command, 'bootstrap', consumer, binding, workspace, recipe, run);
    const storageState = await readAuthState(recipe, selected.inputs, consumer.origin, run);
    return { server: { side, origin: consumer.origin, port: consumer.port, sourceLabel: workspace.label, source: { requested: side === 'before' ? plan.requestedBase : plan.requestedHead, commit: workspace.commit, kind: workspace.kind, materializedHash: workspace.materializedHash }, storageState, exited }, provenance };
  };
  const before = await launch('before'); const after = await launch('after');
  return { servers: { before: before.server, after: after.server }, provenance: { before: before.provenance, after: after.provenance } };
}

export async function start(workspaces: WorkspacePair, plan: Plan, run: RunContext): Promise<RuntimeResult> {
  const hostOnly = plan.config.execution.start.kind === 'process' && plan.config.execution.services.every((service) => service.kind === 'process');
  for (let attempt = 0; ; attempt++) {
    const resources: Parameters<RunContext['resources']['register']>[0][] = [];
    const processes: OwnedProcess[] = [];
    const scoped: RunContext = { ...run, resources: { register(resource) { run.resources.register(resource); resources.push(resource); }, disposeAll: () => run.resources.disposeAll() }, supervisor: { ...run.supervisor, async spawn(spec) { const owned = await run.supervisor.spawn(spec); processes.push(owned); return owned; } } };
    try { return await executeRecipe(workspaces, plan, scoped); }
    catch (error) {
      if (!hostOnly || attempt >= 2 || !(error instanceof ToolFailure) || !['PORT_CONFLICT', 'UNOWNED_LISTENER'].includes(error.detail.code)) throw error;
      checkCancelled(run.signal);
      const deadline = performance.now() + 30_000;
      for (const process of processes) await run.supervisor.stop(process);
      for (const resource of resources.reverse()) await resource.dispose(deadline);
    }
  }
}
