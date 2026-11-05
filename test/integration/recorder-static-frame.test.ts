import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import type { BrowserContext } from 'playwright';
import { expect, it, vi } from 'vitest';
import { openBrowser } from '../../src/runtime/browser.js';
import { createRunContext, cleanupRun } from '../../src/runtime/context.js';
import { CaptureSettingsSchema } from '../../src/schema/index.js';
import { MotionRecorder } from '../../src/recorder/motion.js';
import { MaskWorker } from '../../src/recorder/masker.js';

function pixel(bytes: Buffer, x: number, y: number): number[] {
  const png = PNG.sync.read(bytes);
  const offset = (y * png.width + x) * 4;
  return [...png.data.subarray(offset, offset + 3)];
}

it('retains the final static page update while the prior frame is being masked', async () => {
  const root = await mkdtemp(join(tmpdir(), 'swc-static-frame-'));
  const run = await createRunContext({
    repoRoot: root,
    timeoutMs: 30_000,
    signal: new AbortController().signal,
    diagnostics: { event() {} },
  });
  const settings = CaptureSettingsSchema.parse({
    mode: 'motion',
    viewport: { width: 391, height: 241 },
    maskRects: [{ x: 0, y: 0, width: 20, height: 20 }],
  });
  if (settings.mode !== 'motion') throw new Error('Motion settings required');
  let entered = false;
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  const original = MaskWorker.prototype.sanitize;
  const spy = vi.spyOn(MaskWorker.prototype, 'sanitize').mockImplementationOnce(async function (this: MaskWorker, bytes) {
    entered = true;
    await held;
    return original.call(this, bytes);
  });
  let context: BrowserContext | undefined;
  let recorder: MotionRecorder | undefined;
  try {
    const browser = await openBrowser(run);
    context = await browser.newContext({ viewport: settings.viewport, deviceScaleFactor: 1 });
    const page = await context.newPage();
    await page.setContent('<style>html,body{margin:0;background:white;width:100%;height:100%}</style><div style="width:20px;height:20px;background:red">SYNTHETIC</div>');
    recorder = await MotionRecorder.start(page, settings, run, 'before', 'static', { count: 0, bytes: 0, rawBytes: 0, sanitizedBytes: 0 }, () => {});
    await expect.poll(() => entered, { timeout: 5_000 }).toBe(true);
    await page.evaluate(() => {
      document.documentElement.style.background = '#20c850';
      document.body.style.background = '#20c850';
    });
    expect(pixel(await page.screenshot(), 200, 100)).toEqual([32, 200, 80]);
    await new Promise((resolve) => setTimeout(resolve, 250));
    release();
    await expect.poll(async () => {
      const last = recorder?.result().frames.at(-1);
      return last ? pixel(await readFile(join(run.paths.runDir, last.artifact.path)), 200, 100) : null;
    }, { timeout: 5_000 }).toEqual([32, 200, 80]);
    await recorder.stop();
    const result = recorder.result();
    expect(result.status).toBe('ok');
    const last = result.frames.at(-1);
    if (!last) throw new Error('Missing recorded frame');
    const bytes = await readFile(join(run.paths.runDir, last.artifact.path));
    const finalRgb = pixel(bytes, 200, 100);
    process.stdout.write(JSON.stringify({ browserVersion: browser.version(), finalRgb, frames: result.frames.length, stats: result.stats }) + '\n');
    expect(finalRgb).toEqual([32, 200, 80]);
    expect(pixel(bytes, 10, 10).every((value) => value < 65)).toBe(true);
    expect(result.stats.acknowledgedFrames).toBe(result.stats.receivedFrames);
  } finally {
    release();
    await recorder?.stop(performance.now() + 5_000);
    spy.mockRestore();
    await context?.close();
    const cleanup = await cleanupRun(run);
    await rm(root, { recursive: true, force: true });
    expect(cleanup.status).toBe('ok');
  }
}, 30_000);
