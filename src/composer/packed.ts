import { PNG } from 'pngjs';
import type { Timeline } from '../schema/index.js';
export function packedDimensions(viewport: Timeline['viewport']): { width: number; height: number } {
  return { width: Math.max(viewport.width * 2, 1920), height: viewport.height + 686 };
}
export function packedEncodingArgs(path: string, timeline: Pick<Timeline, 'viewport' | 'totalFrames'>): string[] {
  const { width, height } = packedDimensions(timeline.viewport);
  const source = timeline.viewport;
  const scale = Math.min(1, 958 / source.width, 598 / source.height);
  const w = Math.max(1, Math.floor(source.width * scale));
  const h = Math.max(1, Math.floor(source.height * scale));
  const x = Math.floor((958 - w) / 2);
  const y = Math.floor((598 - h) / 2);
  const filter = `[0:v]split=3[a][b][o];[a]crop=${source.width}:${source.height}:0:0,scale=${w}:${h}:flags=lanczos,pad=962:598:${x}:${y}:color=0x0f172a[l];[b]crop=${source.width}:${source.height}:${source.width}:0,scale=${w}:${h}:flags=lanczos,pad=958:598:${x}:${y}:color=0x0f172a[r];[l][r]hstack=inputs=2,pad=1920:686:0:48:color=0x0f172a[base];[o]crop=1920:686:0:${source.height}[over];[base][over]overlay=0:0:format=auto,format=yuv420p[out]`;
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'rawvideo',
    '-pixel_format',
    'rgba',
    '-video_size',
    `${width}x${height}`,
    '-framerate',
    '30',
    '-i',
    'pipe:0',
    '-filter_complex_threads',
    '1',
    '-filter_complex',
    filter,
    '-map',
    '[out]',
    '-an',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-r',
    '30',
    '-fps_mode',
    'cfr',
    '-crf',
    '23',
    '-preset',
    'veryfast',
    '-threads',
    '2',
    '-movflags',
    '+faststart',
    '-frames:v',
    String(timeline.totalFrames),
    path,
  ];
}
export function packFrame(viewport: Timeline['viewport'], before: PNG | null, after: PNG | null, overlay: PNG): Buffer {
  const { width, height } = packedDimensions(viewport);
  const bytes = Buffer.alloc(width * height * 4);
  for (let offset = 0; offset < bytes.length; offset += 4) {
    bytes[offset] = 15;
    bytes[offset + 1] = 23;
    bytes[offset + 2] = 42;
    bytes[offset + 3] = 255;
  }
  const blit = (image: PNG, x: number, y: number) => {
    for (let row = 0; row < image.height; row++)
      image.data.copy(bytes, ((row + y) * width + x) * 4, row * image.width * 4, (row + 1) * image.width * 4);
  };
  if (before) blit(before, 0, 0);
  if (after) blit(after, viewport.width, 0);
  blit(overlay, 0, viewport.height);
  return bytes;
}
