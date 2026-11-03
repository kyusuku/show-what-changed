import { join } from 'node:path';
import { PNG } from 'pngjs';
import type { Timeline } from '../schema/index.js';
import type { RunContext } from '../schema/contracts.js';
import { failure } from '../schema/errors.js';
import { writeRunFile } from '../runtime/files.js';
import { command } from './process.js';
import { readPng } from './images.js';
function expectedFrame(viewport: Timeline['viewport'], before: PNG | null, after: PNG | null, overlay: PNG): PNG {
  const output = new PNG({ width: 1920, height: 686 });
  for (let p = 0; p < output.data.length; p += 4) {
    output.data[p] = 15;
    output.data[p + 1] = 23;
    output.data[p + 2] = 42;
    output.data[p + 3] = 255;
  }
  const scale = Math.min(1, 958 / viewport.width, 598 / viewport.height);
  const width = Math.max(1, Math.floor(viewport.width * scale));
  const height = Math.max(1, Math.floor(viewport.height * scale));
  for (const [image, panelX] of [
    [before, 0],
    [after, 962],
  ] as const)
    if (image) {
      const left = panelX + Math.floor((958 - width) / 2);
      const top = 48 + Math.floor((598 - height) / 2);
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          const sx = Math.min(image.width - 1, Math.floor(((x + 0.5) * image.width) / width));
          const sy = Math.min(image.height - 1, Math.floor(((y + 0.5) * image.height) / height));
          const source = (sy * image.width + sx) * 4;
          const target = ((y + top) * 1920 + x + left) * 4;
          image.data.copy(output.data, target, source, source + 4);
        }
    }
  for (let p = 0; p < overlay.data.length; p += 4) {
    const alpha = (overlay.data[p + 3] ?? 0) / 255;
    for (let channel = 0; channel < 3; channel++)
      output.data[p + channel] = Math.round(
        (overlay.data[p + channel] ?? 0) * alpha + (output.data[p + channel] ?? 0) * (1 - alpha),
      );
  }
  return output;
}
export async function validateDecodedBoundaries(
  timeline: Timeline,
  run: RunContext,
  executable: string,
  video: string,
  load: (path: string | null) => Promise<PNG | null>,
): Promise<void> {
  const points = new Set([0, timeline.totalFrames - 1, ...timeline.segments.map((segment) => segment.startFrame)]);
  const selections = new Map(timeline.selections.map((selection) => [selection.frame, selection]));
  for (const frame of points) {
    const segment = timeline.segments.find(
      (segment) => frame >= segment.startFrame && frame < segment.startFrame + segment.durationFrames,
    );
    if (!segment) throw new Error('Missing decoded boundary segment');
    const selection = selections.get(frame);
    const overlay = await load(segment.kind === 'motion' ? (selection?.overlay ?? null) : segment.image);
    if (!overlay) throw new Error('Missing expected boundary overlay');
    const expected = expectedFrame(
      timeline.viewport,
      selection ? await load(selection.before) : null,
      selection ? await load(selection.after) : null,
      overlay,
    );
    const relative = `private/decoded-boundary-${frame}.png`;
    await writeRunFile(run, relative, Buffer.alloc(0));
    await command(run, [
      executable,
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      video,
      '-vf',
      `select=eq(n\\,${frame})`,
      '-fps_mode',
      'vfr',
      '-frames:v',
      '1',
      join(run.paths.runDir, relative),
    ]);
    const actual = PNG.sync.read(await readPng(run.paths.runDir, relative, 1920, 686));
    let error = 0;
    for (let p = 0; p < actual.data.length; p += 4)
      for (let channel = 0; channel < 3; channel++)
        error += Math.abs((actual.data[p + channel] ?? 0) - (expected.data[p + channel] ?? 0));
    if (error / (1920 * 686 * 3) > 12)
      throw failure(
        9,
        'MEDIA_BOUNDARY_MISMATCH',
        'encoding',
        'A decoded first, boundary, or final image differs from its saved source selection.',
        'Inspect the saved source frames, overlays, and private media validation images.',
      );
  }
}
