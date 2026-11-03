import { isAbsolute, join } from 'node:path';
import { PNG } from 'pngjs';
import type { MediaCapabilities, RunContext } from '../schema/contracts.js';
import { checkCancelled, failure, ToolFailure } from '../schema/errors.js';
import { sanitizeText } from '../schema/io.js';
import { writeRunFile } from '../runtime/files.js';
import { packFrame, packedEncodingArgs } from './packed.js';
import { command, remainingMs, writeEncoderFrames } from './process.js';
import { validateMedia } from './probe.js';

function executable(name: 'FFMPEG' | 'FFPROBE'): string {
  const override = process.env[`SWC_${name}`];
  if (override === undefined) return name.toLowerCase();
  if (!isAbsolute(override) || /[\x00-\x1f\x7f]/u.test(override))
    throw new Error('Media override must be an absolute executable path');
  return override;
}

export async function checkMediaCapabilities(run: RunContext): Promise<MediaCapabilities> {
  let encoder;
  try {
    remainingMs(run);
    const ffmpeg = executable('FFMPEG');
    const ffprobe = executable('FFPROBE');
    const ffmpegVersion = sanitizeText((await command(run, [ffmpeg, '-version'])).split('\n')[0] ?? '').slice(0, 256);
    const ffprobeVersion = sanitizeText((await command(run, [ffprobe, '-version'])).split('\n')[0] ?? '').slice(0, 256);
    if (!/^ffmpeg version \S+/u.test(ffmpegVersion) || !/^ffprobe version \S+/u.test(ffprobeVersion))
      throw new Error('Media versions unavailable');
    const ffmpegRelease = /^ffmpeg version (\S+)/u.exec(ffmpegVersion)?.[1];
    const ffprobeRelease = /^ffprobe version (\S+)/u.exec(ffprobeVersion)?.[1];
    if (ffmpegRelease !== ffprobeRelease) throw new Error('Media tool versions do not match');
    const relative = 'private/000-capability.mp4';
    await writeRunFile(run, relative, Buffer.alloc(0));
    const output = join(run.paths.runDir, relative);
    encoder = await run.supervisor.spawn({
      argv: [
        ffmpeg,
        ...packedEncodingArgs(output, { viewport: { width: 320, height: 240, deviceScaleFactor: 1 }, totalFrames: 2 }),
      ],
      cwd: run.paths.runDir,
      purpose: 'probe',
      input: 'pipe',
      timeoutMs: remainingMs(run),
    });
    const png = new PNG({ width: 1920, height: 686 });
    png.data.fill(128);
    const bytes = packFrame({ width: 320, height: 240, deviceScaleFactor: 1 }, null, null, png);
    await writeEncoderFrames(encoder, [bytes, bytes], run);
    await validateMedia(run, ffprobe, output, { width: 1920, height: 686, totalFrames: 2 });
    return {
      ffmpeg: { executable: ffmpeg, version: ffmpegVersion },
      ffprobe: { executable: ffprobe, version: ffprobeVersion },
    };
  } catch (error) {
    encoder?.stdin?.destroy();
    if (encoder?.isAlive())
      await run.supervisor.stop(encoder).catch(() => {
        run.diagnostics.event('Encoder process cleanup requires final verification.');
      });
    checkCancelled(run.signal);
    if (error instanceof ToolFailure && error.exitCode === 10) throw error;
    throw failure(
      8,
      'MEDIA_CAPABILITY_UNAVAILABLE',
      'capabilities',
      'System FFmpeg and ffprobe could not encode and validate the required H.264 media.',
      'Install matching FFmpeg and ffprobe with libx264 support, or set absolute SWC_FFMPEG and SWC_FFPROBE paths, then run doctor.',
    );
  }
}
