import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir, availableParallelism, loadavg } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { PNG } from 'pngjs';
import { capture } from '../dist/recorder/index.js';
import { render, encode, validateTimelineCapture } from '../dist/composer/index.js';
import { createRunContext, cleanupRun } from '../dist/runtime/context.js';
import { ScenarioSchema, CaptureSettingsSchema } from '../dist/schema/index.js';
const root = await mkdtemp(join(tmpdir(), 'swc-r03-motion-'));
let html = await readFile(new URL('../fixtures/motion/index.html', import.meta.url));
const longCapture = process.argv.includes('--long-capture');
const host = { parallelism: availableParallelism(), loadAverage: loadavg() };
if (longCapture)
  html = Buffer.from(
    html
      .toString()
      .replace('animation:travel 3s linear forwards', 'animation:travel 3s linear infinite alternate')
      .replace(
        '</body>',
        `<script>document.body.classList.add('running');for(const [delay,text]of[[28000,'Midpoint ready'],[56000,'Finish ready']])setTimeout(()=>{const span=document.createElement('span');span.textContent=text;document.body.append(span);},delay);</script></body>`,
      ),
  );
const processing = [];
const servers = [];
let run;
const observe = (image) => {
  let sum = 0;
  let pixels = 0;
  let pulse = 0;
  for (let y = 0; y < image.height; y++)
    for (let x = 0; x < image.width; x++) {
      const p = (y * image.width + x) * 4;
      const [r, g, b] = image.data.subarray(p, p + 3);
      if (g > 180 && r < 80 && b < 80) {
        sum += x;
        pixels++;
      }
      if (r > 180 && b > 180 && g < 80) pulse++;
    }
  return { x: pixels ? Math.round((sum / pixels) * 10) / 10 : null, pulse: pulse > 100 };
};
try {
  const pair = {};
  for (const side of ['before', 'after']) {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(html);
    });
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    servers.push(server);
    const port = server.address().port;
    pair[side] = {
      side,
      origin: `http://127.0.0.1:${port}`,
      port,
      sourceLabel: `${side} synthetic`,
      source: { requested: side, commit: 'a'.repeat(40), kind: 'commit', materializedHash: 'b'.repeat(64) },
      storageState: null,
      exited: new Promise(() => {}),
    };
  }
  run = await createRunContext({
    repoRoot: root,
    timeoutMs: 180000,
    signal: new AbortController().signal,
    diagnostics: {
      event: (event) => {
        process.stderr.write(`${event}\n`);
        try {
          const entry = JSON.parse(event);
          if (entry.kind === 'capture-processing') processing.push(entry);
        } catch {}
      },
    },
  });
  const scenario = ScenarioSchema.parse({
    schemaVersion: 2,
    id: 'controlled-motion',
    title: 'Controlled three second motion',
    steps: longCapture
      ? [
          { id: 'open', op: 'goto', path: '/', observeMs: 0 },
          { id: 'midpoint', op: 'expectVisible', target: { text: 'Midpoint ready' }, timeoutMs: 30000, observeMs: 0 },
          { id: 'finish', op: 'expectVisible', target: { text: 'Finish ready' }, timeoutMs: 30000, observeMs: 0 },
          { id: 'final', op: 'screenshot', observeMs: 3000 },
        ]
      : [
          { id: 'open', op: 'goto', path: '/', observeMs: 100 },
          { id: 'move', op: 'click', target: { role: 'button', name: 'Start motion' }, observeMs: 3000 },
          { id: 'scroll', op: 'scrollBy', target: { testId: 'inner-scroll' }, y: 900, observeMs: 150 },
          { id: 'checkpoint', op: 'screenshot', observeMs: 0 },
        ],
  });
  const settings = CaptureSettingsSchema.parse({
    mode: 'motion',
    viewport: { width: 800, height: 450 },
    maskRects: [{ x: 0, y: 0, width: 140, height: 100 }],
  });
  process.stderr.write(`RUN_DIR ${run.paths.runDir}\n`);
  const bundle = await capture(pair, [scenario], settings, run);
  process.stderr.write(
    `${JSON.stringify(
      bundle.motion.map((scenario) => ({
        tracks: Object.fromEntries(
          Object.entries(scenario.tracks).map(([side, track]) => [
            side,
            {
              status: track.status,
              frames: track.frames.length,
              error: track.error,
              clockErrorBoundMs: track.clock?.errorBoundMs,
            },
          ]),
        ),
      })),
      null,
      2,
    )}\n`,
  );
  assert.equal(bundle.scenarios[0].outcome, 'ok');
  if (longCapture) {
    const durationMs = bundle.motion[0].endMs - bundle.motion[0].startMs;
    assert(durationMs >= 59000 && durationMs <= 60000);
    const tracks = Object.fromEntries(
      Object.entries(bundle.motion[0].tracks).map(([side, track]) => {
        assert.equal(track.status, 'ok');
        assert.equal(track.stats.receivedFrames, track.stats.persistedFrames);
        assert.equal(track.stats.receivedFrames, track.stats.acknowledgedFrames);
        return [side, { frames: track.frames.length, stats: track.stats, clockErrorBoundMs: track.clock.errorBoundMs }];
      }),
    );
    const files = await readdir(run.paths.framesDir);
    assert.equal(files.length, tracks.before.frames + tracks.after.frames + 8);
    for (const entry of processing) {
      assert(entry.maxSanitizedQueueDepth <= 256);
      assert(entry.maxSharedSanitizedBytes <= 32 * 1024 ** 2);
    }
    assert(
      processing.some((entry) => entry.backpressureWaits > 0),
      'Sustained capture must exercise bounded ACK backpressure',
    );
    const result = { host, durationMs, tracks, processing, root: run.paths.runDir, persistedPngs: files.length };
    await writeFile(join(root, 'long-result.json'), JSON.stringify(result, null, 2));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    const metrics = {};
    for (const side of ['before', 'after']) {
      const track = bundle.motion[0].tracks[side];
      assert.equal(track.status, 'ok');
      const positions = new Set();
      const pulses = [];
      let previousPulse = false;
      for (const frame of track.frames) {
        const image = PNG.sync.read(await readFile(join(run.paths.runDir, frame.artifact.path)));
        for (let y = 0; y < 100; y++)
          for (let x = 0; x < 140; x++) {
            const p = (y * image.width + x) * 4;
            assert.deepEqual([...image.data.subarray(p, p + 4)], [16, 16, 16, 255]);
          }
        const value = observe(image);
        if (value.x !== null) positions.add(value.x);
        if (value.pulse && !previousPulse) pulses.push(frame.runElapsedMs);
        previousPulse = value.pulse;
      }
      const moving = track.frames.filter(
        (frame) =>
          frame.runElapsedMs >= bundle.motion[0].steps[1][side].dispatch.runElapsedMs &&
          frame.runElapsedMs <= bundle.motion[0].steps[1][side].dispatch.runElapsedMs + 3000,
      );
      const maxMovingGapMs = Math.max(
        ...moving.slice(1).map((frame, index) => frame.runElapsedMs - moving[index].runElapsedMs),
      );
      metrics[side] = {
        frames: track.frames.length,
        distinctPositions: positions.size,
        maxMovingGapMs,
        pulses,
        clockErrorBoundMs: track.clock.errorBoundMs,
      };
      assert(positions.size >= 60, `${side} actual positions ${positions.size}`);
      assert(maxMovingGapMs <= 200, `${side} moving source gap ${maxMovingGapMs}`);
    }
    assert.equal(metrics.before.pulses.length, 3);
    assert.equal(metrics.after.pulses.length, 3);
    process.stderr.write(`SOURCE_METRICS ${JSON.stringify(metrics)}\n`);
    const pulseErrorsMs = metrics.before.pulses.map((time, index) => Math.abs(time - metrics.after.pulses[index]));
    assert(Math.max(...pulseErrorsMs) <= 80);
    const settingsComposer = {
      coverage: { selected: [], unresolved: [], omitted: [], unsupported: [], complete: true },
      provenance: {
        before: { valid: true, actualHash: null, errors: [] },
        after: { valid: true, actualHash: null, errors: [] },
      },
    };
    const timeline = await render(bundle, settingsComposer, run);
    validateTimelineCapture(timeline, bundle);
    const media = await encode(timeline, run);
    const decoded = join(root, 'decoded');
    await mkdir(decoded);
    await new Promise((done, reject) => {
      const child = spawn(
        process.env.SWC_FFMPEG ?? 'ffmpeg',
        [
          '-v',
          'error',
          '-i',
          join(run.paths.runDir, media.video.path),
          '-fps_mode',
          'passthrough',
          join(decoded, '%04d.png'),
        ],
        { stdio: ['ignore', 'ignore', 'pipe'] },
      );
      let error = '';
      child.stderr.on('data', (value) => (error += value));
      child.on('error', reject);
      child.on('exit', (code) => (code === 0 ? done() : reject(new Error(error))));
    });
    const decodedPositions = { before: new Set(), after: new Set() };
    const decodedPulses = { before: [], after: [] };
    const previousPulse = { before: false, after: false };
    for (const file of (await readdir(decoded)).sort()) {
      const image = PNG.sync.read(await readFile(join(decoded, file)));
      const frame = Number(file.slice(0, 4)) - 1;
      for (const side of ['before', 'after']) {
        const xOffset = side === 'before' ? 0 : 962;
        const crop = new PNG({ width: 958, height: 598 });
        PNG.bitblt(image, crop, xOffset, 48, 958, 598, 0, 0);
        const value = observe(crop);
        if (value.x !== null) decodedPositions[side].add(value.x);
        if (value.pulse && !previousPulse[side]) decodedPulses[side].push((frame * 1000) / 30);
        previousPulse[side] = value.pulse;
        const p = (120 * crop.width + 100) * 4;
        if (frame >= 30) {
          for (let y = 76; y < 172; y++)
            for (let x = 81; x < 218; x++) {
              const masked = (y * crop.width + x) * 4;
              assert(
                crop.data[masked] < 85 && crop.data[masked + 1] < 85 && crop.data[masked + 2] < 85,
                'Decoded sensitive rectangle absent',
              );
            }
        }
      }
    }
    for (const side of ['before', 'after'])
      assert(decodedPositions[side].size >= 60, `${side} decoded positions ${decodedPositions[side].size}`);
    for (const side of ['before', 'after']) assert.equal(decodedPulses[side].length, 3);
    const decodedPulseErrorsMs = decodedPulses.before.map((time, index) => Math.abs(time - decodedPulses.after[index]));
    assert(Math.max(...decodedPulseErrorsMs) <= 80);
    const dispatchSkewMs = Math.abs(
      bundle.motion[0].steps[1].before.dispatch.runElapsedMs - bundle.motion[0].steps[1].after.dispatch.runElapsedMs,
    );
    const result = {
      host,
      processing,
      dispatchSkewMs,
      decodedPulseErrorsMs,
      root: run.paths.runDir,
      video: join(run.paths.runDir, media.video.path),
      metrics,
      pulseErrorsMs,
      decodedDistinctPositions: Object.fromEntries(
        Object.entries(decodedPositions).map(([side, positions]) => [side, positions.size]),
      ),
      decodedPulses,
      totalFrames: timeline.totalFrames,
      media,
    };
    await writeFile(join(root, 'result.json'), JSON.stringify(result, null, 2));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
} finally {
  if (run) await cleanupRun(run);
  await Promise.all(
    servers.map(
      (server) =>
        new Promise((done) => {
          server.closeAllConnections();
          server.close(done);
        }),
    ),
  );
}
