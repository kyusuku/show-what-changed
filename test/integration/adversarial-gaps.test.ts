import { execFile, spawn } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { PNG } from 'pngjs';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { selectScenarios } from '../../src/planner/routes.js';
import { plan } from '../../src/planner/index.js';
import { compare, compose } from '../../src/runner/index.js';
import * as publicArtifacts from '../../src/runner/artifacts.js';
import { cleanupRun, createRunContext } from '../../src/runtime/context.js';
import { artifactInfo, writeRunFile } from '../../src/runtime/files.js';
import { cleanOwnedRun } from '../../src/runtime/ownership.js';
import { groupMembers } from '../../src/runtime/process-table.js';
import { listeners, start } from '../../src/runtime/index.js';
import { prepare } from '../../src/workspace/index.js';
import { CaptureBundleSchema, ManifestSchema, parseConfig, TimelineSchema } from '../../src/schema/index.js';
import { digest, sha256 } from '../../src/schema/io.js';
import { buildPresentation } from '../../src/composer/presentation.js';
import type { RunContext, SourceInspection } from '../../src/schema/contracts.js';

const execute = promisify(execFile);
const roots: string[] = [];
const runs: RunContext[] = [];
const sourceCli = new URL('../../src/cli/index.ts', import.meta.url).href;
const sourceLoader = "import {registerHooks} from 'node:module';registerHooks({resolve(specifier,context,next){if(context.parentURL?.includes('/src/')&&specifier.startsWith('.')&&specifier.endsWith('.js'))return next(specifier.replace(/\\.js$/,'.ts'),context);return next(specifier,context)}});await import(process.argv[1]);";
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const exists = (path: string) => stat(path).then(() => true, () => false);
function gate(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((ready) => { resolve = ready; });
  return { promise, resolve };
}
async function root(): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'swc-adversarial-')));
  roots.push(path);
  return path;
}
async function git(path: string, ...args: string[]): Promise<string> {
  return (await execute('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args], { cwd: path })).stdout.trim();
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const run of runs.splice(0)) await cleanupRun(run);
  for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true });
});

function inspection(paths: string[], changes: string[]): SourceInspection {
  const inventory = paths.map((path) => ({ path, exists: true as const, executable: false, byteLength: 1, sha256: 'a'.repeat(64) }));
  return {
    repoRoot: '/fixture', requestedBase: 'HEAD', requestedHead: 'WORKTREE', baseCommit: 'a'.repeat(40), headCommit: 'b'.repeat(40),
    baseResolution: 'exact', headKind: 'worktree', sourceFingerprint: 'c'.repeat(64), inventories: { before: inventory, after: inventory },
    changedFiles: changes.map((path) => ({ status: 'M', oldPath: path, newPath: path })), stats: { before: { files: inventory.length, bytes: inventory.length, fingerprint: 'a'.repeat(64) }, after: { files: inventory.length, bytes: inventory.length, fingerprint: 'b'.repeat(64) } }, warnings: [],
  };
}

describe('G18 unresolved App Router inputs', () => {
  test.each(['app/api/ping/route.ts', 'app/_private/helper.ts', 'app/shop/_private/layout.tsx', 'app/_private/page.tsx'])('keeps %s unresolved when a real page also changes', (ignored) => {
    const paths = ['app/page.tsx', ignored];
    const result = selectScenarios(inspection(paths, paths), parseConfig({ schemaVersion: 2, execution: { start: { kind: 'process', argv: ['node', 'server.mjs', '{port}'] }, state: { kind: 'stateless' } } }));
    expect(result.coverage.selected.map((candidate) => candidate.path)).toEqual(['/']);
    expect(result.coverage.unresolved.map((entry) => entry.path)).toContain(ignored);
    expect(result.coverage.unsupported).toEqual([]);
    expect(result.coverage.complete).toBe(false);
  });
});

async function savedEncodingFixture(): Promise<RunContext> {
  const path = await root();
  const run = await createRunContext({ repoRoot: path, timeoutMs: 60_000, signal: new AbortController().signal, diagnostics: { event() {} } });
  runs.push(run);
  const bundle = CaptureBundleSchema.parse(JSON.parse(await readFile(new URL('../fixtures/capture.json', import.meta.url), 'utf8')));
  bundle.runId = run.runId;
  const scenario = bundle.scenarios[0];
  const step = scenario?.steps[0];
  if (!scenario || !step) throw new Error('Missing capture fixture');
  step.observeMs = 200;
  const png = new PNG({ width: 1920, height: 686 });
  png.data.fill(128);
  const bytes = PNG.sync.write(png);
  const provenanceSettings = { valid: true, actualHash: 'a'.repeat(64), errors: [] };
  const model = buildPresentation(bundle, { coverage: { selected: [], unresolved: [], omitted: [], unsupported: [], complete: true }, provenance: { before: provenanceSettings, after: provenanceSettings } });
  for (const card of model.cards) await writeRunFile(run, card.image, bytes);
  await writeRunFile(run, 'source/before.png', await readFile(new URL('../fixtures/composer-before.png', import.meta.url)));
  await writeRunFile(run, 'source/after.png', await readFile(new URL('../fixtures/composer-after.png', import.meta.url)));
  const timeline = TimelineSchema.parse({
    schemaVersion: 2, runId: run.runId, captureMode: 'keyframes', fps: 30, templateVersion: 2, width: 1920, height: 686, totalFrames: model.totalFrames, poster: model.poster,
    segments: model.segments, stepBoundaries: model.stepBoundaries, selections: model.selections, annotations: model.annotations, posterSelection: model.posterSelection, viewport: bundle.viewport, captureSha256: digest(bundle),
    images: [...model.cards.map((card) => ({ path: card.image, bytes: bytes.length, sha256: sha256(bytes) })), step.before.image, step.after.image],
  });
  await writeRunFile(run, 'capture.json', JSON.stringify(bundle));
  await writeRunFile(run, 'timeline.json', JSON.stringify(timeline));
  const encodingError = { code: 'ENCODE_FAILED', phase: 'encoding', message: 'Fixture encoding remains pending.', hint: 'Run compose.' };
  const provenance = { valid: true, actualHash: 'a'.repeat(64), errors: [] };
  const manifest = ManifestSchema.parse({
    schemaVersion: 2, specRevision: '0.3', toolVersion: '0.1.0', runId: run.runId, state: 'terminal', status: 'failed', exitCode: 9,
    captureMode: 'keyframes', startedAt: run.startedAt, endedAt: run.startedAt,
    sources: { before: bundle.sources.before, after: bundle.sources.after, baseResolution: 'exact' },
    versions: { node: process.version, browser: bundle.browserVersion, ffmpeg: null, ffprobe: null }, publicRecipeDigest: null, publicScenarioDigest: null, viewport: bundle.viewport, dataParity: 'stateless-declared', execution: null, captureQuality: [],
    coverage: { selected: [{ path: '/probe', reason: 'DIRECT_PAGE_CHANGE', via: ['app/probe/page.tsx'] }], unresolved: [], omitted: [], unsupported: [], complete: true },
    scenarios: bundle.scenarios, summary: { verifiedPairs: 1, changedPairs: 1, expectedAbsences: 0, exclusions: 0, failedSteps: 0, blockedSteps: 0, coverageOmissions: 0 },
    timeline: { fps: 30, totalFrames: 36, templateVersion: 2, width: 1920, height: 686 },
    artifacts: { video: null, poster: null, capture: await artifactInfo(run.paths.runDir, 'capture.json'), timeline: await artifactInfo(run.paths.runDir, 'timeline.json'), pr: null },
    comparisonOutcome: { status: 'ok', capture: 'ok', coverage: 'complete', provenance: { before: provenance, after: provenance } },
    cleanupOutcome: { status: 'ok', errors: [] }, encodingOutcome: { status: 'failed', errors: [encodingError] }, warnings: [], errors: [encodingError], errorHistory: [], phaseTimings: {},
  });
  await writeRunFile(run, 'manifest.json', JSON.stringify(manifest));
  expect((await cleanupRun(run)).status).toBe('ok');
  return run;
}

describe('T13 T14 ownership lasts through terminal public writes', () => {
  test.each(['clean', 'compose'] as const)('refuses concurrent %s while the first command finalizes', async (command) => {
    const run = await savedEncodingFixture();
    const context = { invocationDir: run.paths.repoRoot, timeoutMs: 60_000, signal: new AbortController().signal, consent: { kind: 'deny' as const }, diagnostics: { event() {} } };
    const entered = gate();
    const release = gate();
    const original = publicArtifacts.writePublicArtifacts;
    let first = true;
    vi.spyOn(publicArtifacts, 'writePublicArtifacts').mockImplementation(async (...args) => {
      if (first) { first = false; entered.resolve(); await release.promise; }
      return original(...args);
    });
    const composing = compose(run.paths.runDir, context);
    let concurrent: unknown;
    try {
      await Promise.race([entered.promise, delay(30_000).then(() => { throw new Error('Finalization was not reached'); })]);
      concurrent = command === 'compose' ? await compose(run.paths.runDir, context) : await cleanOwnedRun(run.paths.repoRoot, run.runId).catch((error: unknown) => error);
    } finally { release.resolve(); }
    const result = await composing;
    expect(concurrent).toMatchObject(command === 'compose' ? { exitCode: 2, error: { code: 'RUN_ACTIVE' } } : { exitCode: 2, detail: { code: 'RUN_ACTIVE' } });
    expect(result).toMatchObject({ status: 'ok', exitCode: 0 });
    if (!result.data) throw new Error('Expected terminal manifest');
    for (const artifact of Object.values(result.data.artifacts)) if (artifact) {
      const bytes = await readFile(join(run.paths.runDir, artifact.path));
      expect(bytes.length).toBe(artifact.bytes);
      expect(sha256(bytes)).toBe(artifact.sha256);
    }
    expect(JSON.parse(await readFile(join(run.paths.runDir, 'manifest.json'), 'utf8'))).toEqual(result.data);
    expect(await exists(join(run.paths.repoRoot, '.show-what-changed/run.lock'))).toBe(false);
  }, 60_000);
});

type SignalPhase = 'preparing' | 'starting' | 'recording' | 'encoding';
async function signalFixture(phase: SignalPhase): Promise<{ path: string; scenario: string; wrapper: string }> {
  const path = await root();
  const install = phase === 'preparing' ? "node -e \"require('fs').mkdirSync('node_modules',{recursive:true});require('fs').writeFileSync('node_modules/preparing','ready');setInterval(()=>{},1000)\"" : '';
  const manifest = { name: 'signal-fixture', version: '1.0.0', scripts: install ? { postinstall: install } : {} };
  await writeFile(join(path, 'package.json'), JSON.stringify(manifest));
  await writeFile(join(path, 'package-lock.json'), JSON.stringify({ name: manifest.name, version: manifest.version, lockfileVersion: 3, packages: { '': { name: manifest.name, version: manifest.version, ...(install ? { hasInstallScript: true } : {}) } } }));
  await writeFile(join(path, '.gitignore'), 'node_modules/\n.show-what-changed/\n');
  const server = phase === 'starting'
    ? "import fs from 'node:fs';fs.mkdirSync('node_modules',{recursive:true});fs.writeFileSync('node_modules/starting','ready');setInterval(()=>{},1000);"
    : "import http from 'node:http';import fs from 'node:fs';http.createServer((req,res)=>{if(req.url==='/recording-started'){fs.mkdirSync('node_modules',{recursive:true});fs.writeFileSync('node_modules/recording','ready');res.end('ok');return;}res.setHeader('content-type','text/html');res.end('<h1>Signal fixture</h1><script>fetch(\"/recording-started\")</script>');}).listen(Number(process.argv[2]),'127.0.0.1');";
  await writeFile(join(path, 'server.mjs'), server);
  await writeFile(join(path, 'show-what-changed.config.json'), JSON.stringify({ schemaVersion: 2, execution: { setup: [{ cwd: '.', argv: ['npm', 'ci', '--no-audit', '--no-fund'], timeoutMs: 30_000 }], start: { kind: 'process', argv: [process.execPath, 'server.mjs', '{port}'] }, ready: { timeoutMs: 30_000 }, state: { kind: 'stateless' } }, capture: { mode: 'keyframes', stepTimeoutMs: 10_000, observeMs: 200 } }));
  await git(path, 'init', '-q');
  await git(path, 'config', 'user.name', 'Signal fixture');
  await git(path, 'config', 'user.email', 'fixture@example.invalid');
  await git(path, 'add', '.');
  await git(path, 'commit', '-qm', 'Fixture');
  const scenario = join(path, '.git/scenario.json');
  await writeFile(scenario, JSON.stringify({ schemaVersion: 2, id: 'signal', title: 'Signal fixture', steps: [{ id: 'open', op: 'goto', path: '/' }, ...(phase === 'recording' ? [{ id: 'wait', op: 'expectVisible', target: { testId: 'never-ready' } }] : [])] }));
  const wrapper = join(path, '.git/ffmpeg-proxy.mjs');
  await writeFile(wrapper, `#!${process.execPath}\nimport {spawn} from 'node:child_process';import fs from 'node:fs';const args=process.argv.slice(2);if(args.some(arg=>arg.endsWith('/001-encode.mp4'))){fs.writeFileSync('private/encode-started','ready');process.stdin.resume();setInterval(()=>{},1000);}else{const child=spawn(${JSON.stringify(process.env.SWC_FFMPEG ?? 'ffmpeg')},args,{stdio:'inherit'});child.on('exit',(code)=>process.exit(code??1));}\n`);
  await chmod(wrapper, 0o700);
  return { path, scenario, wrapper };
}

test('T02 a shallow checkout requires an explicit fetch for an absent endpoint', async () => {
  const source = await signalFixture('encoding');
  const absentCommit = await git(source.path, 'rev-parse', 'HEAD');
  await writeFile(join(source.path, 'second.txt'), 'second commit');
  await git(source.path, 'add', '.');
  await git(source.path, 'commit', '-qm', 'Shallow head');
  const shallow = await root();
  await git(source.path, 'clone', '--depth', '1', '--no-local', pathToFileURL(source.path).href, shallow);
  const boundary = await readFile(join(shallow, '.git/shallow'));
  await expect(plan({ invocationDir: shallow, base: absentCommit, head: 'HEAD', routes: ['/'] })).rejects.toMatchObject({ exitCode: 2, detail: { code: 'GIT_FAILED', hint: expect.stringContaining('fetch missing refs explicitly') } });
  expect(await readFile(join(shallow, '.git/shallow'))).toEqual(boundary);
  expect(await exists(join(shallow, '.show-what-changed'))).toBe(false);
});

test('T12 retries an actual bind-after-selection race and preserves the unrelated listener', async () => {
  const fixture = await signalFixture('encoding');
  const selected = await plan({ invocationDir: fixture.path, routes: ['/'] });
  const run = await createRunContext({ repoRoot: fixture.path, timeoutMs: 30_000, signal: new AbortController().signal, diagnostics: { event() {} } });
  runs.push(run);
  const workspaces = await prepare(selected, run);
  const unrelated = createServer();
  let occupiedPort: number | null = null;
  const originalSpawn = run.supervisor.spawn;
  vi.spyOn(run.supervisor, 'spawn').mockImplementation(async (spec) => {
    if (spec.purpose === 'server' && spec.side === 'before' && occupiedPort === null) {
      occupiedPort = Number(spec.argv.at(-1));
      await new Promise<void>((resolve, reject) => { unrelated.once('error', reject); unrelated.listen(occupiedPort ?? 0, '127.0.0.1', resolve); });
    }
    return originalSpawn(spec);
  });
  try {
    const { servers } = await start(workspaces, selected, run);
    expect(occupiedPort).not.toBeNull();
    expect(servers.before.port).not.toBe(occupiedPort);
    expect(servers.after.port).not.toBe(occupiedPort);
    expect(await (await fetch(servers.before.origin)).text()).toContain('Signal fixture');
    expect((await cleanupRun(run)).status).toBe('ok');
    expect(await listeners(servers.before.port)).toEqual([]);
    expect(await listeners(servers.after.port)).toEqual([]);
    expect(unrelated.listening).toBe(true);
  } finally { await new Promise<void>((resolve) => unrelated.close(() => resolve())); }
}, 45_000);

test('T09 keeps one real masked secret and fill value private through failed capture, composition and every decoded video frame', async () => {
  const fixture = await signalFixture('encoding');
  const secret = 'N6-SYNTHETIC-SECRET-777';
  const fill = 'N6-PRIVATE-FILL-123';
  const html = `<style>body{margin:0;background:white;color:black}.secret{position:fixed;left:10px;top:10px;width:600px;height:120px;background:#ff0000;color:#0000ff;overflow:hidden}input{background:#ff0000;color:#0000ff}h1{margin-top:160px}</style><div class="secret">${secret}<label>Private code<input></label></div><h1>Masked comparison</h1>`;
  await writeFile(join(fixture.path, 'server.mjs'), `import http from 'node:http';http.createServer((req,res)=>{res.setHeader('content-type','text/html');res.end(${JSON.stringify(html)});}).listen(Number(process.argv[2]),'127.0.0.1');`);
  await writeFile(join(fixture.path, 'show-what-changed.config.json'), JSON.stringify({ schemaVersion: 2, execution: { start: { kind: 'process', argv: [process.execPath, 'server.mjs', '{port}'] }, state: { kind: 'stateless' } }, capture: { mode: 'keyframes', maskSelectors: ['.secret'], stepTimeoutMs: 10_000, observeMs: 200 } }));
  await git(fixture.path, 'add', '.');
  await git(fixture.path, 'commit', '-qm', 'Mask continuity fixture');
  await writeFile(fixture.scenario, JSON.stringify({ schemaVersion: 2, id: 'privacy', title: 'Masked fixture', steps: [
    { id: 'open', op: 'goto', path: '/', timeoutMs: 3000 },
    { id: 'fill', op: 'fill', target: { label: 'Private code' }, value: fill },
    { id: 'missing', op: 'expectVisible', target: { testId: 'missing' }, timeoutMs: 400 },
    { id: 'blocked', op: 'screenshot' },
  ] }));
  const result = await compare({ kind: 'new', request: { invocationDir: fixture.path, scenarioPaths: [fixture.scenario] } }, {
    invocationDir: fixture.path, timeoutMs: 60_000, signal: new AbortController().signal, consent: { kind: 'allow-exec' }, diagnostics: { event() {} },
  });
  const diagnostic = JSON.stringify({
    status: result.status, exitCode: result.exitCode,
    error: result.error && { code: result.error.code, phase: result.error.phase },
    manifest: result.data && {
      errors: result.data.errors.map(({ code, phase }) => ({ code, phase })),
      errorHistory: result.data.errorHistory.map(({ code, phase }) => ({ code, phase })),
      scenarios: result.data.scenarios.map((scenario) => ({
        id: scenario.id, outcome: scenario.outcome, errors: scenario.errors.map(({ code, phase }) => ({ code, phase })),
        steps: scenario.steps.map((step) => ({
          id: step.id, op: step.op,
          before: { status: step.before.status, reasonCode: step.before.reasonCode, elapsedMs: step.before.elapsedMs },
          after: { status: step.after.status, reasonCode: step.after.reasonCode, elapsedMs: step.after.elapsedMs },
        })),
      })),
    },
  });
  expect(result, `T09 capture diagnostic ${diagnostic}`).toMatchObject({ status: 'partial', exitCode: 3, data: { cleanupOutcome: { status: 'ok' }, summary: { verifiedPairs: 2, failedSteps: 2, blockedSteps: 2 } } });
  if (!result.data) throw new Error('Expected partial manifest');
  const runDir = join(fixture.path, '.show-what-changed/runs', result.data.runId);
  const bundle = CaptureBundleSchema.parse(JSON.parse(await readFile(join(runDir, 'capture.json'), 'utf8')));
  const timeline = TimelineSchema.parse(JSON.parse(await readFile(join(runDir, 'timeline.json'), 'utf8')));
  const masked = (image: PNG, left: number, top: number, right: number, bottom: number, tolerance = 0) => {
    let maximumError = 0;
    for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
      const offset = (y * image.width + x) * 4;
      for (let channel = 0; channel < 3; channel++) maximumError = Math.max(maximumError, Math.abs((image.data[offset + channel] ?? 0) - 16));
    }
    expect(maximumError).toBeLessThanOrEqual(tolerance);
  };
  for (const scenario of bundle.scenarios) for (const step of scenario.steps) for (const side of ['before', 'after'] as const) {
    const image = PNG.sync.read(await readFile(join(runDir, step[side].image.path)));
    masked(image, 20, 20, 580, 120);
    for (let offset = 0; offset < image.data.length; offset += 4) {
      if (image.data[offset + 1] === 0 && (image.data[offset] === 255 && image.data[offset + 2] === 0 || image.data[offset] === 0 && image.data[offset + 2] === 255)) throw new Error('Unmasked red or blue secret pixels persisted');
    }
  }
  for (const segment of timeline.segments.filter((item) => item.kind === 'step')) {
    const image = PNG.sync.read(await readFile(join(runDir, segment.image)));
    for (const offset of [0, 962]) masked(image, offset + 20, 70, offset + 420, 130);
  }
  const decoded = join(runDir, 'private/decoded');
  await mkdir(decoded);
  await execute(process.env.SWC_FFMPEG ?? 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', join(runDir, 'compare.mp4'), '-fps_mode', 'passthrough', join(decoded, '%03d.png')]);
  const frames = (await readdir(decoded)).sort();
  expect(frames).toHaveLength(timeline.totalFrames);
  for (let index = 30; index < frames.length; index++) {
    const name = frames[index];
    if (!name) throw new Error('Missing decoded frame');
    const image = PNG.sync.read(await readFile(join(decoded, name)));
    for (const offset of [0, 962]) masked(image, offset + 20, 70, offset + 420, 130, 8);
  }
  for (const path of ['manifest.json', 'capture.json', 'timeline.json', 'pr.md']) {
    const text = await readFile(join(runDir, path), 'utf8');
    expect(text).not.toContain(secret);
    expect(text).not.toContain(fill);
  }
  expect(await readFile(join(runDir, 'private/plan.json'), 'utf8')).toContain(fill);
}, 90_000);

describe('T12 T14 external CLI signal handling', () => {
  for (const phase of ['preparing', 'starting', 'recording', 'encoding'] as const) {
    test.each(['SIGINT', 'SIGTERM'] as const)(`handles %s during ${phase} without owned survivors or caller changes`, async (signal) => {
      const fixture = await signalFixture(phase);
      const index = await readFile(join(fixture.path, '.git/index'));
      const source = await readFile(join(fixture.path, 'server.mjs'));
      const head = await git(fixture.path, 'rev-parse', 'HEAD');
      const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd: fixture.path, stdio: 'ignore' });
      const unrelatedClosed = new Promise<void>((resolve) => unrelated.once('close', () => resolve()));
      const child = spawn(process.execPath, ['--no-warnings', '--experimental-transform-types', '--input-type=module', '-e', sourceLoader, sourceCli, 'compare', '--scenario', fixture.scenario, '--allow-exec', '--json', '--timeout', '60'], {
        cwd: fixture.path, env: { ...process.env, ...(phase === 'encoding' ? { SWC_FFMPEG: fixture.wrapper } : {}) }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = ''; let stderr = '';
      child.stdout.on('data', (bytes: Buffer) => { stdout += bytes; });
      child.stderr.on('data', (bytes: Buffer) => { stderr += bytes; });
      const finished = new Promise<number | null>((resolve) => child.once('close', (code) => resolve(code)));
      let runDir = '';
      try {
        const until = Date.now() + 45_000;
        let ready = false;
        while (Date.now() < until && child.exitCode === null && !ready) {
          const ids = await readdir(join(fixture.path, '.show-what-changed/runs')).catch(() => [] as string[]);
          if (ids[0]) {
            runDir = join(fixture.path, '.show-what-changed/runs', ids[0]);
            ready = await exists(phase === 'encoding' ? join(runDir, 'private/encode-started') : join(runDir, 'private/workspaces/before/node_modules', phase));
          }
          if (!ready) await delay(20);
        }
        expect(ready, `The ${phase} fixture did not become active. ${stdout} ${stderr}`).toBe(true);
        expect(child.kill(signal)).toBe(true);
        const code = await Promise.race([finished, delay(15_000).then(() => { throw new Error('CLI did not complete bounded signal cleanup'); })]);
        expect(code).toBe(signal === 'SIGINT' ? 130 : 143);
        expect(stdout.trim(), stderr).not.toBe('');
        expect(stdout.trim().split('\n')).toHaveLength(1);
        const result = JSON.parse(stdout);
        expect(result).toMatchObject({ status: 'cancelled', exitCode: code, error: { code: signal }, data: { state: 'terminal', cleanupOutcome: { status: 'ok', errors: [] } } });
        expect(JSON.parse(await readFile(join(runDir, 'manifest.json'), 'utf8'))).toEqual(result.data);
        for (const artifact of Object.values(result.data.artifacts) as ({ path: string; sha256: string; bytes: number } | null)[]) if (artifact) {
          const bytes = await readFile(join(runDir, artifact.path));
          expect(bytes.length).toBe(artifact.bytes);
          expect(sha256(bytes)).toBe(artifact.sha256);
        }
        const owned: { group: number }[] = JSON.parse(await readFile(join(runDir, 'private/processes.json'), 'utf8'));
        for (const process of owned) expect(await groupMembers(process.group)).toEqual([]);
        expect(await exists(join(fixture.path, '.show-what-changed/run.lock'))).toBe(false);
        expect(await exists(join(runDir, 'private/workspaces'))).toBe(false);
        expect(unrelated.exitCode).toBeNull();
        expect(await readFile(join(fixture.path, '.git/index'))).toEqual(index);
        expect(await readFile(join(fixture.path, 'server.mjs'))).toEqual(source);
        expect(await git(fixture.path, 'rev-parse', 'HEAD')).toBe(head);
      } finally {
        const evidence = join(tmpdir(), 'swc-n6-signal-evidence');
        await mkdir(evidence, { recursive: true });
        const persisted = runDir ? await readFile(join(runDir, 'manifest.json'), 'utf8').catch(() => null) : null;
        const processes = runDir ? await readFile(join(runDir, 'private/processes.json'), 'utf8').catch(() => null) : null;
        await writeFile(join(evidence, `${phase}-${signal}-${Date.now()}.json`), JSON.stringify({ phase, signal, stdout, stderr, code: child.exitCode, persisted: persisted ? JSON.parse(persisted) : null, processes: processes ? JSON.parse(processes) : null }, null, 2));
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
        await Promise.race([finished, delay(12_000).then(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); })]);
        unrelated.kill('SIGTERM');
        await unrelatedClosed;
      }
    }, 70_000);
  }
});
