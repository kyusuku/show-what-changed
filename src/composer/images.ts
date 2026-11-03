import { PNG } from 'pngjs';
import { inflateSync } from 'node:zlib';
import { readRunFile } from '../runtime/files.js';
import { failure } from '../schema/errors.js';
import { sha256 } from '../schema/io.js';
import type { Artifact } from '../schema/index.js';

export const MAX_PNG_BYTES = 16 * 1024 * 1024;
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function validateImageData(bytes: Buffer, width: number, height: number): void {
  if (bytes.length > MAX_PNG_BYTES || bytes.length < 45 || !bytes.subarray(0, 8).equals(signature))
    throw new Error('Invalid PNG signature or size');
  let offset = 8;
  let header = false;
  let ended = false;
  let dataEnded = false;
  let expectedBytes = 0;
  const data: Buffer[] = [];
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length || ended) throw new Error('Invalid PNG chunk boundary');
    const length = bytes.readUInt32BE(offset);
    if (length > bytes.length - offset - 12) throw new Error('Truncated PNG chunk');
    const kind = bytes.toString('ascii', offset + 4, offset + 8);
    const payload = bytes.subarray(offset + 8, offset + 8 + length);
    if (!header && kind !== 'IHDR') throw new Error('PNG header must be first');
    if (kind === 'IHDR') {
      if (header || length !== 13 || payload.readUInt32BE(0) !== width || payload.readUInt32BE(4) !== height)
        throw new Error('Invalid PNG dimensions or duplicate header');
      const depth = payload[8];
      const color = payload[9];
      const channels = color === 0 || color === 3 ? 1 : color === 2 ? 3 : color === 4 ? 2 : color === 6 ? 4 : 0;
      const depths = color === 0 ? [1, 2, 4, 8, 16] : color === 3 ? [1, 2, 4, 8] : [8, 16];
      if (
        depth === undefined ||
        !channels ||
        !depths.includes(depth) ||
        payload[10] !== 0 ||
        payload[11] !== 0 ||
        payload[12] !== 0
      )
        throw new Error('Unsupported PNG encoding');
      expectedBytes = (Math.ceil((width * channels * depth) / 8) + 1) * height;
      if (expectedBytes < 1 || expectedBytes > MAX_PNG_BYTES) throw new Error('Oversized decoded PNG');
      header = true;
    } else if (kind === 'IDAT') {
      if (dataEnded) throw new Error('Noncontiguous PNG image data');
      data.push(payload);
    } else {
      if (data.length) dataEnded = true;
      if (kind === 'IEND') {
        if (length !== 0 || data.length === 0) throw new Error('Invalid PNG end');
        ended = true;
      }
    }
    offset += length + 12;
  }
  if (!ended || inflateSync(Buffer.concat(data), { maxOutputLength: expectedBytes }).length !== expectedBytes)
    throw new Error('Invalid decoded PNG size');
}

export function decodePng(
  bytes: Buffer,
  width: number,
  height: number,
  phase: 'rendering' | 'encoding' = 'rendering',
): PNG {
  try {
    validateImageData(bytes, width, height);
    const image = PNG.sync.read(bytes, { checkCRC: true });
    if (image.width !== width || image.height !== height || image.data.length !== width * height * 4)
      throw new Error('Invalid PNG dimensions');
    return image;
  } catch {
    throw failure(
      9,
      'IMAGE_INVALID',
      phase,
      'An input PNG is invalid, oversized, or has unexpected dimensions.',
      'Restore the original captured or composed PNGs and retry.',
    );
  }
}

export async function readPng(
  runDir: string,
  path: string,
  width: number,
  height: number,
  expected?: Artifact,
): Promise<Buffer> {
  let bytes: Buffer;
  try {
    bytes = await readRunFile(runDir, path, MAX_PNG_BYTES);
  } catch {
    throw failure(
      9,
      'IMAGE_INPUT_INVALID',
      expected ? 'encoding' : 'rendering',
      'A required PNG is missing or is not a contained regular file within its size limit.',
      'Restore the saved run inputs and retry.',
    );
  }
  if (expected && (bytes.length !== expected.bytes || sha256(bytes) !== expected.sha256))
    throw failure(
      9,
      'IMAGE_HASH_MISMATCH',
      'encoding',
      'A composed PNG does not match its recorded hash or byte size.',
      'Restore the saved composed images or create a new comparison.',
    );
  validatePng(bytes, width, height, expected ? 'encoding' : 'rendering');
  return bytes;
}

export function validatePng(
  bytes: Buffer,
  width: number,
  height: number,
  phase: 'rendering' | 'encoding' = 'rendering',
): void {
  decodePng(bytes, width, height, phase);
}
