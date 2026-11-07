import { deflateSync } from 'node:zlib';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { MAX_PNG_BYTES } from '../../src/composer/images.js';
import { CaptureFault, sanitizeFrame } from '../../src/recorder/images.js';
import { CaptureFault as CodecFault } from '../../src/recorder/capture-png.js';

const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
type Rect = { x: number; y: number; width: number; height: number };

function checksum(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(kind: string, payload = Buffer.alloc(0)): Buffer {
  const result = Buffer.alloc(payload.length + 12);
  result.writeUInt32BE(payload.length);
  result.write(kind, 4, 4, 'latin1');
  payload.copy(result, 8);
  result.writeUInt32BE(checksum(result.subarray(4, -4)), result.length - 4);
  return result;
}
function header(width: number, height: number, channels = 4, patch: Record<number, number> = {}): Buffer {
  const result = Buffer.alloc(13);
  result.writeUInt32BE(width);
  result.writeUInt32BE(height, 4);
  result[8] = 8;
  result[9] = channels === 3 ? 2 : 6;
  for (const [index, value] of Object.entries(patch)) result[Number(index)] = value;
  return chunk('IHDR', result);
}
function png(...chunks: Buffer[]): Buffer {
  return Buffer.concat([signature, ...chunks]);
}
function transparency(red: number, green: number, blue: number): Buffer {
  const data = Buffer.alloc(6);
  data.writeUInt16BE(red);
  data.writeUInt16BE(green, 2);
  data.writeUInt16BE(blue, 4);
  return chunk('tRNS', data);
}
function gamma(value = 45455): Buffer {
  const data = Buffer.alloc(4);
  data.writeUInt32BE(value);
  return chunk('gAMA', data);
}
function filtered(pixels: Buffer, width: number, height: number, channels: number, filters: number[]): Buffer {
  const rowBytes = width * channels;
  const result = Buffer.alloc((rowBytes + 1) * height);
  for (let y = 0; y < height; y++) {
    const filter = filters[y % filters.length]!;
    result[y * (rowBytes + 1)] = filter;
    for (let x = 0; x < rowBytes; x++) {
      const at = y * rowBytes + x;
      const a = x >= channels ? pixels[at - channels]! : 0;
      const b = y ? pixels[at - rowBytes]! : 0;
      const c = y && x >= channels ? pixels[at - rowBytes - channels]! : 0;
      let predictor = 0;
      if (filter === 1) predictor = a;
      if (filter === 2) predictor = b;
      if (filter === 3) predictor = Math.floor((a + b) / 2);
      if (filter === 4) {
        const candidates = [a, b, c];
        predictor = candidates.reduce((best, candidate) =>
          Math.abs(a + b - c - candidate) < Math.abs(a + b - c - best) ? candidate : best,
        );
      }
      result[y * (rowBytes + 1) + x + 1] = pixels[at]! - predictor;
    }
  }
  return result;
}
function patterned(bytes: number): Buffer {
  const result = Buffer.alloc(bytes);
  let seed = 71937;
  for (let index = 0; index < bytes; index++) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    result[index] = seed;
  }
  return result;
}
function expectedPixels(source: Buffer, channels: number, width: number, height: number, masks: Rect[] = []): Buffer {
  const result = Buffer.alloc(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel++) {
    source.copy(result, pixel * 4, pixel * channels, pixel * channels + 3);
    result[pixel * 4 + 3] = channels === 4 ? source[pixel * channels + 3]! : 255;
  }
  for (const rect of masks)
    for (let y = rect.y; y < rect.y + rect.height; y++)
      for (let x = rect.x; x < rect.x + rect.width; x++) result.set([16, 16, 16, 255], (y * width + x) * 4);
  return result;
}
function chunksOf(bytes: Buffer): { kind: string; payload: Buffer }[] {
  const chunks = [];
  for (let offset = 8; offset < bytes.length; ) {
    const length = bytes.readUInt32BE(offset);
    expect(bytes.readUInt32BE(offset + length + 8)).toBe(checksum(bytes.subarray(offset + 4, offset + length + 8)));
    chunks.push({
      kind: bytes.toString('ascii', offset + 4, offset + 8),
      payload: bytes.subarray(offset + 8, offset + 8 + length),
    });
    offset += length + 12;
  }
  return chunks;
}
const smallRows = Buffer.from([0, 1, 2, 3, 4]);
const smallIdat = chunk('IDAT', deflateSync(smallRows));
const end = chunk('IEND');
function rejects(bytes: Buffer, viewport = { width: 1, height: 1 }): void {
  expect(() => sanitizeFrame(bytes, viewport, [])).toThrow(expect.objectContaining({ code: 'CAPTURE_PNG_INVALID' }));
}

describe('capture PNG pixels', () => {
  it('preserves the existing CaptureFault identity', () => {
    expect(CaptureFault).toBe(CodecFault);
  });

  for (const channels of [3, 4])
    for (const filters of [[0], [1], [2], [3], [4], [4, 2, 3, 0, 1]]) {
      it(`reconstructs ${channels} channels with filters ${filters}`, () => {
        const width = 9;
        const height = 7;
        const pixels = patterned(width * height * channels);
        const masks = [
          { x: 0, y: 0, width: 2, height: 1 },
          { x: 1, y: 0, width: 2, height: 2 },
          { x: 8, y: 6, width: 1, height: 1 },
        ];
        const input = png(
          header(width, height, channels),
          chunk('IDAT', deflateSync(filtered(pixels, width, height, channels, filters))),
          end,
        );
        expect(PNG.sync.read(input).data).toEqual(expectedPixels(pixels, channels, width, height));
        const output = sanitizeFrame(input, { width, height }, masks);
        const decoded = PNG.sync.read(output);
        expect(decoded.data).toEqual(expectedPixels(pixels, channels, width, height, masks));
        expect(decoded.width).toBe(width);
        expect(decoded.height).toBe(height);
        expect(output[25]).toBe(channels === 3 ? 2 : 6);
        expect(chunksOf(output).map((value) => value.kind)).toEqual(['IHDR', 'IDAT', 'IEND']);
      });
    }

  for (const channels of [3, 4])
    for (const filter of [0, 1, 2, 3, 4]) {
      it(`reconstructs unmasked single-pixel rows with ${channels} channels and filter ${filter}`, () => {
        const width = 1;
        const height = 3;
        const pixels = patterned(width * height * channels);
        const input = png(
          header(width, height, channels),
          chunk('IDAT', deflateSync(filtered(pixels, width, height, channels, [filter]))),
          end,
        );
        expect(PNG.sync.read(input).data).toEqual(expectedPixels(pixels, channels, width, height));
        const output = sanitizeFrame(input, { width, height }, []);
        expect(PNG.sync.read(output).data).toEqual(expectedPixels(pixels, channels, width, height));
      });
    }

  it('uses the specified Paeth tie order at the left edge and inside a row', () => {
    // Above/upper-left and left/upper-left ties choose different sample values.
    const pixels = Buffer.from([1, 1, 3, 3, 0, 3, 0, 3, 3, 250, 14, 99]);
    const input = png(header(2, 2, 3), chunk('IDAT', deflateSync(filtered(pixels, 2, 2, 3, [4]))), end);
    expect(PNG.sync.read(sanitizeFrame(input, { width: 2, height: 2 }, [])).data).toEqual(
      expectedPixels(pixels, 3, 2, 2),
    );
  });

  it('preserves RGBA colors under zero alpha and partial alpha outside opaque masks', () => {
    const pixels = Buffer.from([7, 8, 9, 0, 16, 16, 16, 0, 30, 40, 50, 127, 60, 70, 80, 255]);
    const input = png(header(4, 1), chunk('IDAT', deflateSync(filtered(pixels, 4, 1, 4, [1]))), end);
    const masks = [{ x: 1, y: 0, width: 1, height: 1 }];
    expect(PNG.sync.read(sanitizeFrame(input, { width: 4, height: 1 }, masks)).data).toEqual(
      expectedPixels(pixels, 4, 4, 1, masks),
    );
  });

  it.each([
    [16, 16, 16],
    [7, 8, 9],
  ])('normalizes RGB transparency %s before masking', (red, green, blue) => {
    const pixels = Buffer.from([red, green, blue, red, green, blue, 21, 22, 23]);
    const input = png(
      header(3, 1, 3),
      transparency(red, green, blue),
      chunk('IDAT', deflateSync(filtered(pixels, 3, 1, 3, [0]))),
      end,
    );
    const expected = Buffer.from(PNG.sync.read(input).data);
    expected.set([16, 16, 16, 255], 4);
    const output = sanitizeFrame(input, { width: 3, height: 1 }, [{ x: 1, y: 0, width: 1, height: 1 }]);
    expect(PNG.sync.read(output).data).toEqual(expected);
    expect([...expected.subarray(0, 4)]).toEqual([0, 0, 0, 0]);
    expect(output[25]).toBe(6);
  });

  it('accepts palette and gamma metadata, then removes source metadata and keeps exact gamma', () => {
    const marker = Buffer.from('private metadata must not survive');
    const input = png(
      header(1, 1),
      gamma(98765),
      chunk('PLTE', Buffer.from([9, 8, 7])),
      chunk('tEXt', marker),
      smallIdat,
      chunk('zzZZ', marker),
      end,
    );
    const expected = PNG.sync.read(input);
    const output = sanitizeFrame(input, { width: 1, height: 1 }, []);
    expect(PNG.sync.read(output).data).toEqual(expected.data);
    expect(PNG.sync.read(output).gamma).toBe(expected.gamma);
    expect(chunksOf(output).map((value) => value.kind)).toEqual(['IHDR', 'gAMA', 'IDAT', 'IEND']);
    expect(chunksOf(output)[1]!.payload.readUInt32BE()).toBe(98765);
    expect(output.includes(marker)).toBe(false);
  });

  it('accepts split, empty, and padded compressed IDAT without retaining the source backing store', () => {
    const compressed = deflateSync(smallRows);
    const emptyBlock = Buffer.from([0, 0, 0, 255, 255]);
    const padded = Buffer.concat([
      compressed.subarray(0, 2),
      ...Array<Buffer>(20000).fill(emptyBlock),
      compressed.subarray(2),
    ]);
    const input = png(
      header(1, 1),
      chunk('IDAT'),
      chunk('IDAT', padded.subarray(0, 1)),
      chunk('IDAT'),
      chunk('IDAT', padded.subarray(1)),
      chunk('IDAT'),
      end,
    );
    const output = sanitizeFrame(input, { width: 1, height: 1 }, []);
    expect(output.buffer).not.toBe(input.buffer);
    input.fill(255);
    expect([...PNG.sync.read(output).data]).toEqual([1, 2, 3, 4]);
  });

  it('handles many empty chunks with constant inspection metadata', () => {
    const input = png(header(1, 1), ...Array<Buffer>(20000).fill(chunk('IDAT')), smallIdat, end);
    expect([...PNG.sync.read(sanitizeFrame(input, { width: 1, height: 1 }, [])).data]).toEqual([1, 2, 3, 4]);
  });

  it('does not mutate a source when a later chunk fails validation', () => {
    const badEnd = Buffer.from(end);
    badEnd[11] = badEnd[11]! ^ 1;
    const input = png(header(1, 1), smallIdat, badEnd);
    const original = Buffer.from(input);
    rejects(input);
    expect(input).toEqual(original);
  });
});

describe('capture PNG rejection', () => {
  it.each([
    ['bad signature', Buffer.from('not a png')],
    ['header not first', png(chunk('tEXt'), header(1, 1), smallIdat, end)],
    ['duplicate header', png(header(1, 1), header(1, 1), smallIdat, end)],
    ['missing data', png(header(1, 1), end)],
    ['empty compressed stream', png(header(1, 1), chunk('IDAT'), end)],
    ['missing end', png(header(1, 1), smallIdat)],
    ['end payload', png(header(1, 1), smallIdat, chunk('IEND', Buffer.from([0])))],
    ['PNG trailer', Buffer.concat([png(header(1, 1), smallIdat, end), Buffer.from([0])])],
    ['noncontiguous data', png(header(1, 1), smallIdat, chunk('tEXt'), chunk('IDAT'), end)],
    ['unknown critical', png(header(1, 1), chunk('ABCD'), smallIdat, end)],
    ['nonletter chunk type', png(header(1, 1), chunk('a1CD'), smallIdat, end)],
    ['reserved chunk bit', png(header(1, 1), chunk('abca'), smallIdat, end)],
    ...['acTL', 'fcTL', 'fdAT'].map((name): [string, Buffer] => [name, png(header(1, 1), chunk(name), smallIdat, end)]),
    ['invalid filter', png(header(1, 1), chunk('IDAT', deflateSync(Buffer.from([5, 1, 2, 3, 4]))), end)],
    ['short inflation', png(header(1, 1), chunk('IDAT', deflateSync(Buffer.alloc(4))), end)],
    ['excess inflation', png(header(1, 1), chunk('IDAT', deflateSync(Buffer.alloc(6))), end)],
    [
      'compressed trailer',
      png(header(1, 1), chunk('IDAT', Buffer.concat([deflateSync(smallRows), Buffer.from([0])])), end),
    ],
    [
      'concatenated streams',
      png(header(1, 1), chunk('IDAT', Buffer.concat([deflateSync(smallRows), deflateSync(smallRows)])), end),
    ],
    ['unfinished stream', png(header(1, 1), chunk('IDAT', deflateSync(smallRows).subarray(0, -1)), end)],
    ['zero width', png(header(0, 1), smallIdat, end)],
    ['unexpected size', png(header(2, 1), smallIdat, end)],
    ['16 bit', png(header(1, 1, 4, { 8: 16 }), smallIdat, end)],
    ['grayscale', png(header(1, 1, 4, { 9: 0 }), smallIdat, end)],
    ['palette encoding', png(header(1, 1, 4, { 9: 3 }), smallIdat, end)],
    ['compression method', png(header(1, 1, 4, { 10: 1 }), smallIdat, end)],
    ['filter method', png(header(1, 1, 4, { 11: 1 }), smallIdat, end)],
    ['interlace', png(header(1, 1, 4, { 12: 1 }), smallIdat, end)],
  ] satisfies [string, Buffer][])('rejects %s', (_name, input) => {
    rejects(Buffer.from(input));
  });

  it.each([
    ['empty palette', [chunk('PLTE')]],
    ['misaligned palette', [chunk('PLTE', Buffer.alloc(2))]],
    ['oversized palette', [chunk('PLTE', Buffer.alloc(771))]],
    ['duplicate palette', [chunk('PLTE', Buffer.alloc(3)), chunk('PLTE', Buffer.alloc(3))]],
    ['bad gamma length', [chunk('gAMA', Buffer.alloc(3))]],
    ['zero gamma', [gamma(0)]],
    ['duplicate gamma', [gamma(), gamma()]],
    ['late gamma', [chunk('PLTE', Buffer.alloc(3)), gamma()]],
    ['bad transparency length', [chunk('tRNS', Buffer.alloc(5))]],
    ['out of range transparency', [transparency(256, 0, 0)]],
    ['duplicate transparency', [transparency(1, 2, 3), transparency(1, 2, 3)]],
    ['palette after transparency', [transparency(1, 2, 3), chunk('PLTE', Buffer.alloc(3))]],
  ])('rejects %s', (_name, chunks) => {
    rejects(png(header(1, 1, 3), ...chunks, chunk('IDAT', deflateSync(Buffer.alloc(4))), end));
  });

  it('rejects transparency on RGBA and known metadata after image data', () => {
    rejects(png(header(1, 1), transparency(1, 2, 3), smallIdat, end));
    for (const metadata of [transparency(1, 2, 3), gamma(), chunk('PLTE', Buffer.alloc(3))])
      rejects(png(header(1, 1, 3), chunk('IDAT', deflateSync(Buffer.alloc(4))), metadata, end));
  });

  it.each(['IHDR', 'PLTE', 'gAMA', 'tRNS', 'tEXt', 'IDAT', 'IEND'])('checks the %s CRC', (kind) => {
    const chunks = [
      header(1, 1, 3),
      gamma(),
      chunk('PLTE', Buffer.alloc(3)),
      transparency(1, 2, 3),
      chunk('tEXt'),
      chunk('IDAT', deflateSync(Buffer.alloc(4))),
      end,
    ].map((value) => Buffer.from(value));
    const corrupted = chunks.find((value) => value.toString('ascii', 4, 8) === kind)!;
    corrupted[corrupted.length - 1] = corrupted[corrupted.length - 1]! ^ 1;
    rejects(png(...chunks));
  });

  it('rejects truncated framing, huge claimed chunk lengths, and zlib checksum corruption', () => {
    const valid = png(header(1, 1), smallIdat, end);
    for (const length of [0, 8, 32, 40, valid.length - 1]) rejects(Buffer.from(valid.subarray(0, length)));
    const huge = Buffer.from(valid);
    huge.writeUInt32BE(0xffffffff, 33);
    rejects(huge);
    const compressed = deflateSync(smallRows);
    compressed[compressed.length - 1] = compressed[compressed.length - 1]! ^ 1;
    rejects(png(header(1, 1), chunk('IDAT', compressed), end));
  });

  it('enforces encoded, decoded, and safe geometry limits before decoding', () => {
    rejects(Buffer.alloc(MAX_PNG_BYTES + 1));
    rejects(png(header(0xffffffff, 0xffffffff), smallIdat, end), {
      width: 0xffffffff,
      height: 0xffffffff,
    });
    rejects(png(header(4096, 4096), smallIdat, end), {
      width: 4096,
      height: 4096,
    });
    for (const width of [NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])
      rejects(png(header(1, 1), smallIdat, end), { width, height: 1 });
  });

  it.each([
    { x: -1, y: 0, width: 1, height: 1 },
    { x: 0, y: -1, width: 1, height: 1 },
    { x: 0, y: 0, width: 0, height: 1 },
    { x: 0, y: 0, width: 1, height: -1 },
    { x: 0.5, y: 0, width: 1, height: 1 },
    { x: 0, y: 0, width: 2, height: 1 },
    { x: 0, y: 0, width: 1, height: Infinity },
    { x: 0, y: NaN, width: 1, height: 1 },
  ])('retains MASK_INVALID for invalid mask %j', (rect) => {
    expect(() => sanitizeFrame(png(header(1, 1), smallIdat, end), { width: 1, height: 1 }, [rect])).toThrow(
      expect.objectContaining({ code: 'MASK_INVALID' }),
    );
    expect(() => sanitizeFrame(Buffer.from('bad PNG'), { width: 1, height: 1 }, [rect])).toThrow(
      expect.objectContaining({ code: 'CAPTURE_PNG_INVALID' }),
    );
  });

  it('bounds incompressible output at the smallest, default, and largest admitted pixel counts', () => {
    for (const [width, height] of [
      [320, 240],
      [1280, 800],
      [1920, 1080],
    ]) {
      const w = width!;
      const h = height!;
      const pixels = patterned(w * h * 4);
      const image = new PNG({ width: w, height: h });
      image.data = pixels;
      const input = PNG.sync.write(image, { deflateLevel: 1, filterType: 0 });
      const output = sanitizeFrame(input, { width: w, height: h }, []);
      expect(output.length).toBeLessThanOrEqual(Math.min(MAX_PNG_BYTES, 5 * w * h + 256 + 57));
      expect(output.buffer.byteLength).toBe(output.length);
      expect(PNG.sync.read(output).data.equals(pixels)).toBe(true);
    }
  });

  it('fails closed when re-encoding would exceed the encoded output limit', () => {
    const width = 1000;
    const height = 4193;
    const rows = patterned((width * 4 + 1) * height);
    for (let offset = 0; offset + 1024 < rows.length; offset += 1024)
      rows.copy(rows, offset + 512, offset, offset + 512);
    for (let y = 0; y < height; y++) rows[y * (width * 4 + 1)] = 0;
    const input = png(header(width, height), chunk('IDAT', deflateSync(rows, { level: 1 })), end);
    expect(input.length).toBeLessThan(MAX_PNG_BYTES);
    expect(deflateSync(rows, { level: 1, strategy: 3 }).length + 57).toBeGreaterThan(MAX_PNG_BYTES);
    rejects(input, { width, height });
  });
});
