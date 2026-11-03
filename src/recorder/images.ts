import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import type { Page } from 'playwright';
import { VIEWPORT } from '../schema/index.js';
import type { RecorderSettings } from '../schema/index.js';
import { CaptureFault } from './capture-png.js';
export { CaptureFault, sanitizeFrame } from './capture-png.js';

export const MASK_COLOR = '#101010';
export const CAPTURE_STYLE =
  '*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}';

export async function maskedFrame(
  page: Page,
  selectors: readonly string[],
  timeoutMs: number,
  viewport: RecorderSettings['viewport'] = VIEWPORT,
): Promise<Buffer> {
  const valid = await page.evaluate(
    (values) =>
      values.every((selector) => {
        try {
          document.querySelector(selector);
          return true;
        } catch {
          return false;
        }
      }),
    [...selectors],
  );
  if (!valid) throw new CaptureFault('INVALID_MASK_SELECTOR');
  const bytes = await page.screenshot({
    type: 'png',
    fullPage: false,
    caret: 'hide',
    animations: 'disabled',
    scale: 'css',
    mask: selectors.map((selector) => page.locator(`css=${selector}`)),
    maskColor: MASK_COLOR,
    style: CAPTURE_STYLE,
    timeout: Math.max(1, timeoutMs),
  });
  const image = PNG.sync.read(bytes);
  if (image.width !== viewport.width || image.height !== viewport.height) throw new CaptureFault('INVALID_FRAME_SIZE');
  return bytes;
}

export function neutralFrame(viewport: RecorderSettings['viewport'] = VIEWPORT): Buffer {
  const image = new PNG({ width: viewport.width, height: viewport.height });
  for (let index = 0; index < image.data.length; index += 4) {
    image.data[index] = 32;
    image.data[index + 1] = 36;
    image.data[index + 2] = 44;
    image.data[index + 3] = 255;
  }
  return PNG.sync.write(image);
}

export function changeRatio(before: Uint8Array, after: Uint8Array): number {
  const left = PNG.sync.read(Buffer.from(before));
  const right = PNG.sync.read(Buffer.from(after));
  if (left.width !== right.width || left.height !== right.height) throw new CaptureFault('INVALID_FRAME_SIZE');
  return (
    pixelmatch(left.data, right.data, undefined, left.width, left.height, { threshold: 0.1, includeAA: false }) /
    (left.width * left.height)
  );
}
