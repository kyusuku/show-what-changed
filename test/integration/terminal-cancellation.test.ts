import { spawn } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PNG } from 'pngjs';
import { afterEach, expect, test } from 'vitest';
import { cleanupRun, createRunContext } from '../../src/runtime/context.js';
import { artifactInfo, writeRunFile } from '../../src/runtime/files.js';
import { CaptureBundleSchema, ManifestSchema, ResultSchema, TimelineSchema } from '../../src/schema/index.js';
import { buildPresentation } from '../../src/composer/presentation.js';
import { digest, sha256 } from '../../src/schema/io.js';
import type { RunContext } from '../../src/schema/contracts.js';

const roots: string[] = [];
const runs: RunContext[] = [];
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const exists = (path: string) => stat(path).then(() => true, () => false);
async function root(): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'swc-terminal-cancellation-')));
  roots.push(path);
  return path;
}
afterEach(async () => {
  for (const run of runs.splice(0)) await cleanupRun(run);
  for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true });
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

type Probe = 'write-once' | 'write-always' | 'release' | 'release-failed' | 'release-uncertain' | 'release-invalid' | 'output-fatal' | 'prior-fatal' | 'marker-changed';
async function terminalProbe(probe: Probe, signal: 'SIGINT' | 'SIGTERM' = 'SIGTERM') {
  const run = await savedEncodingFixture();
  const root = run.paths.repoRoot;
  if (probe === 'release-invalid') await writeFile(join(run.paths.runDir, 'timeline.json'), (await readFile(join(run.paths.runDir, 'timeline.json'), 'utf8')) + '\n');
  const paused = join(root, 'paused');
  const resume = join(root, 'resume');
  const trace = join(root, 'trace.json');
  const loader = join(root, 'terminal-loader.mjs');
  await writeFile(loader, `
import { registerHooks } from 'node:module';
import { writeFileSync } from 'node:fs';
const state = { writes: 0, released: false, writesAfterRelease: 0 };
globalThis.__terminalProbe = state;
globalThis.__terminalTrace = () => writeFileSync(${JSON.stringify(trace)}, JSON.stringify(state));
globalThis.__terminalTrace();
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.includes('/src/') && specifier.startsWith('.') && specifier.endsWith('.js')) return next(specifier.replace(/\\.js$/, '.ts'), context);
    return next(specifier, context);
  },
  load(url, context, next) {
    const result = next(url, context);
    let source = String(result.source);
    if (url.endsWith('/src/runner/artifacts.ts')) {
      const head = 'export async function writePublicArtifacts(run: RunContext, manifest: Manifest): Promise<void> {';
      const tail = '  await persistManifest(run, manifest);\\n}';
      if (!source.includes(head) || !source.includes(tail)) throw new Error('Missing public write probe anchor');
      source = source.replace(head, head + '\\n  const probe = globalThis.__terminalProbe; probe.writes++; if (probe.released) probe.writesAfterRelease++; globalThis.__terminalTrace();\\n'
        + ${JSON.stringify(probe === 'write-once' ? "  if (probe.writes === 2) throw new Error('Transient public write failure');\n" : probe === 'write-always' ? "  if (probe.writes >= 2) throw new Error('Persistent public write failure');\n" : probe.endsWith('fatal') ? "  if (probe.writes === 1) throw new Error('Initial public write failure');\n" : '')});
      source = source.replace(tail, tail.slice(0, -1) + ${JSON.stringify(probe.startsWith('write-') ? `  if (globalThis.__terminalProbe.writes === 1) { process.kill(process.pid, '${signal}'); await new Promise(resolve => setTimeout(resolve, 50)); }\n}` : probe === 'marker-changed' ? `  const fs = await import('node:fs/promises'); const path = run.paths.runDir + '/.owner.json'; const marker = JSON.parse(await fs.readFile(path, 'utf8')); await fs.writeFile(path, JSON.stringify({ ...marker, nonce: '0'.repeat(32) }));\n}` : '}')});
    }
    if (url.endsWith('/src/runtime/ownership.ts')) {
      const head = 'export async function releaseRepositoryLock(lock: RepositoryLock, commit?: OwnershipCommit): Promise<void> {';
      const removal = '  rmdirSync(lock.path);';
      if (!source.includes(head) || !source.includes(removal)) throw new Error('Missing ownership probe anchor');
      ${probe.startsWith('release') ? `source = source.replace(head, head + ${JSON.stringify(`\n  const probeFs = await import('node:fs/promises');\n  await probeFs.writeFile(${JSON.stringify(paused)}, 'paused');\n  while (!(await probeFs.stat(${JSON.stringify(resume)}).then(() => true, () => false))) await new Promise(resolve => setTimeout(resolve, 10));\n${probe === 'release-failed' ? "  await probeFs.writeFile(join(lock.path, 'retained-residue'), 'keep');\n" : ''}`)});` : ''}
      source = source.replace(removal, removal + '\\n  globalThis.__terminalProbe.released = true; globalThis.__terminalTrace();'
        + ${JSON.stringify(probe === 'release-uncertain' ? "\n  throw new Error('Reported failure after actual release');" : '')});
    }
    return { ...result, source };
  },
});
await import(${JSON.stringify(new URL('../../src/cli/index.ts', import.meta.url).href)});
`);
  const child = spawn(process.execPath, ['--no-warnings', '--experimental-transform-types', loader, 'compose', run.paths.runDir, '--json'], { cwd: root, env: { ...process.env, ...(probe === 'prior-fatal' ? { SWC_FFMPEG: join(root, 'missing-ffmpeg') } : {}) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', (bytes: Buffer) => { stdout += bytes; });
  child.stderr.on('data', (bytes: Buffer) => { stderr += bytes; });
  const finished = new Promise<number | null>((resolve) => child.once('close', (code) => resolve(code)));
  try {
    if (probe.startsWith('release')) {
      const deadline = Date.now() + 30_000;
      while (!await exists(paused) && child.exitCode === null && Date.now() < deadline) await delay(10);
      expect(await exists(paused), stdout + stderr).toBe(true);
      expect(stdout).toBe('');
      expect(await exists(join(root, '.show-what-changed/run.lock'))).toBe(true);
      expect(child.kill(signal)).toBe(true);
      await delay(50);
      await writeFile(resume, 'resume');
    }
    const code = await Promise.race([finished, delay(30_000).then(() => { throw new Error('Terminal probe timed out'); })]);
    expect(stdout.trim().split('\n'), stderr).toHaveLength(1);
    const result = ResultSchema.parse(JSON.parse(stdout));
    const manifest = ManifestSchema.parse(JSON.parse(await readFile(join(run.paths.runDir, 'manifest.json'), 'utf8')));
    const pr = await readFile(join(run.paths.runDir, 'pr.md'), 'utf8').catch(() => null);
    const recorded: { writes: number; released: boolean; writesAfterRelease: number } = JSON.parse(await readFile(trace, 'utf8'));
    expect(recorded.writesAfterRelease).toBe(0);
    return { code, result, manifest, pr, recorded, lockExists: await exists(join(root, '.show-what-changed/run.lock')) };
  } finally {
    await writeFile(resume, 'resume');
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await finished;
  }
}

test('a cancelled terminal rewrite retries a transient output failure before releasing ownership', async () => {
  const probe = await terminalProbe('write-once');
  expect(probe.code).toBe(143);
  expect(probe.result).toMatchObject({ status: 'cancelled', exitCode: 143, error: { code: 'SIGTERM' } });
  expect(probe.result.data).toEqual(probe.manifest);
  expect(probe.manifest.errors.map((error) => error.code)).toEqual(expect.arrayContaining(['SIGTERM', 'OUTPUT_WRITE_FAILED']));
  expect(probe.pr).toContain('Status: cancelled. Exit code: 143.');
  expect(probe.recorded.writes).toBe(3);
  expect(probe.lockExists).toBe(false);
}, 45_000);

test.each(['SIGINT', 'SIGTERM'] as const)('%s before ownership release overrides success in every terminal result', async (signal) => {
  const probe = await terminalProbe('release', signal);
  const exitCode = signal === 'SIGINT' ? 130 : 143;
  expect(probe.code).toBe(exitCode);
  expect(probe.result).toMatchObject({ status: 'cancelled', exitCode, error: { code: signal } });
  expect(probe.result.data).toEqual(probe.manifest);
  expect(probe.pr).toContain(`Status: cancelled. Exit code: ${exitCode}.`);
  expect(probe.lockExists).toBe(false);
}, 45_000);

test('cancellation remains primary when the synchronous lock release fails', async () => {
  const probe = await terminalProbe('release-failed');
  expect(probe.code).toBe(143);
  expect(probe.result).toMatchObject({ status: 'cancelled', exitCode: 143, error: { code: 'SIGTERM' } });
  expect(probe.result.data).toEqual(probe.manifest);
  expect(probe.manifest.cleanupOutcome.status).toBe('failed');
  expect(probe.manifest.errors.map((error) => error.code)).toEqual(expect.arrayContaining(['SIGTERM', 'CLEANUP_FAILED']));
  expect(probe.pr).toContain('Status: cancelled. Exit code: 143.');
  expect(probe.pr).toContain('Cleanup: failed.');
  expect(probe.lockExists).toBe(true);
}, 45_000);

test('persistent cancellation write failure retains ownership and refuses to claim a persisted manifest', async () => {
  const probe = await terminalProbe('write-always');
  expect(probe.code).toBe(143);
  expect(probe.result).toMatchObject({ status: 'cancelled', exitCode: 143, data: null, error: { code: 'SIGTERM' }, warnings: expect.arrayContaining([expect.objectContaining({ code: 'OUTPUT_WRITE_FAILED' })]) });
  expect(probe.manifest.status).toBe('ok');
  expect(probe.pr).toContain('Status: ok. Exit code: 0.');
  expect(probe.recorded.writes).toBe(3);
  expect(probe.lockExists).toBe(true);
}, 45_000);

test('uncertain ownership returns no manifest and never repairs public files after release', async () => {
  const probe = await terminalProbe('release-uncertain');
  expect(probe.code).toBe(143);
  expect(probe.result).toMatchObject({ status: 'cancelled', exitCode: 143, data: null, error: { code: 'SIGTERM' }, warnings: expect.arrayContaining([expect.objectContaining({ code: 'OWNERSHIP_UNCERTAIN' })]) });
  expect(probe.manifest.status).toBe('cancelled');
  expect(probe.recorded.writes).toBe(1);
  expect(probe.lockExists).toBe(false);
}, 45_000);

test('a recovered output write failure remains fatal and is retained in the saved error trail', async () => {
  const probe = await terminalProbe('output-fatal');
  expect(probe.code).toBe(9);
  expect(probe.result).toMatchObject({ status: 'failed', exitCode: 9, error: { code: 'OUTPUT_WRITE_FAILED' } });
  expect(probe.result.data).toEqual(probe.manifest);
  expect(probe.manifest.errors.map((error) => error.code)).toContain('OUTPUT_WRITE_FAILED');
  expect(probe.pr).toContain('Status: failed. Exit code: 9.');
  expect(probe.lockExists).toBe(false);
}, 45_000);

test('an earlier fatal error keeps its code when terminal output also fails', async () => {
  const probe = await terminalProbe('prior-fatal');
  expect(probe.code).toBe(8);
  expect(probe.result).toMatchObject({ status: 'failed', exitCode: 8, error: { code: 'MEDIA_CAPABILITY_UNAVAILABLE' } });
  expect(probe.result.data).toEqual(probe.manifest);
  expect(probe.manifest.errors.map((error) => error.code)).toEqual(expect.arrayContaining(['MEDIA_CAPABILITY_UNAVAILABLE', 'OUTPUT_WRITE_FAILED']));
  expect(probe.pr).toContain('Status: failed. Exit code: 8.');
  expect(probe.lockExists).toBe(false);
}, 45_000);

test('release revalidates the run nonce synchronously after terminal writes', async () => {
  const probe = await terminalProbe('marker-changed');
  expect(probe.code).toBe(3);
  expect(probe.result).toMatchObject({ status: 'partial', exitCode: 3, data: null, warnings: expect.arrayContaining([expect.objectContaining({ code: 'OWNERSHIP_UNCERTAIN' })]) });
  expect(probe.recorded.writes).toBe(1);
  expect(probe.recorded.released).toBe(false);
  expect(probe.lockExists).toBe(true);
}, 45_000);

test('cancellation during release overrides an invalid saved run without public writes', async () => {
  const probe = await terminalProbe('release-invalid');
  expect(probe.code).toBe(143);
  expect(probe.result).toMatchObject({ status: 'cancelled', exitCode: 143, data: null, error: { code: 'SIGTERM' } });
  expect(probe.manifest.encodingOutcome.errors.map((error) => error.code)).toEqual(['ENCODE_FAILED']);
  expect(probe.recorded.writes).toBe(0);
  expect(probe.pr).toBeNull();
  expect(probe.lockExists).toBe(false);
}, 45_000);
