import { PNG } from 'pngjs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BrowserContext } from 'playwright';
import { openBrowser } from '../runtime/browser.js';
import { artifactInfo, readRunFile, renameRunFile, writeRunFile } from '../runtime/files.js';
import { CaptureBundleSchema, CoverageSchema, MediaSchema, ProvenanceSchema, TimelineSchema } from '../schema/index.js';
import type { CaptureBundle, Media, Timeline } from '../schema/index.js';
import type { ComposerSettings, RunContext } from '../schema/contracts.js';
import { checkCancelled, failure, ToolFailure } from '../schema/errors.js';
import { digest, sha256 } from '../schema/io.js';
import { checkMediaCapabilities } from './capabilities.js';
import { MAX_PNG_BYTES, readPng, validatePng } from './images.js';
import { buildPresentation, presentationWarnings } from './presentation.js';
import { validateMedia } from './probe.js';
import { remainingMs, writeEncoderFrames } from './process.js';
import { validateDecodedBoundaries } from './decoded.js';
import { packFrame, packedEncodingArgs } from './packed.js';
import { selectSource } from './presentation.js';
import { comparisonTemplate } from './template.js';

export { presentationWarnings } from './presentation.js';
export { checkMediaCapabilities } from './capabilities.js';

export async function render(input: CaptureBundle, settings: ComposerSettings, run: RunContext): Promise<Timeline> {
  const parsed = CaptureBundleSchema.safeParse(input);
  const coverage = CoverageSchema.safeParse(settings.coverage);
  const provenance = ProvenanceSchema.safeParse(settings.provenance);
  if (!parsed.success || !coverage.success || !provenance.success || parsed.data.runId !== run.runId)
    throw failure(
      9,
      'CAPTURE_INPUT_INVALID',
      'rendering',
      'The capture bundle or presentation settings are invalid for this run.',
      'Use the original capture bundle and comparison settings.',
    );
  const bundle = parsed.data;
  const hasSafeSource =
    bundle.scenarios.some((scenario) =>
      scenario.steps.some((step) => step.before.imageKind !== 'neutral' || step.after.imageKind !== 'neutral'),
    ) ||
    (bundle.captureMode === 'motion' &&
      bundle.motion.some(
        (scenario) => scenario.tracks.before.frames.length > 0 || scenario.tracks.after.frames.length > 0,
      ));
  if (!hasSafeSource)
    throw failure(
      9,
      'CAPTURE_MEDIA_UNAVAILABLE',
      'rendering',
      'No usable sanitized capture is available.',
      'Create a new comparison after resolving the recorded capture faults.',
    );
  const model = buildPresentation(bundle, { coverage: coverage.data, provenance: provenance.data });
  let context: BrowserContext | undefined;
  let browser: Awaited<ReturnType<typeof openBrowser>> | undefined;
  let closing: Promise<void> | undefined;
  const closeContext = (): Promise<void> => {
    closing ??= (async () => {
      if (!context || !browser?.isConnected()) return;
      try {
        await context.close();
      } catch (error) {
        if (browser.isConnected()) throw error;
      }
    })();
    return closing;
  };
  const abort = (): void => {
    void closeContext().catch(() => {});
  };
  try {
    remainingMs(run);
    for (const scenario of bundle.scenarios)
      for (const step of scenario.steps)
        for (const side of ['before', 'after'] as const) {
          remainingMs(run);
          await readPng(
            run.paths.runDir,
            step[side].image.path,
            bundle.viewport.width,
            bundle.viewport.height,
            step[side].image,
          );
        }
    let font: Buffer;
    try {
      font = await readFile(new URL('../../assets/fonts/Inter-Regular.woff2', import.meta.url));
      if (
        font.length > 1024 * 1024 ||
        font.subarray(0, 4).toString() !== 'wOF2' ||
        sha256(font) !== 'e06f6b1bc553aaea4e4668023ed0ab0a147129c3107f511bc7d03d361b0ae085'
      )
        throw new Error('Font integrity failed');
    } catch {
      throw failure(
        8,
        'FONT_UNAVAILABLE',
        'rendering',
        'The bundled presentation font is missing or invalid.',
        'Reinstall the package with its bundled assets and run doctor.',
      );
    }
    for (const warning of presentationWarnings(bundle, settings)) run.diagnostics.event(warning.code);
    browser = await openBrowser(run);
    context = await browser.newContext({
      viewport: { width: 1920, height: 686 },
      deviceScaleFactor: 1,
      serviceWorkers: 'block',
      reducedMotion: 'reduce',
      colorScheme: 'light',
      locale: 'en-US',
      timezoneId: 'UTC',
    });
    run.resources.register({ kind: 'context', identity: 'composer-template-v2', dispose: closeContext });
    run.signal.addEventListener('abort', abort, { once: true });
    checkCancelled(run.signal);
    let networkAttempts = 0;
    await context.route('**/*', async (route) => {
      networkAttempts++;
      await route.abort();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(remainingMs(run));
    await page.setContent(comparisonTemplate(font.toString('base64')), {
      waitUntil: 'domcontentloaded',
      timeout: remainingMs(run),
    });
    const images: Timeline['images'] = [];
    for (const segment of model.cards) {
      remainingMs(run);
      const before = segment.beforeImage
        ? `data:image/png;base64,${(await readPng(run.paths.runDir, segment.beforeImage, bundle.viewport.width, bundle.viewport.height)).toString('base64')}`
        : null;
      const after = segment.afterImage
        ? `data:image/png;base64,${(await readPng(run.paths.runDir, segment.afterImage, bundle.viewport.width, bundle.viewport.height)).toString('base64')}`
        : null;
      const loaded = await page.evaluate(
        async ({ segment, before, after }) => {
          const text = (id: string, value: string): void => {
            const element = document.getElementById(id);
            if (!element) throw new Error('Missing trusted template element');
            element.textContent = value;
          };
          text('before-label', segment.beforeLabel);
          text('after-label', segment.afterLabel);
          text('before-badge', segment.beforeBadge);
          text('after-badge', segment.afterBadge);
          text('caption', segment.caption);
          text('title', segment.title);
          text('route', segment.route);
          text('caveats', segment.caption);
          text(
            'mode-detail',
            segment.beforeLabel.includes('MOTION')
              ? 'Actual browser motion. Shared elapsed clock.'
              : 'Step-aligned keyframes. No continuous motion.',
          );
          document.body.className = segment.kind;
          for (const [id, data] of [
            ['before-image', before],
            ['after-image', after],
          ]) {
            const element = document.getElementById(id ?? '');
            if (!(element instanceof HTMLImageElement)) throw new Error('Missing trusted image element');
            if (data) {
              element.src = data;
              await element.decode();
            } else element.removeAttribute('src');
          }
          await document.fonts.load('20px Inter');
          await document.fonts.ready;
          await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
          return (
            document.fonts.check('20px Inter') &&
            [...document.fonts].some((face) => face.family === 'Inter' && face.status === 'loaded')
          );
        },
        { segment, before, after },
      );
      if (!loaded || networkAttempts !== 0) throw new Error('Trusted template asset or network policy failed');
      const png = await page.screenshot({
        type: 'png',
        fullPage: false,
        animations: 'disabled',
        caret: 'hide',
        omitBackground: segment.kind === 'overlay',
        timeout: remainingMs(run),
      });
      validatePng(png, 1920, 686);
      if (segment.kind === 'overlay') {
        const overlay = PNG.sync.read(png);
        if (overlay.data[(100 * 1920 + 200) * 4 + 3] !== 0 || overlay.data[(20 * 1920 + 200) * 4 + 3] !== 255)
          throw new Error('Trusted overlay transparency failed');
      }
      await writeRunFile(run, segment.image, png);
      images.push({ path: segment.image, sha256: sha256(png), bytes: png.length });
    }
    const sourceArtifacts = [
      ...bundle.scenarios.flatMap((scenario) =>
        scenario.steps.flatMap((step) => [step.before.image, step.after.image]),
      ),
      ...(bundle.captureMode === 'motion'
        ? bundle.motion.flatMap((scenario) =>
            [...scenario.tracks.before.frames, ...scenario.tracks.after.frames].map((frame) => frame.artifact),
          )
        : []),
    ];
    const table = new Map([...sourceArtifacts, ...images].map((artifact) => [artifact.path, artifact]));
    const timeline = TimelineSchema.parse({
      schemaVersion: 2,
      runId: run.runId,
      captureMode: bundle.captureMode,
      fps: 30,
      templateVersion: 2,
      width: 1920,
      height: 686,
      viewport: bundle.viewport,
      captureSha256: digest(bundle),
      totalFrames: model.totalFrames,
      segments: model.segments,
      selections: model.selections,
      stepBoundaries: model.stepBoundaries,
      annotations: model.annotations,
      posterSelection: model.posterSelection,
      poster: model.poster,
      images: [...table.values()],
    });
    validateTimelineCapture(timeline, bundle);
    await writeRunFile(run, 'poster.png', await readRunFile(run.paths.runDir, timeline.poster, MAX_PNG_BYTES));
    await writeRunFile(run, 'timeline.json', `${JSON.stringify(timeline, null, 2)}\n`);
    return timeline;
  } catch (error) {
    checkCancelled(run.signal);
    if (error instanceof ToolFailure) throw error;
    throw failure(
      9,
      'RENDER_FAILED',
      'rendering',
      'The comparison template could not be rendered. Masked source images were retained.',
      'Inspect the saved source images and private diagnostics, then create a new comparison.',
    );
  } finally {
    run.signal.removeEventListener('abort', abort);
    await closeContext().catch(() => {});
    await browser?.close().catch(() => {});
  }
}

export function validateTimelineCapture(input: Timeline, capture: CaptureBundle): void {
  const timeline = TimelineSchema.parse(input);
  const bundle = CaptureBundleSchema.parse(capture);
  const reject = () => {
    throw failure(
      9,
      'TIMELINE_CAPTURE_MISMATCH',
      'encoding',
      'The timeline does not describe the original capture.',
      'Restore both original capture and timeline documents.',
    );
  };
  if (
    timeline.runId !== bundle.runId ||
    timeline.captureMode !== bundle.captureMode ||
    timeline.captureSha256 !== digest(bundle) ||
    digest(timeline.viewport) !== digest(bundle.viewport)
  )
    reject();
  const model = buildPresentation(bundle, {
    coverage: { selected: [], unresolved: [], omitted: [], unsupported: [], complete: true },
    provenance: {
      before: { valid: true, actualHash: null, errors: [] },
      after: { valid: true, actualHash: null, errors: [] },
    },
  });
  for (const key of ['segments', 'stepBoundaries', 'annotations', 'posterSelection', 'selections'] as const)
    if (digest(timeline[key]) !== digest(model[key])) reject();
  if (timeline.totalFrames !== model.totalFrames || timeline.poster !== model.poster) reject();
  const originals = new Map(
    bundle.scenarios
      .flatMap((scenario) => scenario.steps.flatMap((step) => [step.before.image, step.after.image]))
      .map((artifact) => [artifact.path, artifact]),
  );
  if (bundle.captureMode === 'motion')
    for (const scenario of bundle.motion)
      for (const side of ['before', 'after'] as const)
        for (const frame of scenario.tracks[side].frames) originals.set(frame.artifact.path, frame.artifact);
  const composed = new Set(model.cards.map((card) => card.image));
  const table = new Map(timeline.images.map((artifact) => [artifact.path, artifact]));
  for (const artifact of originals.values()) {
    const recorded = table.get(artifact.path);
    if (!recorded || digest(recorded) !== digest(artifact)) reject();
  }
  for (const artifact of timeline.images) if (!originals.has(artifact.path) && !composed.has(artifact.path)) reject();
  for (const path of composed) if (!table.has(path)) reject();
  if (bundle.captureMode === 'motion')
    for (let i = 0; i < bundle.motion.length; i++) {
      const segment = timeline.segments.find(
        (segment) => segment.scenarioId === bundle.motion[i]?.id && segment.kind === 'motion',
      );
      if (!segment || segment.kind !== 'motion') {
        reject();
        continue;
      }
      for (const selection of timeline.selections.filter(
        (selection) =>
          selection.frame >= segment.startFrame && selection.frame < segment.startFrame + segment.durationFrames,
      )) {
        const time = segment.sourceStartMs + ((selection.frame - segment.startFrame) * 1000) / 30;
        if (
          selection.before !== selectSource(bundle, i, 'before', time) ||
          selection.after !== selectSource(bundle, i, 'after', time)
        )
          reject();
      }
    }
}

export async function encode(input: Timeline, run: RunContext): Promise<Media> {
  const parsed = TimelineSchema.safeParse(input);
  if (!parsed.success || parsed.data.runId !== run.runId)
    throw failure(
      9,
      'TIMELINE_INVALID',
      'encoding',
      'The saved timeline is invalid for this run.',
      'Use an intact timeline from the original comparison.',
    );
  const timeline = parsed.data;
  let encoder;
  try {
    const bundle = CaptureBundleSchema.parse(
      JSON.parse((await readRunFile(run.paths.runDir, 'capture.json', 256 * 1024 * 1024)).toString('utf8')),
    );
    validateTimelineCapture(timeline, bundle);
    const images = new Map(timeline.images.map((image) => [image.path, image]));
    const sources = new Set(
      bundle.scenarios.flatMap((scenario) =>
        scenario.steps.flatMap((step) => [step.before.image.path, step.after.image.path]),
      ),
    );
    if (bundle.captureMode === 'motion')
      for (const scenario of bundle.motion)
        for (const side of ['before', 'after'] as const)
          for (const frame of scenario.tracks[side].frames) sources.add(frame.artifact.path);
    for (const image of timeline.images) {
      remainingMs(run);
      await readPng(
        run.paths.runDir,
        image.path,
        sources.has(image.path) ? timeline.viewport.width : 1920,
        sources.has(image.path) ? timeline.viewport.height : 686,
        image,
      );
    }
    const capabilities = await checkMediaCapabilities(run);
    const temporary = 'private/001-encode.mp4';
    await writeRunFile(run, temporary, Buffer.alloc(0));
    const output = join(run.paths.runDir, temporary);
    encoder = await run.supervisor.spawn({
      argv: [capabilities.ffmpeg.executable, ...packedEncodingArgs(output, timeline)],
      cwd: run.paths.runDir,
      purpose: 'encode',
      input: 'pipe',
      timeoutMs: remainingMs(run, 120_000),
    });
    const cache = new Map<string, PNG>();
    const load = async (path: string | null): Promise<PNG | null> => {
      if (path === null) return null;
      const hit = cache.get(path);
      if (hit) return hit;
      const expected = images.get(path);
      if (!expected) throw new Error('Missing image identity');
      const png = PNG.sync.read(
        await readPng(
          run.paths.runDir,
          path,
          sources.has(path) ? timeline.viewport.width : 1920,
          sources.has(path) ? timeline.viewport.height : 686,
          expected,
        ),
        { checkCRC: true },
      );
      if (cache.size >= 4) {
        const oldest = cache.keys().next().value;
        if (oldest) cache.delete(oldest);
      }
      cache.set(path, png);
      return png;
    };
    const selections = new Map(timeline.selections.map((selection) => [selection.frame, selection]));
    async function* frames(): AsyncGenerator<Buffer> {
      for (const segment of timeline.segments)
        for (let frame = segment.startFrame; frame < segment.startFrame + segment.durationFrames; frame++) {
          const selection = selections.get(frame);
          const overlayPath = segment.kind === 'motion' ? selection?.overlay : segment.image;
          if (!overlayPath) throw new Error('Missing frame overlay');
          const overlay = await load(overlayPath);
          if (!overlay) throw new Error('Missing overlay');
          const before = selection ? await load(selection.before) : null;
          const after = selection ? await load(selection.after) : null;
          yield packFrame(timeline.viewport, before, after, overlay);
        }
    }
    await writeEncoderFrames(encoder, frames(), run);
    await validateMedia(run, capabilities.ffprobe.executable, output, {
      width: 1920,
      height: 686,
      totalFrames: timeline.totalFrames,
    });
    await validateDecodedBoundaries(timeline, run, capabilities.ffmpeg.executable, output, load);
    const poster = images.get(timeline.poster);
    if (!poster) throw new Error('Missing poster');
    await writeRunFile(run, 'poster.png', await readPng(run.paths.runDir, timeline.poster, 1920, 686, poster));
    await renameRunFile(run, temporary, 'compare.mp4');
    return MediaSchema.parse({
      video: await artifactInfo(run.paths.runDir, 'compare.mp4'),
      poster: await artifactInfo(run.paths.runDir, 'poster.png'),
      ffmpegVersion: capabilities.ffmpeg.version,
      ffprobeVersion: capabilities.ffprobe.version,
    });
  } catch (error) {
    encoder?.stdin?.destroy();
    if (encoder?.isAlive())
      await run.supervisor.stop(encoder).catch(() => {
        run.diagnostics.event('Encoder process cleanup requires final verification.');
      });
    checkCancelled(run.signal);
    if (error instanceof ToolFailure) throw error;
    throw failure(
      9,
      'ENCODE_FAILED',
      'encoding',
      'Encoding failed. Sanitized source frames and overlays were retained.',
      'Run compose on the saved run after checking doctor and private diagnostics.',
    );
  }
}
