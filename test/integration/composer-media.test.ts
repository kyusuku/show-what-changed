import { createServer } from 'node:http';
import { capture as record } from '../../src/recorder/index.js';
import { execFile } from 'node:child_process';
import {
  chmod,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { afterEach, describe, expect, it } from 'vitest';
import { render as renderOriginal, encode, checkMediaCapabilities } from '../../src/composer/index.js';
import { comparisonTemplate } from '../../src/composer/template.js';
import { readPng, validatePng } from '../../src/composer/images.js';
import { createRunContext, cleanupRun } from '../../src/runtime/context.js';
import { openBrowser } from '../../src/runtime/browser.js';
import { writeRunFile } from '../../src/runtime/files.js';
import { CaptureBundleSchema, TimelineSchema, CaptureSettingsSchema, ScenarioSchema } from '../../src/schema/index.js';
import { sha256 } from '../../src/schema/io.js';
import type { CaptureBundle, Timeline } from '../../src/schema/index.js';
import type { ComposerSettings, RunContext } from '../../src/schema/contracts.js';
import { failure } from '../../src/schema/errors.js';

const exec = promisify(execFile);
const fixture = CaptureBundleSchema.parse(
  JSON.parse(await readFile(new URL('../fixtures/capture.json', import.meta.url), 'utf8')),
);
const media = { ffmpeg: process.env.SWC_FFMPEG ?? 'ffmpeg', ffprobe: process.env.SWC_FFPROBE ?? 'ffprobe' };
const settings: ComposerSettings = {
  coverage: { selected: [], unresolved: [], omitted: [], unsupported: [], complete: true },
  provenance: {
    before: { valid: true, actualHash: null, errors: [] },
    after: { valid: true, actualHash: null, errors: [] },
  },
};
async function render(bundle: CaptureBundle, settings: ComposerSettings, run: RunContext): Promise<Timeline> {
  await writeRunFile(run, 'capture.json', `${JSON.stringify(bundle, null, 2)}\n`);
  return renderOriginal(bundle, settings, run);
}
const roots: string[] = [];
const runs: RunContext[] = [];

async function context(signal: AbortSignal = new AbortController().signal): Promise<RunContext> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'swc-composer-')));
  roots.push(root);
  const run = await createRunContext({ repoRoot: root, timeoutMs: 120_000, signal, diagnostics: { event: () => {} } });
  runs.push(run);
  return run;
}
async function capture(run: RunContext): Promise<CaptureBundle> {
  const bundle = structuredClone(fixture);
  bundle.runId = run.runId;
  for (const side of ['before', 'after'] as const) {
    const bytes = await readFile(new URL(`../fixtures/composer-${side}.png`, import.meta.url));
    await writeRunFile(run, `source/${side}.png`, bytes);
  }
  await writeRunFile(run, 'capture.json', `${JSON.stringify(bundle, null, 2)}\n`);
  return bundle;
}
function pixel(png: PNG, x: number, y: number): number[] {
  return [...png.data.subarray((y * png.width + x) * 4, (y * png.width + x) * 4 + 3)];
}
function meanError(left: PNG, right: PNG): number {
  let sum = 0;
  for (let offset = 0; offset < left.data.length; offset += 4)
    for (let channel = 0; channel < 3; channel++)
      sum += Math.abs((left.data[offset + channel] ?? 0) - (right.data[offset + channel] ?? 0));
  return sum / (left.width * left.height * 3);
}
async function extract(run: RunContext, frame: number): Promise<PNG> {
  const output = join(run.paths.runDir, 'private', `extract-${frame}.png`);
  await exec(media.ffmpeg, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    join(run.paths.runDir, 'compare.mp4'),
    '-vf',
    `select=eq(n\\,${frame})`,
    '-fps_mode',
    'vfr',
    '-frames:v',
    '1',
    output,
  ]);
  return PNG.sync.read(await readFile(output));
}
async function saveEvidence(run: RunContext, paths: string[], prefix = 'success-'): Promise<void> {
  const root = join(run.paths.privateDir, 'test-evidence');
  await mkdir(root, { recursive: true });
  for (const path of paths)
    await copyFile(join(run.paths.runDir, path), join(root, prefix + path.replaceAll('/', '-')));
}

afterEach(async () => {
  for (const run of runs.splice(0)) expect((await cleanupRun(run)).status).toBe('ok');
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('T07 T09 T10 T11 real composer media', () => {
  it('closes an interrupted rendering context once and releases its owned lock', async () => {
    const controller = new AbortController();
    const run = await context(controller.signal);
    const bundle = await capture(run);
    const source = bundle.scenarios[0];
    const step = source?.steps[0];
    if (!source || !step) throw new Error('fixture needs a scenario');
    bundle.scenarios = Array.from({ length: 3 }, (_, scenario) => ({
      ...source,
      id: `scenario-${scenario}`,
      steps: Array.from({ length: 12 }, (_, index) => ({ ...step, id: `step-${index}` })),
    }));
    const result = render(bundle, settings, run).then(
      () => null,
      (error: unknown) => error,
    );
    const deadline = performance.now() + 15_000;
    while (true) {
      if (
        await stat(join(run.paths.composedDir, '000-title.png')).then(
          () => true,
          () => false,
        )
      )
        break;
      if (performance.now() > deadline) throw new Error('Renderer did not produce its first frame');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    controller.abort(failure(10, 'DEADLINE_EXCEEDED', 'execution', 'Test deadline.', 'Retry.'));
    expect(await result).toMatchObject({ exitCode: 10 });
    expect(await cleanupRun(run)).toEqual({ status: 'ok', errors: [] });
    expect(
      await stat(join(run.paths.repoRoot, '.show-what-changed/run.lock')).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  }, 30_000);

  it('renders isolated masked inputs and encodes exact first, boundary, midpoint and final frames with faststart', async () => {
    const run = await context();
    const bundle = await capture(run);
    const step = bundle.scenarios[0]?.steps[0];
    if (!step) throw new Error('fixture needs step');
    step.observeMs = 801;
    const original = structuredClone(bundle);
    const timeline = await render(bundle, settings, run);
    expect(bundle).toEqual(original);
    expect(timeline.totalFrames).toBe(55);
    expect(timeline.segments.map((segment) => segment.durationFrames)).toEqual([30, 25]);
    const title = PNG.sync.read(await readFile(join(run.paths.runDir, 'composed/000-title.png')));
    const image = PNG.sync.read(await readFile(join(run.paths.runDir, 'composed/001-step.png')));
    expect([image.width, image.height]).toEqual([1920, 686]);
    expect(pixel(image, 959, 300)).toEqual([100, 116, 139]);
    expect(pixel(image, 100, 275)).toEqual([15, 23, 42]);
    expect(pixel(image, 1062, 275)).toEqual([15, 23, 42]);
    expect(pixel(image, 900, 100)).toEqual([219, 234, 254]);
    expect(pixel(image, 1862, 100)).toEqual([220, 252, 231]);
    const previous = process.env.PLAYWRIGHT_BROWSERS_PATH;
    process.env.PLAYWRIGHT_BROWSERS_PATH = join(run.paths.runDir, 'browser-does-not-exist');
    try {
      const result = await encode(timeline, run);
      expect(result.video.path).toBe('compare.mp4');
      expect(result.video.sha256).toBe(sha256(await readFile(join(run.paths.runDir, result.video.path))));
      expect(result.poster.sha256).toBe(sha256(await readFile(join(run.paths.runDir, timeline.poster))));
      expect((await stat(join(run.paths.runDir, 'compare.mp4'))).mode & 0o777).toBe(0o600);
    } finally {
      if (previous === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH;
      else process.env.PLAYWRIGHT_BROWSERS_PATH = previous;
    }
    const video = await readFile(join(run.paths.runDir, 'compare.mp4'));
    expect(video.indexOf(Buffer.from('moov'))).toBeLessThan(video.indexOf(Buffer.from('mdat')));
    const probe = JSON.parse(
      (
        await exec(media.ffprobe, [
          '-v',
          'error',
          '-count_frames',
          '-show_streams',
          '-show_format',
          '-of',
          'json',
          join(run.paths.runDir, 'compare.mp4'),
        ])
      ).stdout,
    );
    expect(probe.streams).toHaveLength(1);
    expect(probe.streams[0]).toMatchObject({
      codec_name: 'h264',
      codec_type: 'video',
      pix_fmt: 'yuv420p',
      width: 1920,
      height: 686,
      r_frame_rate: '30/1',
      avg_frame_rate: '30/1',
      nb_read_frames: '55',
    });
    expect(Math.abs(Number(probe.format.duration) - 55 / 30)).toBeLessThanOrEqual(1 / 30);
    for (const frame of [0, 27, 29, 30, 42, 54]) {
      const actual = await extract(run, frame);
      const expected = frame < 30 ? title : image;
      const wrong = frame < 30 ? image : title;
      expect(meanError(actual, expected)).toBeLessThan(3);
      expect(meanError(actual, wrong)).toBeGreaterThan(10);
      if (frame >= 30)
        for (const x of [100, 1062])
          for (const [channel, expectedChannel] of pixel(actual, x, 275).map((value, index) => [
            value,
            [15, 23, 42][index] ?? 0,
          ]))
            expect(Math.abs((channel ?? 0) - (expectedChannel ?? 0))).toBeLessThan(8);
    }
    await writeFile(join(run.paths.runDir, 'private/ffprobe.json'), `${JSON.stringify(probe, null, 2)}\n`);
    await saveEvidence(run, [
      'timeline.json',
      'compare.mp4',
      'poster.png',
      'composed/000-title.png',
      'composed/001-step.png',
      'private/ffprobe.json',
    ]);
  }, 120_000);

  it('contains template geometry, local font, storage, clock and injection inputs in a real browser', async () => {
    const run = await context();
    const browser = await openBrowser(run);
    const captureContext = await browser.newContext();
    await captureContext.addCookies([{ name: 'app-only', value: 'secret', url: 'https://fixture.invalid' }]);
    const app = await captureContext.newPage();
    await app.clock.setFixedTime(new Date('2000-01-01T00:00:00Z'));
    const renderer = await browser.newContext({
      viewport: { width: 1920, height: 686 },
      deviceScaleFactor: 1,
      serviceWorkers: 'block',
    });
    let requests = 0;
    await renderer.route('**/*', async (route) => {
      requests++;
      await route.abort();
    });
    const page = await renderer.newPage();
    const font = await readFile(new URL('../../assets/fonts/Inter-Regular.woff2', import.meta.url));
    await page.setContent(comparisonTemplate(font.toString('base64')));
    const state = await page.evaluate(async () => {
      const label = document.getElementById('before-label');
      if (!label) throw new Error('Missing label');
      label.textContent = '<img src=https://private.invalid onerror=alert(1)> '.repeat(50);
      await document.fonts.load('20px Inter');
      await document.fonts.ready;
      const bounds = ['labels', 'panels', 'caption'].map((id) => {
        const rect = document.getElementById(id)?.getBoundingClientRect();
        return rect ? [rect.x, rect.y, rect.width, rect.height] : null;
      });
      let blocked = false;
      try {
        await fetch('https://must-be-blocked.invalid');
      } catch {
        blocked = true;
      }
      return {
        dpr: devicePixelRatio,
        bounds,
        fontLoaded: document.fonts.check('20px Inter'),
        year: new Date().getUTCFullYear(),
        injectedImages: label.querySelectorAll('img').length,
        ellipsis: getComputedStyle(label).textOverflow,
        overflow: label.scrollWidth > label.clientWidth,
        blocked,
        csp: document.querySelector('meta[http-equiv]')?.getAttribute('content'),
      };
    });
    expect(state.dpr).toBe(1);
    expect(state.bounds).toEqual([
      [0, 0, 1920, 48],
      [0, 48, 1920, 598],
      [0, 646, 1920, 40],
    ]);
    expect(state.fontLoaded).toBe(true);
    expect(state.year).toBe(new Date().getUTCFullYear());
    expect(state.injectedImages).toBe(0);
    expect(state.ellipsis).toBe('ellipsis');
    expect(state.overflow).toBe(true);
    expect(state.blocked).toBe(true);
    expect(state.csp).toContain("script-src 'none'");
    expect(requests).toBe(0);
    expect((await renderer.storageState()).cookies).toEqual([]);
    expect((await captureContext.storageState()).cookies).toHaveLength(1);
    await renderer.close();
    await captureContext.close();
    await browser.close();
  }, 60_000);

  it('renders a first failed neutral panel with visible title and per-side incomplete badges', async () => {
    const run = await context();
    const bundle = await capture(run);
    const scenario = bundle.scenarios[0];
    const step = scenario?.steps[0];
    if (!scenario || !step) throw new Error('fixture needs step');
    const neutral = new PNG({ width: 1280, height: 800 });
    for (let offset = 0; offset < neutral.data.length; offset += 4) {
      neutral.data[offset] = 15;
      neutral.data[offset + 1] = 23;
      neutral.data[offset + 2] = 42;
      neutral.data[offset + 3] = 255;
    }
    const neutralBytes = PNG.sync.write(neutral);
    await writeRunFile(run, 'source/neutral.png', neutralBytes);
    scenario.outcome = 'partial';
    step.before = {
      ...step.before,
      status: 'failed',
      reasonCode: 'NAVIGATION_FAILED',
      image: { path: 'source/neutral.png', sha256: sha256(neutralBytes), bytes: neutralBytes.length },
      imageKind: 'neutral',
      sanitization: { kind: 'neutral' },
    };
    step.changeRatio = null;
    const timeline = await render(bundle, { ...settings, coverage: { ...settings.coverage, complete: false } }, run);
    expect(timeline.poster).toBe('composed/001-step.png');
    const png = PNG.sync.read(await readFile(join(run.paths.runDir, timeline.poster)));
    expect(pixel(png, 100, 300)).toEqual([15, 23, 42]);
    expect(pixel(png, 1862, 100)).toEqual([220, 252, 231]);
    let badgePixels = 0;
    for (let y = 8; y < 40; y++)
      for (let x = 350; x < 958; x++) if (pixel(png, x, y).join() === '124,45,18') badgePixels++;
    expect(badgePixels).toBeGreaterThan(1000);
    await encode(timeline, run);
    await saveEvidence(
      run,
      ['compare.mp4', 'poster.png', 'timeline.json', 'composed/000-title.png', 'composed/001-step.png'],
      'partial-',
    );
  }, 120_000);

  it('validates all imported paths, compressed limits, dimensions, hashes and cumulative boundaries before encoding', async () => {
    const run = await context();
    const bundle = await capture(run);
    const timeline = await render(bundle, settings, run);
    const image = timeline.images[0];
    if (!image) throw new Error('fixture needs image');
    await expect(encode({ ...timeline, totalFrames: timeline.totalFrames + 1 }, run)).rejects.toMatchObject({
      exitCode: 9,
    });
    await expect(
      encode({ ...timeline, images: [{ ...image, sha256: '0'.repeat(64) }, ...timeline.images.slice(1)] }, run),
    ).rejects.toMatchObject({ detail: { code: 'TIMELINE_CAPTURE_MISMATCH' } });
    const outside = join(run.paths.repoRoot, 'outside.png');
    await writeFile(outside, await readFile(join(run.paths.runDir, timeline.poster)));
    await symlink(outside, join(run.paths.runDir, 'linked.png'));
    await expect(readPng(run.paths.runDir, 'linked.png', 1920, 686)).rejects.toMatchObject({ exitCode: 9 });
    await expect(readPng(run.paths.runDir, '../outside.png', 1920, 686)).rejects.toMatchObject({ exitCode: 9 });
    await expect(readPng(run.paths.runDir, '/outside.png', 1920, 686)).rejects.toMatchObject({ exitCode: 9 });
    await writeRunFile(run, 'source/oversized.png', Buffer.alloc(16 * 1024 * 1024 + 1));
    await expect(readPng(run.paths.runDir, 'source/oversized.png', 1280, 800)).rejects.toMatchObject({ exitCode: 9 });
    const wrong = PNG.sync.write(new PNG({ width: 1, height: 1 }));
    expect(() => validatePng(wrong, 1280, 800)).toThrow();
    const badBundle = structuredClone(bundle);
    const step = badBundle.scenarios[0]?.steps[0];
    if (!step) throw new Error('fixture needs step');
    step.before.image.path = 'source/missing.png';
    await expect(render(badBundle, settings, run)).rejects.toMatchObject({ exitCode: 9 });
    expect(sha256(await readFile(join(run.paths.runDir, 'source/before.png')))).toBe(
      sha256(await readFile(new URL('../fixtures/composer-before.png', import.meta.url))),
    );
  }, 60_000);

  it('retains composed frames and prior valid media when a real encoder invocation fails, then recovers without a browser', async () => {
    const run = await context();
    const bundle = await capture(run);
    const timeline = await render(bundle, settings, run);
    await encode(timeline, run);
    const beforeVideo = sha256(await readFile(join(run.paths.runDir, 'compare.mp4')));
    const wrapper = join(run.paths.runDir, 'private/failing-ffmpeg.mjs');
    await writeFile(
      wrapper,
      `#!${process.execPath}\nimport{spawnSync}from'node:child_process';const a=process.argv.slice(2);if(a[a.indexOf('-frames:v')+1]==='54')process.exit(1);const p=spawnSync(${JSON.stringify(media.ffmpeg)},a,{stdio:'inherit'});process.exit(p.status??1);\n`,
      { mode: 0o700 },
    );
    await chmod(wrapper, 0o700);
    const previous = process.env.SWC_FFMPEG;
    process.env.SWC_FFMPEG = wrapper;
    try {
      await expect(encode(timeline, run)).rejects.toMatchObject({ exitCode: 9 });
    } finally {
      if (previous === undefined) delete process.env.SWC_FFMPEG;
      else process.env.SWC_FFMPEG = previous;
    }
    expect(sha256(await readFile(join(run.paths.runDir, 'compare.mp4')))).toBe(beforeVideo);
    for (const image of timeline.images)
      expect(sha256(await readFile(join(run.paths.runDir, image.path)))).toBe(image.sha256);
    const reloaded: Timeline = TimelineSchema.parse(
      JSON.parse(await readFile(join(run.paths.runDir, 'timeline.json'), 'utf8')),
    );
    await rm(join(run.paths.runDir, 'poster.png'));
    const recovered = await encode(reloaded, run);
    expect(recovered.video.bytes).toBeGreaterThan(0);
    expect(recovered.poster.sha256).toBe(sha256(await readFile(join(run.paths.runDir, timeline.poster))));
  }, 120_000);

  it('reopens persisted images in a fresh process with no browser installation or bundled font assets', async () => {
    const run = await context();
    const timeline = await render(await capture(run), settings, run);
    await encode(timeline, run);
    expect((await cleanupRun(run)).status).toBe('ok');
    const isolatedPackage = join(run.paths.repoRoot, 'encoder-package');
    await cp(new URL('../../src/', import.meta.url), join(isolatedPackage, 'src'), { recursive: true });
    await writeFile(join(isolatedPackage, 'package.json'), '{"type":"module"}');
    await symlink(
      fileURLToPath(new URL('../../node_modules/', import.meta.url)),
      join(isolatedPackage, 'node_modules'),
    );
    const script = join(isolatedPackage, 'encode.mjs');
    await writeFile(
      script,
      `import{registerHooks}from'node:module';import{readFile}from'node:fs/promises';registerHooks({resolve(s,c,n){if(c.parentURL?.startsWith(new URL('./src/',import.meta.url).href)&&s.startsWith('.')&&s.endsWith('.js'))return n(s.replace(/\\.js$/,'.ts'),c);return n(s,c)}});const{encode,render}=await import('./src/composer/index.ts');const{reopenRunContext,cleanupRun}=await import('./src/runtime/context.ts');const run=await reopenRunContext({runDir:${JSON.stringify(run.paths.runDir)},timeoutMs:60000,signal:new AbortController().signal,diagnostics:{event(){}}});try{const capture=JSON.parse(await readFile(run.paths.runDir+'/capture.json','utf8'));let fontFailure=false;try{await render(capture,${JSON.stringify(settings)},run);}catch(error){fontFailure=error.detail?.code==='FONT_UNAVAILABLE';}if(!fontFailure)throw Error('Missing-font rendering must fail');const timeline=JSON.parse(await readFile(run.paths.runDir+'/timeline.json','utf8'));const media=await encode(timeline,run);process.stdout.write(JSON.stringify({media,fontFailure}));}finally{const result=await cleanupRun(run);if(result.status!=='ok')process.exitCode=1}`,
    );
    const result = await exec(process.execPath, ['--experimental-transform-types', script], {
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        TMPDIR: tmpdir(),
        PLAYWRIGHT_BROWSERS_PATH: join(isolatedPackage, 'browser-unavailable'),
      },
      timeout: 60_000,
    });
    const encoded: unknown = JSON.parse(result.stdout);
    expect(encoded).toMatchObject({
      media: { video: { path: 'compare.mp4' }, poster: { path: 'poster.png' } },
      fontFailure: true,
    });
    expect(sha256(await readFile(join(run.paths.runDir, 'source/before.png')))).toBe(
      sha256(await readFile(new URL('../fixtures/composer-before.png', import.meta.url))),
    );
    expect(sha256(await readFile(join(run.paths.runDir, 'poster.png')))).toBe(
      timeline.images.find((image) => image.path === timeline.poster)?.sha256,
    );
  }, 120_000);

  it('encodes actual odd narrow motion viewports without upscaling and keeps their letterboxes', async () => {
    const run = await context();
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(
        '<style>html,body{margin:0;background:#20c850;width:100%;height:100%}</style><div style="width:20px;height:20px;background:red">SYNTHETIC</div>',
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing port');
      const make = (side: 'before' | 'after') => ({
        side,
        origin: `http://127.0.0.1:${address.port}`,
        port: address.port,
        sourceLabel: `${side} synthetic`,
        source: { requested: side, commit: 'a'.repeat(40), kind: 'commit' as const, materializedHash: 'b'.repeat(64) },
        storageState: null,
        exited: new Promise<never>(() => {}),
      });
      const bundle = await record(
        { before: make('before'), after: make('after') },
        [
          ScenarioSchema.parse({
            schemaVersion: 2,
            id: 'narrow',
            title: 'Narrow actual motion',
            steps: [{ id: 'open', op: 'goto', path: '/', observeMs: 150 }],
          }),
        ],
        CaptureSettingsSchema.parse({
          mode: 'motion',
          viewport: { width: 391, height: 241 },
          maskRects: [{ x: 0, y: 0, width: 20, height: 20 }],
        }),
        run,
      );
      expect(bundle.scenarios[0]?.outcome, JSON.stringify({
        scenarios: bundle.scenarios.map((scenario) => ({
          outcome: scenario.outcome,
          errors: scenario.errors.map(({ code, phase, side, stepId }) => ({ code, phase, side, stepId })),
          steps: scenario.steps.map((step) => ({
            id: step.id,
            before: { status: step.before.status, reasonCode: step.before.reasonCode },
            after: { status: step.after.status, reasonCode: step.after.reasonCode },
          })),
        })),
        motion: bundle.captureMode === 'motion' ? bundle.motion.map((scenario) => ({
          timing: scenario.timing,
          steps: scenario.steps,
          tracks: Object.entries(scenario.tracks).map(([side, track]) => ({
            side,
            status: track.status,
            errorCode: track.error?.code ?? null,
            failureAtMs: track.status === 'failed' ? track.failureAtMs : null,
            clock: track.clock,
            stats: track.stats,
          })),
        })) : null,
      })).toBe('ok');
      const timeline = await render(bundle, settings, run);
      await encode(timeline, run);
      const actual = await extract(run, timeline.totalFrames - 1);
      for (const offset of [0, 962]) {
        expect(
          pixel(actual, offset + 200, 300).every((value, index) => Math.abs(value - ([15, 23, 42][index] ?? 0)) < 8),
        ).toBe(true);
        expect(
          pixel(actual, offset + 600, 300).every((value, index) => Math.abs(value - ([32, 200, 80][index] ?? 0)) < 12),
        ).toBe(true);
        expect(pixel(actual, offset + 292, 236).every((value) => value < 65)).toBe(true);
      }
    } finally {
      await new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
    }
  }, 120000);

  it('requires an actual encode/probe and rejects unavailable or nonabsolute executable overrides', async () => {
    const run = await context();
    const previous = process.env.SWC_FFMPEG;
    try {
      process.env.SWC_FFMPEG = '/nonexistent/ffmpeg';
      await expect(checkMediaCapabilities(run)).rejects.toMatchObject({ exitCode: 8 });
      process.env.SWC_FFMPEG = 'ffmpeg';
      await expect(checkMediaCapabilities(run)).rejects.toMatchObject({ exitCode: 8 });
    } finally {
      if (previous === undefined) delete process.env.SWC_FFMPEG;
      else process.env.SWC_FFMPEG = previous;
    }
  }, 60_000);
});
