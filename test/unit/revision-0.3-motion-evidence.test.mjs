import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { PNG } from 'pngjs';
import { expect, test, vi } from 'vitest';
import * as verifier from '../../scripts/revision-0.3-motion-check.mjs';

const source = await readFile(new URL('../../scripts/revision-0.3-motion-check.mjs', import.meta.url), 'utf8');
const start = source.indexOf('async function executeCase(');
const end = source.indexOf('\nexport async function verifyInstalledMotion(', start);
assert(start >= 0 && end > start, 'The canonical motion case must be available');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const identity = (bytes) => ({ sha256: digest(bytes), bytes: bytes.length });
const server = () => ({
  listening: false, once() { return this; },
  listen(_port, _host, done) { this.listening = true; done(); }, address() { return { port: 1234 }; },
  closeAllConnections() {}, close(done) { this.listening = false; done(); },
});
const executeCase = runInNewContext('(' + source.slice(start, end) + ')', {
  assert, join, mkdir, lstat, readFile, writeFile, digest, identity,
  sides: ['before', 'after'], mask: { x: 0, y: 0, width: 140, height: 100 },
  createServer: server, availableParallelism: () => 1, loadavg: () => [0, 0, 0],
  fixtureHtml: verifier.fixtureHtml, captureTrackEvidence: verifier.captureTrackEvidence,
  saveValidatedArtifacts: verifier.saveValidatedArtifacts,
  sourceMetrics: async () => ({}), decodeMetrics: async () => ({}),
});
const sentinel = 'SYNTHETIC_UNRETAINED_CONTENT';
const sample = (index) => ({ sourceSeconds: index + 10, hostBeforeMs: index * 1000, hostAfterMs: index * 1000 + 4, raw: sentinel });
const track = () => ({
  status: 'failed', error: { code: 'CAPTURE_CLOCK_DRIFT', message: sentinel }, failureAtMs: 4165.2,
  clock: { rate: 1, offsetMs: -10000, uncertaintyMs: 2, maxDriftMs: 43, errorBoundMs: 45, samples: [sample(0), sample(1)], raw: sentinel },
  stats: { receivedFrames: 2, persistedFrames: 2, acknowledgedFrames: 2, rejectedFrames: 0, maxQueueDepth: 1, sourceDroppedFrames: null, maxGapMs: 35, raw: sentinel },
  frames: [0, 1].map((index) => ({ sequence: index, sourceMonotonicSeconds: 10 + index, runElapsedMs: index * 1000, receivedMs: index * 1000 + 2, artifact: { path: sentinel }, bytes: sentinel })),
});
function bundle(outcome = 'partial') {
  const tracks = { before: track(), after: track() };
  if (outcome === 'ok') for (const value of Object.values(tracks)) {
    value.status = 'ok'; value.error = null; delete value.failureAtMs;
    value.clock.errorBoundMs = 4; value.clock.maxDriftMs = 2;
  }
  return { scenarios: [{ outcome }], motion: [{ tracks, steps: [{}, { before: { dispatch: { runElapsedMs: 1 } }, after: { dispatch: { runElapsedMs: 2 } } }] }] };
}
const video = Buffer.from('synthetic encoded video stub');
const poster = PNG.sync.write(new PNG({ width: 1920, height: 686 }));
const badCrc = Buffer.from(poster);
for (let offset = 8; offset < badCrc.length;) {
  const length = badCrc.readUInt32BE(offset);
  if (badCrc.toString('ascii', offset + 4, offset + 8) === 'IDAT') { badCrc[offset + 8 + length] ^= 1; break; }
  offset += 12 + length;
}
async function withCase(captureBundle, mediaCase, check) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'swc-motion-evidence-test-')));
  try {
    const runDir = join(root, 'run');
    await mkdir(runDir);
    const files = { 'compare.mp4': video, 'poster.png': mediaCase.poster ?? poster, 'capture.json': Buffer.from('{}'), 'timeline.json': Buffer.from('{}') };
    for (const [name, bytes] of Object.entries(files)) if (name !== mediaCase.missing) await writeFile(join(runDir, name), bytes);
    const render = vi.fn(async () => ({ totalFrames: 4 }));
    const encode = vi.fn(async () => ({ video: { sha256: mediaCase.videoHash ?? digest(video) }, poster: { sha256: mediaCase.posterHash ?? digest(files['poster.png']) } }));
    const api = {
      PNG, schema: { ScenarioSchema: { parse: (value) => value }, CaptureSettingsSchema: { parse: (value) => value } },
      createRunContext: async () => ({ paths: { runDir, tempDir: join(root, 'absent-temp') }, supervisor: { spawn() {}, adopt() {} } }),
      capture: async () => captureBundle, render, encode, validateTimelineCapture() {},
      cleanupRun: async () => ({ status: 'ok' }), groupMembers: async () => [],
    };
    await executeCase(api, '<head></head> Start motion inner-scroll', { width: 1280, height: 800 }, 1, root, new AbortController().signal);
    const caseDirectory = join(root, '1280x800-run-1');
    const result = JSON.parse(await readFile(join(caseDirectory, 'result.json'), 'utf8'));
    await check({ files, caseDirectory, result, render, encode });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('a partial capture retains clock evidence and rejects media production', async () => {
  await withCase(bundle(), {}, async ({ result, render, encode, caseDirectory }) => {
    expect(result).toMatchObject({ captureOutcome: 'partial', status: 'failed', failure: { code: 'ERR_ASSERTION' }, cleanup: { status: 'ok' } });
    expect(render).not.toHaveBeenCalled();
    expect(encode).not.toHaveBeenCalled();
    expect(result.artifacts).toBeUndefined();
    expect(await readdir(caseDirectory)).toEqual(['result.json']);
    for (const side of ['before', 'after']) {
      expect(result.captureTracks?.[side]).toMatchObject({
        status: 'failed', failureCode: 'CAPTURE_CLOCK_DRIFT', failureAtMs: 4165.2,
        clock: { rate: 1, offsetMs: -10000, uncertaintyMs: 2, maxDriftMs: 43, errorBoundMs: 45, sampleCount: 2, samples: [{ sourceSeconds: 10, hostBeforeMs: 0, hostAfterMs: 4 }, { sourceSeconds: 11, hostBeforeMs: 1000, hostAfterMs: 1004 }] },
        stats: { persistedFrames: 2 }, frameCount: 2,
        firstFrame: { sequence: 0, sourceMonotonicSeconds: 10, runElapsedMs: 0, receivedMs: 2 },
        lastFrame: { sequence: 1, sourceMonotonicSeconds: 11, runElapsedMs: 1000, receivedMs: 1002 },
      });
    }
    expect(JSON.stringify(result)).not.toContain(sentinel);
  });
});

test('endpoint failure diagnostics retain proof boundaries without unreviewed payloads', () => {
  const captureBundle = bundle();
  const clock = captureBundle.motion[0].tracks.before.clock;
  clock.proof = { kind: 'monotone-endpoints', anchorIndex: 2, finalIndex: null, numericAllowanceMs: 0.01, raw: sentinel };
  const evidence = verifier.captureTrackEvidence(captureBundle).before;
  expect(evidence.clock.proof).toEqual({ kind: 'monotone-endpoints', anchorIndex: 2, finalIndex: null, numericAllowanceMs: 0.01 });
  expect(JSON.stringify(evidence)).not.toContain(sentinel);
  clock.proof = { kind: sentinel, anchorIndex: 2, finalIndex: 8, numericAllowanceMs: 0.01 };
  expect(verifier.captureTrackEvidence(captureBundle).before.clock.proof).toBeUndefined();
});

test('the hosted failure summary selects public scalar diagnostics without raw report content', () => {
  const marker = { kind: 'source', runElapsedMs: 12.5, errorBoundMs: 4, raw: sentinel };
  const result = verifier.selectMotionFailureDiagnostics({
    id: '1280x800-run-1', failure: { code: 'ERR_ASSERTION', message: sentinel }, captureOutcome: 'ok',
    host: { parallelism: 2, loadAverage: [0.5, 1, 1.5], hostname: sentinel }, dispatchSkewMs: 0.5,
    processing: [{ kind: 'capture-processing', side: 'after', frames: 75, pendingRaw: 0, pendingSanitized: 0, sharedSanitizedBytes: 0, maskMs: 1200.5, writeMs: 20, maxMaskMs: 80, maxWriteMs: 3, maxAckLatencyMs: 85, maxSanitizedQueueDepth: 1, maxSharedSanitizedBytes: 4096, backpressureWaits: 0, raw: sentinel }],
    stepTiming: [{ id: 'move', barrierMs: 10, before: { kind: 'executed', dispatch: marker, completion: marker, observationEnd: marker, raw: sentinel }, after: { kind: 'failed', dispatch: marker, failure: { message: sentinel } }, raw: sentinel }],
    captureTracks: { before: { status: 'ok', frameCount: 75, stats: { receivedFrames: 75, raw: sentinel }, clock: { errorBoundMs: 4, samples: [sentinel] }, firstFrame: { runElapsedMs: 20, sourceMonotonicSeconds: sentinel }, lastFrame: { runElapsedMs: 4020, path: sentinel } } },
    cleanup: { status: 'ok', errors: [sentinel], path: sentinel }, raw: sentinel,
  });
  expect(result).toMatchObject({
    id: '1280x800-run-1', failure: { code: 'ERR_ASSERTION' }, captureOutcome: 'ok',
    host: { parallelism: 2, loadAverage: [0.5, 1, 1.5] }, dispatchSkewMs: 0.5,
    processing: [{ side: 'after', frames: 75, maskMs: 1200.5, maxAckLatencyMs: 85, maxSharedSanitizedBytes: 4096 }],
    stepTiming: [{ id: 'move', before: { kind: 'executed', dispatch: { runElapsedMs: 12.5, errorBoundMs: 4 } }, after: { kind: 'failed', dispatch: { runElapsedMs: 12.5, errorBoundMs: 4 } } }],
    captureTracks: { before: { status: 'ok', frameCount: 75, stats: { receivedFrames: 75 }, clockErrorBoundMs: 4, firstFrameRunElapsedMs: 20, lastFrameRunElapsedMs: 4020 } },
    cleanup: { status: 'ok' },
  });
  expect(result.diagnosticCode).toBeUndefined();
  expect(result.failure).toEqual({ code: 'ERR_ASSERTION', assertion: null });
  expect(result.cleanup).toEqual({ status: 'ok' });
  expect(result.processing).toHaveLength(1);
  expect(result.stepTiming).toHaveLength(1);
  expect(JSON.stringify(result)).not.toContain(sentinel);
});

test('the hosted failure summary rejects invalid numbers, enums, and duplicate sides or steps', () => {
  const result = verifier.selectMotionFailureDiagnostics({
    id: sentinel, failure: { code: sentinel + '/invalid', message: sentinel },
    host: { parallelism: 1.5, loadAverage: [0, Infinity, -1] }, dispatchSkewMs: NaN,
    processing: [{ kind: 'capture-processing', side: 'before', frames: 1.5, pendingRaw: -1, maskMs: Infinity }, { kind: 'capture-processing', side: 'before', frames: 2 }],
    stepTiming: [{ id: 'move', before: { kind: sentinel, dispatch: { runElapsedMs: 1 } }, after: { kind: 'executed', dispatch: { runElapsedMs: -1, errorBoundMs: Infinity } } }, { id: 'move', before: { kind: 'executed' } }],
  });
  expect(result).toMatchObject({
    diagnosticCode: 'MOTION_DIAGNOSTIC_INVALID', id: null, failure: { code: null },
    host: { parallelism: null, loadAverage: [0, null, null] }, dispatchSkewMs: null,
    processing: [{ side: 'before', frames: null, pendingRaw: null, maskMs: null }],
    stepTiming: [{ id: 'move', before: null, after: { kind: 'executed', dispatch: { runElapsedMs: null, errorBoundMs: null } } }],
  });
  expect(result.processing).toHaveLength(1);
  expect(result.stepTiming).toHaveLength(1);
  expect(JSON.stringify(result)).not.toContain(sentinel);
  expect(verifier.selectMotionFailureDiagnostics({ processing: [{ kind: sentinel, side: 'after' }] })).toMatchObject({ diagnosticCode: 'MOTION_DIAGNOSTIC_INVALID', processing: [] });
  expect(verifier.selectMotionFailureDiagnostics({ stepTiming: [{ id: sentinel }] })).toMatchObject({ diagnosticCode: 'MOTION_DIAGNOSTIC_INVALID', stepTiming: [] });
});

test('the hosted failure summary bounds diagnostic arrays before inspecting their entries', () => {
  const oversized = (length) => new Proxy(Array(length), { get(target, key, receiver) {
    if (/^\d+$/.test(String(key))) throw new Error('Oversized diagnostic entries must not be read');
    return Reflect.get(target, key, receiver);
  } });
  expect(verifier.selectMotionFailureDiagnostics({
    host: { loadAverage: oversized(4) }, processing: oversized(3), stepTiming: oversized(5),
  })).toMatchObject({ diagnosticCode: 'MOTION_DIAGNOSTIC_INVALID', host: { loadAverage: null }, processing: [], stepTiming: [] });
});

test('recognized motion failures retain their measurements without arbitrary assertion text', () => {
  const select = (message) => verifier.selectMotionFailureDiagnostics({ failure: { code: 'ERR_ASSERTION', message } }).failure;
  expect(select('before needs 60 actual moving-object positions, observed 57').assertion).toEqual({ check: 'source-position-count', side: 'before', required: 60, observed: 57 });
  expect(select('after needs 60 decoded moving-object positions, observed 59').assertion).toEqual({ check: 'decoded-position-count', side: 'after', required: 60, observed: 59 });
  expect(select('before known-moving source gap is 316.654 ms').assertion).toEqual({ check: 'source-moving-gap', side: 'before', maximumMs: 200, observedMs: 316.654 });
  expect(select(`${sentinel} before needs 60 actual moving-object positions, observed 57`).assertion).toBeNull();
  expect(select(`before needs 60 actual moving-object positions, observed 57 ${sentinel}`).assertion).toBeNull();
});

test('missing clocks and empty frames remain explicit safe values after capture failure', async () => {
  const captureBundle = bundle();
  captureBundle.motion[0].tracks.before.clock = null;
  captureBundle.motion[0].tracks.before.frames = [];
  delete captureBundle.motion[0].tracks.after;
  await withCase(captureBundle, {}, async ({ result }) => {
    expect(result.status).toBe('failed');
    expect(result.captureTracks?.before).toMatchObject({ clock: null, frameCount: 0, firstFrame: null, lastFrame: null });
    expect(result.captureTracks?.after).toMatchObject({ status: null, failureCode: null, failureAtMs: null, clock: null, frameCount: 0, firstFrame: null, lastFrame: null });
  });
});

test('failure evidence bounds clock history and excludes arbitrary or nonnumeric content', async () => {
  const captureBundle = bundle();
  const before = captureBundle.motion[0].tracks.before;
  before.clock.samples = Array.from({ length: 140 }, (_, index) => sample(index));
  before.clock.samples[139].hostAfterMs = NaN;
  before.clock.errorBoundMs = Infinity;
  before.stats.maxGapMs = sentinel;
  before.error.code = sentinel + '/invalid';
  before.failureAtMs = Infinity;
  before.frames[1].receivedMs = sentinel;
  captureBundle.motion[0].tracks.after.error.code = 'A'.repeat(65);
  await withCase(captureBundle, {}, async ({ result }) => {
    expect(result.status).toBe('failed');
    const evidence = result.captureTracks?.before;
    expect(evidence).toBeDefined();
    expect(evidence.clock.sampleCount).toBe(140);
    expect(evidence.clock.samples).toHaveLength(128);
    expect(evidence.clock.samples[0]).toEqual({ sourceSeconds: 22, hostBeforeMs: 12000, hostAfterMs: 12004 });
    expect(evidence.clock.samples.at(-1)).toEqual({ sourceSeconds: 149, hostBeforeMs: 139000, hostAfterMs: null });
    expect(evidence).toMatchObject({ failureCode: null, failureAtMs: null, clock: { errorBoundMs: null }, stats: { maxGapMs: null }, lastFrame: { receivedMs: null } });
    expect(result.captureTracks.after.failureCode).toBeNull();
    expect(JSON.stringify(result)).not.toContain(sentinel);
    expect(evidence.frames).toBeUndefined();
  });
});

test.each([
  { name: 'valid media copies the exact four artifacts', valid: true, poster },
  { name: 'a video hash mismatch', poster, videoHash: '0'.repeat(64), code: 'ERR_ASSERTION' },
  { name: 'a poster hash mismatch', poster, posterHash: '0'.repeat(64), code: 'ERR_ASSERTION' },
  { name: 'an invalid poster CRC', poster: badCrc, code: 'MOTION_CHECK_FAILED' },
  { name: 'an incorrect poster width', poster: PNG.sync.write(new PNG({ width: 1919, height: 686 })), code: 'ERR_ASSERTION' },
  { name: 'an incorrect poster height', poster: PNG.sync.write(new PNG({ width: 1920, height: 685 })), code: 'ERR_ASSERTION' },
  { name: 'a missing final artifact', poster, missing: 'timeline.json', code: 'ENOENT' },
])('$name', async (mediaCase) => {
  if (mediaCase.poster === badCrc) {
    expect(PNG.sync.read(badCrc, { checkCRC: false }).width).toBe(1920);
    expect(() => PNG.sync.read(badCrc, { checkCRC: true })).toThrow();
  }
  await withCase(bundle('ok'), mediaCase, async ({ files, result, caseDirectory }) => {
    expect(result.cleanup.status).toBe('ok');
    if (mediaCase.valid) {
      expect(result.status).toBe('numeric-passed');
      expect(Object.keys(result.artifacts).sort()).toEqual(Object.keys(files).sort());
      expect((await readdir(caseDirectory)).sort()).toEqual([...Object.keys(files), 'result.json'].sort());
      for (const [name, bytes] of Object.entries(files)) {
        expect(result.artifacts[name]).toEqual({ path: `1280x800-run-1/${name}`, sha256: digest(bytes), bytes: bytes.length });
        expect(await readFile(join(caseDirectory, name))).toEqual(bytes);
      }
    } else {
      expect(result).toMatchObject({ status: 'failed', failure: { code: mediaCase.code } });
      expect(result.artifacts).toBeUndefined();
      expect(await readdir(caseDirectory)).toEqual(['result.json']);
    }
  });
});
