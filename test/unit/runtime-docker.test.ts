import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { chmod, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { availableParallelism, freemem, loadavg, tmpdir, totalmem } from 'node:os';
import { atomicPrivateFile, safeDirectory } from '../../src/runtime/files.js';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import type { RunContext, Workspace } from '../../src/schema/contracts.js';
import { beforeDeadline, createRunContext, cleanupRun } from '../../src/runtime/context.js';
import { declaredTmpfs, DockerRuntime } from '../../src/runtime/docker.js';
import { systemProbe } from '../../src/runtime/process-table.js';
import { ToolFailure } from '../../src/schema/errors.js';
import { sha256 } from '../../src/schema/io.js';
const roots: string[] = []; const runs: RunContext[] = []; const retainedRoots = new Set<string>(); const expectedCleanupUncertainty = new Set<RunContext>();
const originalFixturePath = process.env.PATH;
let fixtureTransportDirectory: string | undefined;
beforeAll(async () => {
  if (process.env.SWC_DOCKER_TESTS !== '1') return;
  let executable: string | undefined;
  for (const directory of (originalFixturePath ?? '').split(':')) { try { executable = await realpath(join(directory, 'docker')); break; } catch { /* Only the installed Docker executable is selected. */ } }
  if (!executable) throw new Error('The bounded Docker fixture requires the installed Docker CLI.');
  fixtureTransportDirectory = await realpath(await mkdtemp(join(tmpdir(), 'swc-docker-transport-')));
  const config = join(fixtureTransportDirectory, 'buildkitd.toml');
  await atomicPrivateFile(fixtureTransportDirectory, 'buildkitd.toml', '[worker.oci]\nmax-parallelism = 1\n', false);
  const profile = { executable, buildkitImage: 'moby/buildkit@sha256:cec9f139f45e93c5c69c60f8b07cfad9f43f4ef6b6a6cd917527fea5ff2e3dea', buildkitConfig: config, recordPath: join(fixtureTransportDirectory, 'bounded-commands.jsonl') };
  const helper = new URL('./runtime-docker-bounds.ts', import.meta.url).href;
  await atomicPrivateFile(fixtureTransportDirectory, 'docker', `#!${process.execPath} --experimental-transform-types\nimport(${JSON.stringify(helper)}).then(({runBoundedDockerCommand})=>runBoundedDockerCommand({...${JSON.stringify(profile)},argv:process.argv.slice(2)})).catch(()=>{process.stderr.write('Bounded Docker fixture transport failed.\\n');process.exitCode=1});\n`, false);
  await chmod(join(fixtureTransportDirectory, 'docker'), 0o700);
  process.env.PATH = `${fixtureTransportDirectory}:${originalFixturePath ?? ''}`;
});
afterAll(async () => {
  if (originalFixturePath === undefined) delete process.env.PATH; else process.env.PATH = originalFixturePath;
  if (fixtureTransportDirectory && !retainedRoots.size) await rm(fixtureTransportDirectory, { recursive: true, force: true });
});

afterEach(async ({ task }) => {
  if (task.result?.state === 'fail') for (const root of roots) retainedRoots.add(root);
  const errors: unknown[] = [];
  for (const run of runs.splice(0)) { const result = await cleanupRun(run); if (result.status !== 'ok') { retainedRoots.add(run.paths.repoRoot); if (!expectedCleanupUncertainty.has(run)) errors.push(result); } }
  for (const root of roots.splice(0)) if (!retainedRoots.has(root)) await rm(root, { recursive: true, force: true });
  if (errors.length) throw new Error(JSON.stringify(errors));
}, 35_000);
async function expectDockerAbsent(kind: 'container' | 'network' | 'image' | 'volume', identity: string): Promise<void> {
  const result = await systemProbe(['docker', kind, 'inspect', identity], 5000);
  expect(result.code).toBe(1); expect(result.stdout.trim()).toBe('[]'); expect(result.stderr).toMatch(/no such|not found/i);
}
async function diagnoseDockerRequest(run: RunContext): Promise<string> {
  const directory = join(await realpath(tmpdir()), 'swc-r3-transport', run.runId); await safeDirectory(directory, true);
  await atomicPrivateFile(directory, 'host.json', JSON.stringify({ at: new Date().toISOString(), load: loadavg(), parallelism: availableParallelism(), freeMemory: freemem(), totalMemory: totalmem(), remainingMs: run.deadlineMs - performance.now(), aborted: run.signal.aborted }), true);
  const failureBytes = await readFile(join(run.paths.privateDir, 'docker-last-request-failure.json')).catch(() => null);
  const trace = await readFile(join(run.paths.privateDir, 'docker-request-trace.json')).catch(() => null);
  if (trace) await atomicPrivateFile(directory, 'request-trace.json', trace, true);
  if (!failureBytes) return directory;
  await atomicPrivateFile(directory, 'failed-request.json', failureBytes, true);
  const failure: { method: string; path: string } = JSON.parse(failureBytes.toString('utf8'));
  const ledger: { endpoint: string } = JSON.parse(await readFile(join(run.paths.privateDir, 'docker.json'), 'utf8'));
  if (failure.method !== 'GET') return directory;
  const socket = decodeURIComponent(new URL(ledger.endpoint).pathname);
  await atomicPrivateFile(directory, 'curl-body.json', '', true); await atomicPrivateFile(directory, 'curl-headers.txt', '', true);
  const curlStart = performance.now();
  const curl = await systemProbe(['curl', '--unix-socket', socket, '--max-time', '5', '--silent', '--show-error', '--dump-header', join(directory, 'curl-headers.txt'), '--output', join(directory, 'curl-body.json'), '--write-out', '%{http_code}', `http://localhost${failure.path}`], 7000).catch(() => ({ code: -1, stdout: '', stderr: 'probe failed' }));
  await atomicPrivateFile(directory, 'curl-result.json', JSON.stringify({ ...curl, elapsedMs: performance.now() - curlStart }), true);
  const script = join(directory, 'minimal-request.mjs');
  await atomicPrivateFile(directory, 'minimal-request.mjs', `import http from 'node:http';import {createHash} from 'node:crypto';const [socketPath,path]=process.argv.slice(2);const started=performance.now();const result={events:[],status:null,bytes:0,complete:false};const event=name=>result.events.push({event:name,elapsedMs:performance.now()-started});const request=http.request({socketPath,path,method:'GET',headers:{Host:'localhost'},agent:false,signal:AbortSignal.timeout(5000)},response=>{event('headers');result.status=response.statusCode;const chunks=[];response.on('data',chunk=>{event('data');result.bytes+=chunk.length;chunks.push(chunk)});response.on('end',()=>{event('body-end');result.complete=response.complete;result.sha256=createHash('sha256').update(Buffer.concat(chunks)).digest('hex');process.stdout.write(JSON.stringify(result)+'\\n')});response.on('error',error=>{event('response-error');result.error={name:error.name,code:error.code};process.stdout.write(JSON.stringify(result)+'\\n')})});request.on('socket',socket=>{event('socket');socket.on('connect',()=>event('connect'))});request.on('finish',()=>event('request-sent'));request.on('error',error=>{event('request-error');result.error={name:error.name,code:error.code};process.stdout.write(JSON.stringify(result)+'\\n')});request.end();`, true);
  const minimal = await systemProbe([process.execPath, script, socket, failure.path], 7000).catch(() => ({ code: -1, stdout: '', stderr: 'probe failed' }));
  await atomicPrivateFile(directory, 'node-result.json', JSON.stringify(minimal), true);
  return directory;
}
test('image VOLUME permits bounded data tmpfs and rejects protected path overlaps', () => {
  const image = (volumes: Record<string, object>, workingDir = '/app') => ({ Id: `sha256:${'a'.repeat(64)}`, Config: { WorkingDir: workingDir, Volumes: volumes, Entrypoint: ['/usr/bin/node'] } });
  expect(declaredTmpfs(image({ '/data': {} }))).toEqual(['/data']);
  for (const path of ['/', '/app', '/app/source', '/usr', '/swc-state', '/swc-inputs/helper', '/data/../app', '/data:bad']) expect(() => declaredTmpfs(image({ [path]: {} }))).toThrow();
});
test.skipIf(process.env.SWC_DOCKER_TESTS !== '1')('owned buildx builder, state volume, network, and final image are removed after cancellation', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'swc-docker-'))); roots.push(root);
  const controller = new AbortController();
  const run = await createRunContext({ repoRoot: root, timeoutMs: 180_000, signal: controller.signal, diagnostics: { event() {} } }); runs.push(run);
  await writeFile(join(root, 'Dockerfile'), 'FROM scratch\nCOPY value /value\n'); await writeFile(join(root, 'value'), 'bound-source');
  const workspace: Workspace = { side: 'before', root, commit: 'a'.repeat(40), kind: 'commit', label: 'before', materializedHash: 'b'.repeat(64), inventory: [], sourceSettings: { generatedDirs: [], maxFiles: 10000, maxBytes: 1024 * 1024 } };
  const unrelated = await systemProbe(['docker', 'buildx', 'ls', '--format', '{{.Name}}'], 15_000); expect(unrelated.code).toBe(0);
  const docker = await DockerRuntime.create(run); await docker.network('before');
  const built = await docker.build(workspace, '.', 'Dockerfile'); expect(built.imageId).toMatch(/^sha256:/);
  const ledger = JSON.parse(await readFile(join(run.paths.privateDir, 'docker.json'), 'utf8'));
  expect(ledger.resources.some((resource: {kind: string}) => resource.kind === 'builder')).toBe(true);
  controller.abort(new Error('test cancellation'));
  expect(await cleanupRun(run)).toEqual({ status: 'ok', errors: [] });
  for (const resource of ledger.resources) {
    if (resource.kind === 'builder') {
      expect((await systemProbe(['docker', 'container', 'ls', '-aq', '--filter', `name=^/${resource.containerName}$`], 5000)).stdout.trim()).toBe('');
      expect((await systemProbe(['docker', 'volume', 'ls', '-q', '--filter', `name=^${resource.volumeName}$`], 5000)).stdout.trim()).toBe('');
    } else await expectDockerAbsent(resource.kind, resource.id);
  }
  expect((await systemProbe(['docker', 'buildx', 'ls', '--format', '{{.Name}}'], 15_000)).stdout).toBe(unrelated.stdout);
}, 180_000);

test.skipIf(process.env.SWC_DOCKER_TESTS !== '1')('application container validates unequal ports, tmpfs VOLUME, exact mounts, image identity and exit monitoring', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'swc-docker-app-'))); roots.push(root);
  const run = await createRunContext({ repoRoot: root, timeoutMs: 180_000, signal: new AbortController().signal, diagnostics: { event() {} } }); runs.push(run);
  const source = join(run.paths.tempDir, 'before'); await (await import('node:fs/promises')).mkdir(source);
  await writeFile(join(source, 'Dockerfile'), await readFile(new URL('../../fixtures/services/Dockerfile.runtime', import.meta.url)));
  await writeFile(join(source, 'run-container.sh'), await readFile(new URL('../../fixtures/services/run-container.sh', import.meta.url)));
  const workspace: Workspace = { side: 'before', root: source, commit: 'a'.repeat(40), kind: 'commit', label: 'before', materializedHash: 'b'.repeat(64), inventory: [], sourceSettings: { generatedDirs: [], maxFiles: 10000, maxBytes: 1024 * 1024 } };
  const docker = await DockerRuntime.create(run); const network = await docker.network('before'); const build = await docker.build(workspace, '.', 'Dockerfile'); expect(build.baseImages.length).toBeGreaterThan(0);
  const { allocatePorts } = await import('../../src/runtime/index.js'); const [port] = await allocatePorts(1); if (!port) throw new Error('Missing test port');
  const { prepareInputs } = await import('../../src/runtime/recipe.js');
  const inputs = await prepareInputs({ inputs: [] }, run, 'before', new Map());
  const origin = `http://127.0.0.1:${port}`;
  const app = await docker.container({ side: 'before', image: build.imageId, network, alias: 'application', port, containerPort: 8080, env: { PORT: '8080', APP_ORIGIN: origin, DATA: '/swc-state', LOG_VALUE: 'docker-secret-without-a-key' }, inputs });
  let value: unknown;
  for (let attempts = 0; attempts < 40; attempts++) { try { value = await (await fetch(origin)).json(); break; } catch { await new Promise((resolve) => setTimeout(resolve, 100)); } }
  expect(value).toEqual({ port: '8080', origin, state: '/swc-state' }); expect(port).not.toBe(8080); await app.verify(true);
  const logDriver = await systemProbe(['docker', 'container', 'inspect', app.id, '--format', '{{.HostConfig.LogConfig.Type}}'], 5000); expect(logDriver.code).toBe(0); expect(logDriver.stdout.trim()).toBe('none');
  const outside = await systemProbe(['docker', 'container', 'ls', '-aq', '--filter', `id=${app.id}`], 5000); expect(outside.stdout.trim()).toBe(app.id.slice(0, 12));
  expect((await cleanupRun(run)).status).toBe('ok'); expect(await app.exited).toMatchObject({ spawnError: null });
  const logs = await (await import('node:fs/promises')).readdir(run.paths.privateDir); const output = (await Promise.all(logs.filter((name) => name.endsWith('.log')).map((name) => readFile(join(run.paths.privateDir, name), 'utf8')))).join('');
  expect(output).not.toContain('docker-secret-without-a-key'); expect(output).toContain('[redacted]');
}, 180_000);

test.skipIf(process.env.SWC_DOCKER_TESTS !== '1')('forced owner kill during a build recovers exact builder resources and repeated absence checks are safe', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'swc-docker-killed-')));
  expect((await systemProbe(['git', 'init', root], 5000)).code).toBe(0);
  expect((await systemProbe(['git', '-C', root, '-c', 'user.name=Synthetic Test', '-c', 'user.email=synthetic@example.invalid', '-c', 'commit.gpgSign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '--allow-empty', '-m', 'Initialize owned runtime fixture'], 5000)).code).toBe(0);
  const loader = join(root, 'owner.mjs');
  const base = new URL('../../src/runtime/', import.meta.url).href;
  const dockerfile = 'FROM busybox@sha256:a7dbc319b1438115a207e11930dc4bb3e643dcb3ec0bdd694bb36cd8fad289ec\nRUN sleep 60\n';
  await writeFile(loader, `import {registerHooks} from 'node:module';import {mkdir,writeFile} from 'node:fs/promises';import {join} from 'node:path';registerHooks({resolve(s,c,n){if(c.parentURL?.includes('/src/')&&s.startsWith('.')&&s.endsWith('.js'))return n(s.replace(/\\.js$/,'.ts'),c);return n(s,c)}});const {createRunContext}=await import(${JSON.stringify(base + 'context.ts')});const {DockerRuntime}=await import(${JSON.stringify(base + 'docker.ts')});const run=await createRunContext({repoRoot:${JSON.stringify(root)},timeoutMs:120000,signal:new AbortController().signal,diagnostics:{event(){}}});process.stdout.write(run.runId+'\\n');const source=join(run.paths.tempDir,'before');await mkdir(source);await writeFile(join(source,'Dockerfile'),${JSON.stringify(dockerfile)});const docker=await DockerRuntime.create(run,true);await docker.build({side:'before',root:source,commit:'a'.repeat(40),kind:'commit',label:'synthetic',materializedHash:'b'.repeat(64),inventory:[],sourceSettings:{generatedDirs:[],maxFiles:10000,maxBytes:1048576}},'.','Dockerfile');`);
  const child = spawn(process.execPath, ['--no-warnings', '--experimental-transform-types', loader], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = ''; child.stdout.on('data', (chunk: Buffer) => { stdout += chunk; }); child.stderr.on('data', (chunk: Buffer) => { stderr += chunk; });
  const ended = new Promise<void>((resolve) => child.once('close', () => resolve()));
  let runId = ''; let builder: { containerName: string; volumeName: string } | undefined;
  try {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && child.exitCode === null) {
      runId = stdout.trim();
      if (runId) {
        try {
          const ledger: { resources: { kind: string; containerId?: string; containerName: string; volumeName: string }[] } = JSON.parse(await readFile(join(root, '.show-what-changed', 'runs', runId, 'private', 'docker.json'), 'utf8'));
          const processes: { group: number }[] = JSON.parse(await readFile(join(root, '.show-what-changed', 'runs', runId, 'private', 'processes.json'), 'utf8'));
          const selected = ledger.resources.find((resource) => resource.kind === 'builder' && resource.containerId);
          if (selected && processes.length >= 4) { builder = selected; break; }
        } catch { /* Ownership records are atomic and may not exist until initialization finishes. */ }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(builder, stdout + stderr).toBeDefined(); if (!builder) throw new Error('Missing builder identity');
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(child.kill('SIGKILL')).toBe(true); await ended;
    const runDir = join(root, '.show-what-changed', 'runs', runId);
    const { assertInactive, cleanOwnedRun, readOwner } = await import('../../src/runtime/ownership.js');
    const inactiveUntil = Date.now() + 10_000;
    while (true) { try { await assertInactive(await readOwner(runDir)); break; } catch (error) { if (Date.now() >= inactiveUntil) throw error; await new Promise((resolve) => setTimeout(resolve, 100)); } }
    await expect(DockerRuntime.recover(runDir, runId)).rejects.toMatchObject({ detail: { code: 'DOCKER_CREATION_UNCERTAIN' } });
    expect(JSON.parse(await readFile(join(runDir, 'private', 'docker.json'), 'utf8')).pendingCreates.length).toBeGreaterThan(0);
    await expectDockerAbsent('container', builder.containerName);
    await expectDockerAbsent('volume', builder.volumeName);
    await expect(cleanOwnedRun(root, runId)).rejects.toMatchObject({ detail: { code: 'DOCKER_CREATION_UNCERTAIN' } }); retainedRoots.add(root);
    expect(await readFile(join(root, '.show-what-changed', 'run.lock', 'owner.json'), 'utf8')).toContain(runId);
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await ended; }
}, 120_000);

test.skipIf(process.env.SWC_DOCKER_TESTS !== '1')('generic runtime binds seeded independent container datasets and setup-generated image content', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'swc-docker-recipe-'))); roots.push(root);
  for (const argv of [['git', 'init', root], ['git', '-C', root, 'config', 'user.name', 'Synthetic Test'], ['git', '-C', root, 'config', 'user.email', 'synthetic@example.invalid']]) expect((await systemProbe(argv, 5000)).code).toBe(0);
  await writeFile(join(root, '.gitignore'), '.show-what-changed/\n');
  await writeFile(join(root, 'Dockerfile'), await readFile(new URL('../fixtures/r8-docker-Dockerfile', import.meta.url)));
  await writeFile(join(root, 'run-container.sh'), await readFile(new URL('../fixtures/r8-docker-run.sh', import.meta.url)));
  await writeFile(join(root, 'setup.cjs'), await readFile(new URL('../fixtures/r8-docker-setup.cjs', import.meta.url)));
  const seed = await readFile(new URL('../fixtures/r8-docker-seed.json', import.meta.url));
  await writeFile(join(root, 'seed.json'), seed);
  await writeFile(join(root, 'bootstrap.cjs'), "fetch(process.env.APP_ORIGIN).then(r=>r.text()).then(value=>require('node:fs').writeFileSync(process.env.DATA+'/bootstrap.json',value))");
  process.env.SWC_CONTAINER_TEST_PASSWORD = 'synthetic-local-only';
  const config = { schemaVersion: 2, source: { generatedDirs: ['generated'] }, execution: { inputs: [{ id: 'seed', path: join(root, 'seed.json') }], env: { SIDE: { template: '{side}' }, SEED: { template: '{input.seed}' }, PORT: { template: '{port}' }, APP_ORIGIN: { template: '{origin}' }, DATA: { template: '{stateDir}' }, DB_HOST: { template: '{service.db.host}' }, DB_PORT: { template: '{service.db.port}' } }, services: [{ id: 'db', kind: 'container', image: 'postgres@sha256:979c4379dd698aba0b890599a6104e082035f98ef31d9b9291ec22f2b13059ca', containerPort: 5432, env: { POSTGRES_PASSWORD: { fromEnv: 'SWC_CONTAINER_TEST_PASSWORD' }, POSTGRES_USER: { literal: 'synthetic' }, POSTGRES_DB: { literal: 'synthetic' } }, ready: { kind: 'tcp', timeoutMs: 30_000 } }], requires: [{ argv: [process.execPath, '--version'], expectedVersion: '24.x' }], setup: [{ argv: [process.execPath, 'setup.cjs'] }], start: { kind: 'container', build: { context: '.', dockerfile: 'Dockerfile' }, containerPort: 8080 }, ready: { timeoutMs: 10_000 }, bootstrap: [{ argv: [process.execPath, 'bootstrap.cjs'] }], state: { kind: 'isolated', seedId: 'seed' } } };
  await writeFile(join(root, 'show-what-changed.json'), JSON.stringify(config));
  for (const argv of [['git', '-C', root, 'add', '.'], ['git', '-C', root, 'commit', '-m', 'Synthetic container recipe']]) expect((await systemProbe(argv, 5000)).code).toBe(0);
  const { plan } = await import('../../src/planner/index.js'); const { prepare, verify } = await import('../../src/workspace/index.js'); const { start } = await import('../../src/runtime/index.js');
  const selected = await plan({ invocationDir: root, base: 'HEAD', head: 'HEAD', routes: ['/'], configPath: join(root, 'show-what-changed.json') }, new AbortController().signal);
  expect(selected.inputs.find((input) => input.id === 'seed')?.sha256).toBe(sha256(seed));
  const callerIndex = await readFile(join(root, '.git/index'));
  const callerStatus = await systemProbe(['git', '-C', root, 'status', '--porcelain=v1', '--untracked-files=all'], 5000);
  const callerWorktrees = await systemProbe(['git', '-C', root, 'worktree', 'list', '--porcelain'], 5000);
  expect(callerStatus.code).toBe(0); expect(callerWorktrees.code).toBe(0);
  const run = await createRunContext({ repoRoot: root, timeoutMs: 180_000, signal: new AbortController().signal, diagnostics: { event() {} } }); runs.push(run);
  try {
    const workspaces = await prepare(selected, run); const result = await start(workspaces, selected, run);
    const ledger: { runId: string; endpoint: string } = JSON.parse(await readFile(join(run.paths.privateDir, 'docker.json'), 'utf8'));
    expect(ledger.runId).toBe(run.runId); expect(ledger.endpoint).toMatch(/^unix:\/\/\//);
    const dockerProbe = (args: readonly string[]) => systemProbe(['docker', '--config', join(run.paths.privateDir, 'docker-client'), '--host', ledger.endpoint, ...args], 5000, run.signal);
    const services = new Map<'before' | 'after', string>();
    const buildEvidence = new Map<'before' | 'after', { imageId: string; generatedSha256: string; observed: unknown }>();
    for (const side of ['before', 'after'] as const) {
      const server = result.servers[side]; const value = await (await fetch(server.origin)).json();
      expect(value).toEqual({ port: '8080', origin: server.origin, state: '/swc-state', dbHost: 'service-db', dbPort: '5432', generated: { side, seedSha256: sha256(seed) } });
      expect(result.provenance[side]).toMatchObject({ kind: 'container', state: 'isolated', seedId: 'seed', dependencyReproducibility: 'unverified', services: [{ id: 'db', kind: 'container' }] });
      const provenance = result.provenance[side]; if (provenance.kind !== 'container') throw new Error('Missing container build provenance');
      const generated = await readFile(join(workspaces[side].root, 'generated/runtime.json'));
      expect(JSON.parse(generated.toString('utf8'))).toEqual(value.generated);
      buildEvidence.set(side, { imageId: provenance.imageId, generatedSha256: sha256(generated), observed: value.generated });
      const service = provenance.services.find((entry) => entry.id === 'db'); if (!service) throw new Error('Missing owned database service');
      expect(service.identity).toMatch(/^[a-f0-9]{64}$/); services.set(side, service.identity);
      const inspect = await dockerProbe(['container', 'inspect', service.identity]); expect(inspect.code).toBe(0);
      expect(JSON.parse(inspect.stdout)[0]).toMatchObject({ Id: service.identity, Config: { Labels: { 'io.show-what-changed.run': run.runId, 'io.show-what-changed.side': side } } });
      const directories = await readdir(join(run.paths.privateDir, 'execution', side)); expect(directories).toHaveLength(1);
      const directory = directories[0]; if (!directory) throw new Error('Missing private side input copy');
      const copiedSeed = await readFile(join(run.paths.privateDir, 'execution', side, directory, 'inputs/seed.json'));
      expect(copiedSeed).toEqual(seed); expect(sha256(copiedSeed)).toBe(selected.inputs.find((input) => input.id === 'seed')?.sha256);
      const dataset = JSON.parse(copiedSeed.toString('utf8')); expect(dataset).toEqual({ value: 7 });
      const initialized = await dockerProbe(['container', 'exec', service.identity, 'psql', '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-U', 'synthetic', '-d', 'synthetic', '-c', `CREATE TABLE r8_seed(value integer NOT NULL); INSERT INTO r8_seed(value) VALUES (${dataset.value});`]);
      expect(initialized.code, initialized.stderr).toBe(0);
    }
    expect(result.provenance.before.services[0]?.identity).not.toBe(result.provenance.after.services[0]?.identity);
    expect(buildEvidence.get('before')?.generatedSha256).not.toBe(buildEvidence.get('after')?.generatedSha256);
    const query = async (side: 'before' | 'after', sql: string) => {
      const identity = services.get(side); if (!identity) throw new Error('Missing exact database identity');
      const response = await dockerProbe(['container', 'exec', identity, 'psql', '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-U', 'synthetic', '-d', 'synthetic', '-c', sql]);
      expect(response.code, response.stderr).toBe(0); return response.stdout.trim();
    };
    const initial = { before: await query('before', 'SELECT value FROM r8_seed;'), after: await query('after', 'SELECT value FROM r8_seed;') };
    expect(initial).toEqual({ before: '7', after: '7' });
    await query('before', 'UPDATE r8_seed SET value = 99;');
    const diverged = { before: await query('before', 'SELECT value FROM r8_seed;'), after: await query('after', 'SELECT value FROM r8_seed;') };
    expect(diverged).toEqual({ before: '99', after: '7' });
    await atomicPrivateFile(run.paths.privateDir, 'r8-seeded-image-observations.json', JSON.stringify({ endpoint: ledger.endpoint, seedSha256: sha256(seed), services: Object.fromEntries(services), initial, diverged, builds: Object.fromEntries(buildEvidence), initialization: 'test controller psql through exact owned service IDs using the validated bound seed value' }), false);
    expect(await verify(workspaces, run)).toMatchObject({ before: { valid: true }, after: { valid: true } });
    expect(await cleanupRun(run)).toEqual({ status: 'ok', errors: [] });
    expect(await readFile(join(root, '.git/index'))).toEqual(callerIndex);
    const finalStatus = await systemProbe(['git', '-C', root, 'status', '--porcelain=v1', '--untracked-files=all'], 5000);
    const finalWorktrees = await systemProbe(['git', '-C', root, 'worktree', 'list', '--porcelain'], 5000);
    expect(finalStatus.code).toBe(0); expect(finalStatus.stdout).toBe(callerStatus.stdout);
    expect(finalWorktrees.code).toBe(0); expect(finalWorktrees.stdout).toBe(callerWorktrees.stdout);
    expect(await readFile(join(root, 'seed.json'))).toEqual(seed);
  } catch (error) { const directory = await diagnoseDockerRequest(run); throw new Error(`Synthetic Docker diagnostic retained at ${directory}`, { cause: error }); }
  finally { delete process.env.SWC_CONTAINER_TEST_PASSWORD; }
}, 240_000);

test.skipIf(process.env.SWC_DOCKER_TESTS !== '1')('early container exit removes exact owned container and network without deleting a shared image', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'swc-docker-failed-'))); roots.push(root);
  const run = await createRunContext({ repoRoot: root, timeoutMs: 60_000, signal: new AbortController().signal, diagnostics: { event() {} } }); runs.push(run);
  const docker = await DockerRuntime.create(run); const network = await docker.network('before');
  const image = await docker.image('busybox@sha256:a7dbc319b1438115a207e11930dc4bb3e643dcb3ec0bdd694bb36cd8fad289ec');
  const { prepareInputs } = await import('../../src/runtime/recipe.js'); const inputs = await prepareInputs({ inputs: [] }, run, 'before', new Map());
  const { allocatePorts } = await import('../../src/runtime/index.js'); const [port] = await allocatePorts(1, new Set(), run); if (!port) throw new Error('Missing owned test port');
  const container = await docker.container({ side: 'before', image: image.Id, network, alias: 'application', port, containerPort: 8080, env: {}, inputs }).catch((cause: unknown) => {
    if (!(cause instanceof ToolFailure) || cause.detail.code !== 'CONTAINER_EXITED') throw cause;
    return null;
  });
  if (container) {
    await beforeDeadline(container.exited, run.deadlineMs);
    await expect(container.verify(true)).rejects.toMatchObject({ detail: { code: 'CONTAINER_EXITED' } });
  }
  expect(await cleanupRun(run)).toEqual({ status: 'ok', errors: [] });
  expect((await systemProbe(['docker', 'image', 'inspect', image.Id], 5000)).code).toBe(0);
}, 60_000);

test.skipIf(process.env.SWC_DOCKER_TESTS !== '1')('overall deadline interrupts a build and cleanup uses its independent budget', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'swc-docker-deadline-'))); roots.push(root);
  const run = await createRunContext({ repoRoot: root, timeoutMs: 20_000, signal: new AbortController().signal, diagnostics: { event() {} } }); runs.push(run);
  const source = join(run.paths.tempDir, 'before'); await (await import('node:fs/promises')).mkdir(source);
  await writeFile(join(source, 'Dockerfile'), 'FROM busybox@sha256:a7dbc319b1438115a207e11930dc4bb3e643dcb3ec0bdd694bb36cd8fad289ec\nRUN sleep 60\n');
  const workspace: Workspace = { side: 'before', root: source, commit: 'a'.repeat(40), kind: 'commit', label: 'before', materializedHash: 'b'.repeat(64), inventory: [], sourceSettings: { generatedDirs: [], maxFiles: 10000, maxBytes: 1024 * 1024 } };
  const docker = await DockerRuntime.create(run, true);
  await expect(docker.build(workspace, '.', 'Dockerfile')).rejects.toMatchObject({ exitCode: 10, detail: { code: 'DEADLINE_EXCEEDED' } });
  expect(run.signal.aborted).toBe(true); expect((await cleanupRun(run)).status).toBe('failed'); retainedRoots.add(root);
  const ledger = JSON.parse(await readFile(join(run.paths.privateDir, 'docker.json'), 'utf8')); expect(ledger.pendingCreates.length).toBeGreaterThan(0);
  expect(await readFile(join(root, '.show-what-changed', 'run.lock', 'owner.json'), 'utf8')).toContain(run.runId);
  for (const resource of ledger.resources) if (resource.kind === 'builder' && resource.containerId) { await expectDockerAbsent('container', resource.containerName); await expectDockerAbsent('volume', resource.volumeName); }
  expectedCleanupUncertainty.add(run);
}, 60_000);

test.skipIf(process.env.SWC_DOCKER_TESTS !== '1')('interrupted network creation reconciles exact labels before an ID was recorded', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'swc-docker-create-')));
  let realDocker: string | undefined;
  for (const directory of (process.env.PATH ?? '').split(':')) { try { realDocker = await realpath(join(directory, 'docker')); break; } catch { /* Select the installed Docker executable before overriding the test PATH. */ } }
  if (!realDocker) throw new Error('Docker executable is unavailable');
  const bin = join(root, 'bin'); await (await import('node:fs/promises')).mkdir(bin); const created = join(root, 'created.json');
  const wrapper = join(bin, 'docker');
  await writeFile(wrapper, `#!${process.execPath}\nconst {spawnSync}=require('node:child_process');const {writeFileSync}=require('node:fs');const args=process.argv.slice(2);const result=spawnSync(${JSON.stringify(realDocker)},args,{encoding:'utf8',env:process.env});if(result.status===0&&args.includes('network')&&args.includes('create')){writeFileSync(${JSON.stringify(created)},JSON.stringify({id:result.stdout.trim()}));setInterval(()=>{},1000)}else{process.stdout.write(result.stdout||'');process.stderr.write(result.stderr||'');process.exit(result.status??1)}\n`); await chmod(wrapper, 0o700);
  const loader = join(root, 'owner.mjs'); const base = new URL('../../src/runtime/', import.meta.url).href;
  await writeFile(loader, `import {registerHooks} from 'node:module';registerHooks({resolve(s,c,n){if(c.parentURL?.includes('/src/')&&s.startsWith('.')&&s.endsWith('.js'))return n(s.replace(/\\.js$/,'.ts'),c);return n(s,c)}});const {createRunContext}=await import(${JSON.stringify(base+'context.ts')});const {DockerRuntime}=await import(${JSON.stringify(base+'docker.ts')});const run=await createRunContext({repoRoot:${JSON.stringify(root)},timeoutMs:60000,signal:new AbortController().signal,diagnostics:{event(){}}});process.stdout.write(run.runId+'\\n');const docker=await DockerRuntime.create(run);await docker.network('before');`);
  const child = spawn(process.execPath, ['--no-warnings', '--experimental-transform-types', loader], { cwd: root, env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = ''; child.stdout.on('data', (chunk: Buffer) => { stdout += chunk; }); child.stderr.on('data', (chunk: Buffer) => { stderr += chunk; }); const ended = new Promise<void>((resolve) => child.once('close', () => resolve()));
  try {
    const until = Date.now() + 30_000; let id: string | undefined;
    while (Date.now() < until && child.exitCode === null) { try { const value: {id:string} = JSON.parse(await readFile(created, 'utf8')); id = value.id; break; } catch { await new Promise((resolve) => setTimeout(resolve, 100)); } }
    expect(id, stdout + stderr).toMatch(/^[a-f0-9]{64}$/); const runId = stdout.trim(); const runDir = join(root, '.show-what-changed', 'runs', runId);
    const ledger: { resources: { kind:string; id:string|null }[] } = JSON.parse(await readFile(join(runDir, 'private', 'docker.json'), 'utf8'));
    expect(ledger.resources).toMatchObject([{ kind:'network', id:null }]);
    child.kill('SIGKILL'); await ended;
    const { assertInactive, readOwner } = await import('../../src/runtime/ownership.js'); const inactiveUntil = Date.now() + 10_000;
    while (true) { try { await assertInactive(await readOwner(runDir)); break; } catch (error) { if (Date.now() >= inactiveUntil) throw error; await new Promise((resolve) => setTimeout(resolve, 100)); } }
    expect(await DockerRuntime.recover(runDir, runId)).toBe(true); expect(await DockerRuntime.recover(runDir, runId)).toBe(false);
    if (!id) throw new Error('Missing observed network identity'); await expectDockerAbsent('network', id); roots.push(root);
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await ended; }
}, 60_000);

test.skipIf(process.env.SWC_DOCKER_TESTS !== '1')('confirmed orphan builder volume recovery preserves an unrelated builder and image', async () => {
  const prepare = async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'swc-docker-orphan-'))); roots.push(root);
    const run = await createRunContext({ repoRoot: root, timeoutMs: 180_000, signal: new AbortController().signal, diagnostics: { event() {} } }); runs.push(run);
    await writeFile(join(root, 'Dockerfile'), 'FROM scratch\nCOPY value /value\n'); await writeFile(join(root, 'value'), 'synthetic-orphan-recovery');
    const workspace: Workspace = { side: 'before', root, commit: 'a'.repeat(40), kind: 'commit', label: 'synthetic', materializedHash: 'b'.repeat(64), inventory: [], sourceSettings: { generatedDirs: [], maxFiles: 10000, maxBytes: 1024 * 1024 } };
    const docker = await DockerRuntime.create(run, true); const built = await docker.build(workspace, '.', 'Dockerfile');
    const ledger: { endpoint: string; resources: { kind: string; name: string; containerId: string; containerName: string; volumeName: string; volumeCreatedAt: string }[] } = JSON.parse(await readFile(join(run.paths.privateDir, 'docker.json'), 'utf8'));
    const builder = ledger.resources.find((resource) => resource.kind === 'builder'); if (!builder) throw new Error('Missing confirmed test builder');
    expect(builder.containerId).toMatch(/^[a-f0-9]{64}$/); expect(builder.volumeCreatedAt).not.toBe('');
    const definitionPath = join(run.paths.privateDir, 'docker-client', 'buildx', 'instances', builder.name); const definition = await readFile(definitionPath, 'utf8');
    return { run, built, builder, ledger, definitionPath, definition };
  };
  const sentinel = await prepare(); const target = await prepare();
  const before = await systemProbe(['docker', 'container', 'inspect', target.builder.containerId], 5000); expect(before.code).toBe(0);
  expect(JSON.parse(before.stdout)[0]).toMatchObject({ Id: target.builder.containerId, Name: `/${target.builder.containerName}`, Mounts: [{ Name: target.builder.volumeName, Destination: '/var/lib/buildkit' }] });
  const removed = await new Promise<number>((resolve, reject) => {
    const call = request({ socketPath: decodeURIComponent(new URL(target.ledger.endpoint).pathname), path: `/containers/${target.builder.containerId}?force=1&v=0`, method: 'DELETE', agent: false, signal: AbortSignal.timeout(5000) }, (response) => { response.resume(); response.once('end', () => response.complete ? resolve(response.statusCode ?? 0) : reject(new Error('Incomplete removal response'))); response.once('error', reject); });
    call.once('error', reject); call.end();
  });
  expect(removed).toBe(204); await expectDockerAbsent('container', target.builder.containerName);
  const orphan = await systemProbe(['docker', 'volume', 'inspect', target.builder.volumeName], 5000); expect(orphan.code).toBe(0);
  expect(JSON.parse(orphan.stdout)[0]).toMatchObject({ Name: target.builder.volumeName, Driver: 'local', CreatedAt: target.builder.volumeCreatedAt });
  expect(await readFile(target.definitionPath, 'utf8')).toBe(target.definition);
  expect(await target.run.supervisor.stopAll()).toEqual({ status: 'ok', errors: [] });
  expect(await DockerRuntime.recover(target.run.paths.runDir, target.run.runId)).toBe(true);
  await expectDockerAbsent('container', target.builder.containerName); await expectDockerAbsent('volume', target.builder.volumeName); await expectDockerAbsent('image', target.built.imageId);
  await expect(readFile(target.definitionPath)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await DockerRuntime.recover(target.run.paths.runDir, target.run.runId)).toBe(false);
  const survivingContainer = await systemProbe(['docker', 'container', 'inspect', sentinel.builder.containerId], 5000); expect(survivingContainer.code).toBe(0);
  expect(JSON.parse(survivingContainer.stdout)[0]).toMatchObject({ Id: sentinel.builder.containerId, Name: `/${sentinel.builder.containerName}` });
  const survivingVolume = await systemProbe(['docker', 'volume', 'inspect', sentinel.builder.volumeName], 5000); expect(survivingVolume.code).toBe(0);
  expect(JSON.parse(survivingVolume.stdout)[0]).toMatchObject({ Name: sentinel.builder.volumeName, CreatedAt: sentinel.builder.volumeCreatedAt });
  expect((await systemProbe(['docker', 'image', 'inspect', sentinel.built.imageId], 5000)).code).toBe(0);
  expect(await readFile(sentinel.definitionPath, 'utf8')).toBe(sentinel.definition);
}, 180_000);
