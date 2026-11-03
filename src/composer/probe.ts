import { z } from 'zod';
import type { RunContext } from '../schema/contracts.js';
import { failure, ToolFailure } from '../schema/errors.js';
import { command } from './process.js';

const ProbeSchema = z.object({
  streams: z.array(z.object({ codec_name: z.string(), codec_type: z.string(), pix_fmt: z.string(), width: z.number().int(), height: z.number().int(), r_frame_rate: z.string(), avg_frame_rate: z.string(), nb_read_frames: z.string() })).length(1),
  format: z.object({ duration: z.string(), size: z.string() }),
});
function fps(value: string): number {
  const match = /^(\d+)\/(\d+)$/.exec(value);
  if (!match || !match[1] || !match[2] || Number(match[2]) === 0) return NaN;
  return Number(match[1]) / Number(match[2]);
}

export async function validateMedia(run: RunContext, executable: string, path: string, expected: { width: number; height: number; totalFrames: number }): Promise<void> {
  try {
    const output = await command(run, [executable, '-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', path]);
    const probe = ProbeSchema.parse(JSON.parse(output));
    const stream = probe.streams[0];
    if (!stream || stream.codec_type !== 'video' || stream.codec_name !== 'h264' || stream.pix_fmt !== 'yuv420p' || stream.width !== expected.width || stream.height !== expected.height || fps(stream.r_frame_rate) !== 30 || fps(stream.avg_frame_rate) !== 30 || Number(stream.nb_read_frames) !== expected.totalFrames || !Number.isFinite(Number(probe.format.duration)) || Math.abs(Number(probe.format.duration) - expected.totalFrames / 30) > 1 / 30 + 0.000001 || !Number.isSafeInteger(Number(probe.format.size)) || Number(probe.format.size) <= 0) throw new Error('Unexpected encoded media metadata');
  } catch (error) {
    if (run.signal.aborted || error instanceof ToolFailure && error.exitCode === 10) throw error;
    throw failure(9, 'MEDIA_VALIDATION_FAILED', 'encoding', 'Encoded media failed codec, dimension, frame-count, or timing validation.', 'Inspect private media diagnostics and retry the saved timeline.');
  }
}

export function encodingArgs(path: string, totalFrames: number): string[] {
  return ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'image2pipe', '-framerate', '30', '-vcodec', 'png', '-i', 'pipe:0', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '30', '-fps_mode', 'cfr', '-crf', '23', '-preset', 'veryfast', '-threads', '2', '-movflags', '+faststart', '-frames:v', String(totalFrames), path];
}
