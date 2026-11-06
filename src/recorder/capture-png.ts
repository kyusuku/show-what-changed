import { crc32, deflateSync, inflateSync } from 'node:zlib';
import { MAX_PNG_BYTES } from '../composer/images.js';
import type { RecorderSettings } from '../schema/index.js';

const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
type Viewport = RecorderSettings['viewport'];
type Masks = Extract<RecorderSettings, { mode: 'motion' }>['maskRects'];
type SourcePixels =
  | { channels: 3; transparentRgb: readonly [number, number, number] | null }
  | { channels: 4; transparentRgb: null };
type Capture = Viewport & {
  pixels: SourcePixels;
  filteredBytes: number;
  idatStart: number;
  idatEnd: number;
  compressedBytes: number;
  gammaInteger: number | null;
};
type Scanlines = Viewport & {
  channels: 3 | 4;
  stride: number;
  rows: Buffer;
  gammaInteger: number | null;
};

export class CaptureFault extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/** Consumes the owned input: callers must not read or reuse its contents afterward. */
export function sanitizeFrame(bytes: Buffer, viewport: Viewport, masks: Masks): Buffer {
  try {
    const capture = inspectCapture(bytes, viewport);
    const rows = decodeRows(compactIdat(bytes, capture), capture);
    maskAndVerify(rows, masks);
    return encodeRows(rows);
  } catch (cause) {
    throw cause instanceof CaptureFault ? cause : new CaptureFault('CAPTURE_PNG_INVALID');
  }
}

function invalid(): never {
  throw new CaptureFault('CAPTURE_PNG_INVALID');
}

function inspectCapture(bytes: Buffer, { width, height }: Viewport): Capture {
  if (
    bytes.length < 57 ||
    bytes.length > MAX_PNG_BYTES ||
    !bytes.subarray(0, 8).equals(signature) ||
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    bytes.readUInt32BE(8) !== 13 ||
    bytes.toString('latin1', 12, 16) !== 'IHDR' ||
    bytes.readUInt32BE(16) !== width ||
    bytes.readUInt32BE(20) !== height ||
    bytes[24] !== 8 ||
    (bytes[25] !== 2 && bytes[25] !== 6) ||
    bytes[26] !== 0 ||
    bytes[27] !== 0 ||
    bytes[28] !== 0
  )
    invalid();
  const channels = bytes[25] === 2 ? 3 : 4;
  const filteredBytes = (width * channels + 1) * height;
  if (!Number.isSafeInteger(filteredBytes) || filteredBytes > MAX_PNG_BYTES) invalid();
  let transparentRgb: readonly [number, number, number] | null = null;
  let gammaInteger: number | null = null;
  let palette = false;
  let state: 'before-data' | 'in-data' | 'after-data' = 'before-data';
  let idatStart = 0;
  let idatEnd = 0;
  let compressedBytes = 0;
  for (let offset = 8; offset < bytes.length; ) {
    if (bytes.length - offset < 12) invalid();
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) invalid();
    for (let index = offset + 4; index < offset + 8; index++) {
      const letter = bytes[index]!;
      if (!((letter >= 65 && letter <= 90) || (letter >= 97 && letter <= 122))) invalid();
    }
    if ((bytes[offset + 6]! & 32) !== 0 || crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4))
      invalid();
    const kind = bytes.toString('latin1', offset + 4, offset + 8);
    const payload = offset + 8;
    if (kind === 'IDAT') {
      if (state === 'after-data') invalid();
      if (state === 'before-data') idatStart = offset;
      state = 'in-data';
      idatEnd = end;
      compressedBytes += length;
    } else {
      if (state === 'in-data') state = 'after-data';
      switch (kind) {
        case 'IHDR':
          if (offset !== 8) invalid();
          break;
        case 'PLTE':
          if (state !== 'before-data' || palette || transparentRgb || length === 0 || length > 768 || length % 3)
            invalid();
          palette = true;
          break;
        case 'gAMA':
          if (state !== 'before-data' || palette || gammaInteger !== null || length !== 4) invalid();
          gammaInteger = bytes.readUInt32BE(payload);
          if (gammaInteger === 0) invalid();
          break;
        case 'tRNS':
          if (state !== 'before-data' || channels !== 3 || transparentRgb || length !== 6) invalid();
          transparentRgb = [
            bytes.readUInt16BE(payload),
            bytes.readUInt16BE(payload + 2),
            bytes.readUInt16BE(payload + 4),
          ];
          if (transparentRgb.some((sample) => sample > 255)) invalid();
          break;
        case 'IEND':
          if (length !== 0 || idatStart === 0 || end !== bytes.length) invalid();
          return {
            width,
            height,
            filteredBytes,
            idatStart,
            idatEnd,
            compressedBytes,
            gammaInteger,
            pixels: channels === 3 ? { channels, transparentRgb } : { channels, transparentRgb: null },
          };
        case 'acTL':
        case 'fcTL':
        case 'fdAT':
          invalid();
          break;
        default:
          if ((bytes[offset + 4]! & 32) === 0) invalid();
      }
    }
    offset = end;
  }
  return invalid();
}

function compactIdat(bytes: Buffer, capture: Capture): Buffer {
  let destination = 0;
  for (let offset = capture.idatStart; offset < capture.idatEnd; ) {
    const length = bytes.readUInt32BE(offset);
    const next = offset + length + 12;
    bytes.copy(bytes, destination, offset + 8, next - 4);
    destination += length;
    offset = next;
  }
  return bytes.subarray(0, capture.compressedBytes);
}

function inflateExact(compressed: Buffer, expected: number): Buffer {
  // Node's type declaration omits the object returned by info: true.
  const result: unknown = inflateSync(compressed, {
    info: true,
    maxOutputLength: expected,
    chunkSize: Math.max(64, expected + 1),
  });
  if (
    typeof result !== 'object' ||
    result === null ||
    !('buffer' in result) ||
    !Buffer.isBuffer(result.buffer) ||
    !('engine' in result) ||
    typeof result.engine !== 'object' ||
    result.engine === null ||
    !('bytesWritten' in result.engine) ||
    result.engine.bytesWritten !== compressed.length ||
    result.buffer.length !== expected
  )
    invalid();
  return result.buffer;
}

function decodeRows(compressed: Buffer, capture: Capture): Scanlines {
  const { width, height, gammaInteger, pixels } = capture;
  const stride = width * pixels.channels + 1;
  const rows = inflateExact(compressed, capture.filteredBytes);
  const channels = pixels.channels;
  for (let y = 0; y < height; y++) {
    const start = y * stride;
    const filter = rows[start]!;
    if (filter > 4) invalid();
    if (filter === 0) continue;
    const first = start + 1;
    const interior = first + channels;
    const end = start + stride;
    switch (filter) {
      case 1:
        for (let index = interior; index < end; index++)
          rows[index] = rows[index]! + rows[index - channels]!;
        break;
      case 2:
        if (y > 0)
          for (let index = first; index < end; index++) rows[index] = rows[index]! + rows[index - stride]!;
        break;
      case 3:
        if (y === 0) {
          for (let index = interior; index < end; index++)
            rows[index] = rows[index]! + (rows[index - channels]! >>> 1);
        } else {
          for (let index = first; index < interior; index++)
            rows[index] = rows[index]! + (rows[index - stride]! >>> 1);
          for (let index = interior; index < end; index++)
            rows[index] = rows[index]! + ((rows[index - channels]! + rows[index - stride]!) >>> 1);
        }
        break;
      case 4:
        if (y === 0) {
          for (let index = interior; index < end; index++)
            rows[index] = rows[index]! + rows[index - channels]!;
        } else {
          for (let index = first; index < interior; index++)
            rows[index] = rows[index]! + rows[index - stride]!;
          for (let index = interior; index < end; index++) {
            const left = rows[index - channels]!;
            const above = rows[index - stride]!;
            const upperLeft = rows[index - stride - channels]!;
            const p = left + above - upperLeft;
            const a = Math.abs(p - left);
            const b = Math.abs(p - above);
            const c = Math.abs(p - upperLeft);
            const prediction = a <= b && a <= c ? left : b <= c ? above : upperLeft;
            rows[index] = rows[index]! + prediction;
          }
        }
        break;
    }
    rows[start] = 0;
  }
  if (pixels.transparentRgb === null)
    return {
      width,
      height,
      gammaInteger,
      channels: pixels.channels,
      stride,
      rows,
    };
  const expandedStride = width * 4 + 1;
  const expanded = Buffer.allocUnsafeSlow(expandedStride * height);
  const [red, green, blue] = pixels.transparentRgb;
  for (let y = 0; y < height; y++) {
    expanded[y * expandedStride] = 0;
    for (let x = 0; x < width; x++) {
      const source = y * stride + 1 + x * 3;
      const target = y * expandedStride + 1 + x * 4;
      const transparent = rows[source] === red && rows[source + 1] === green && rows[source + 2] === blue;
      expanded[target] = transparent ? 0 : rows[source]!;
      expanded[target + 1] = transparent ? 0 : rows[source + 1]!;
      expanded[target + 2] = transparent ? 0 : rows[source + 2]!;
      expanded[target + 3] = transparent ? 0 : 255;
    }
  }
  return {
    width,
    height,
    gammaInteger,
    channels: 4,
    stride: expandedStride,
    rows: expanded,
  };
}

function maskAndVerify({ rows, channels, stride, width, height }: Scanlines, masks: Masks): void {
  for (const rect of masks) {
    if (
      ![rect.x, rect.y, rect.width, rect.height].every(Number.isInteger) ||
      rect.width <= 0 ||
      rect.height <= 0 ||
      rect.x < 0 ||
      rect.y < 0 ||
      rect.x + rect.width > width ||
      rect.y + rect.height > height
    )
      throw new CaptureFault('MASK_INVALID');
    for (let y = rect.y; y < rect.y + rect.height; y++)
      for (let x = rect.x; x < rect.x + rect.width; x++) {
        const offset = y * stride + 1 + x * channels;
        rows[offset] = rows[offset + 1] = rows[offset + 2] = 16;
        if (channels === 4) rows[offset + 3] = 255;
      }
  }
  for (const rect of masks)
    for (let y = rect.y; y < rect.y + rect.height; y++)
      for (let x = rect.x; x < rect.x + rect.width; x++) {
        const offset = y * stride + 1 + x * channels;
        if (
          rows[offset] !== 16 ||
          rows[offset + 1] !== 16 ||
          rows[offset + 2] !== 16 ||
          (channels === 4 && rows[offset + 3] !== 255)
        )
          throw new CaptureFault('MASK_VERIFICATION_FAILED');
      }
}

function encodeRows({ rows, width, height, channels, gammaInteger }: Scanlines): Buffer {
  const overhead = gammaInteger === null ? 57 : 73;
  const compressed = deflateSync(rows, {
    level: 1,
    strategy: 3,
    chunkSize: 32 * 1024,
    maxOutputLength: Math.min(MAX_PNG_BYTES - overhead, 5 * width * height + 256),
  });
  const output = Buffer.allocUnsafeSlow(compressed.length + overhead);
  signature.copy(output);
  output.writeUInt32BE(width, 16);
  output.writeUInt32BE(height, 20);
  output[24] = 8;
  output[25] = channels === 3 ? 2 : 6;
  output[26] = output[27] = output[28] = 0;
  finishChunk(output, 8, 'IHDR', 13);
  let offset = 33;
  if (gammaInteger !== null) {
    output.writeUInt32BE(gammaInteger, offset + 8);
    finishChunk(output, offset, 'gAMA', 4);
    offset += 16;
  }
  compressed.copy(output, offset + 8);
  finishChunk(output, offset, 'IDAT', compressed.length);
  finishChunk(output, offset + compressed.length + 12, 'IEND', 0);
  return output;
}

function finishChunk(bytes: Buffer, offset: number, kind: string, length: number): void {
  bytes.writeUInt32BE(length, offset);
  bytes.write(kind, offset + 4, 4, 'ascii');
  bytes.writeUInt32BE(crc32(bytes.subarray(offset + 4, offset + length + 8)), offset + length + 8);
}
