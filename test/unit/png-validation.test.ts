import { deflateSync } from 'node:zlib';
import { PNG } from 'pngjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { validatePng } from '../../src/composer/images.js';
import { sanitizeFrame } from '../../src/recorder/images.js';

function chunk(kind: string, payload: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(kind), payload]);
  let crc = 0xffffffff;
  for (const byte of body) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  const result = Buffer.alloc(payload.length + 12);
  result.writeUInt32BE(payload.length, 0);
  body.copy(result, 4);
  result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);
  return result;
}
function header(width = 1280, height = 800, interlace = 0, depth = 8, color = 6): Buffer {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width, 0); data.writeUInt32BE(height, 4);
  data[8] = depth; data[9] = color; data[12] = interlace;
  return chunk('IHDR', data);
}
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function png(headers: Buffer[], rawBytes: number): Buffer {
  return Buffer.concat([signature, ...headers, chunk('IDAT', deflateSync(Buffer.alloc(rawBytes))), chunk('IEND', Buffer.alloc(0))]);
}
afterEach(() => vi.restoreAllMocks());

describe('bounded PNG decoding', () => {
  it('accepts a real captured-size PNG with checked CRCs', () => {
    const bytes = PNG.sync.write(new PNG({ width: 1280, height: 800 }));
    expect(() => validatePng(bytes, 1280, 800)).not.toThrow();
  });

  it.each([
    ['interlaced allocation bomb', [header(1280, 800, 1)], 32 * 1024 * 1024],
    ['duplicate dimension header', [header(), header(2048, 2048)], (2048 * 4 + 1) * 2048],
    ['oversized filtered rows', [header()], (1280 * 4 + 1) * 800 + 1],
  ])('rejects %s before invoking the image decoder', (_name, headers, rawBytes) => {
    const bytes = png(headers as Buffer[], rawBytes as number);
    const decoder = vi.spyOn(PNG.sync, 'read');
    expect(() => validatePng(bytes, 1280, 800)).toThrow(expect.objectContaining({ exitCode: 9 }));
    expect(decoder).not.toHaveBeenCalled();
  });

  it('rejects truncated chunks and bytes after the final chunk', () => {
    const valid = PNG.sync.write(new PNG({ width: 1280, height: 800 }));
    for (const bytes of [valid.subarray(0, valid.length - 1), Buffer.concat([valid, Buffer.from('extra')])]) {
      expect(() => validatePng(bytes, 1280, 800)).toThrow(expect.objectContaining({ exitCode: 9 }));
    }
  });
});


describe('capture PNG allocation envelope', () => {
  it('rejects valid 16-bit RGBA before the decoder while general composition still accepts it', () => {
    const bytes = png([header(640, 480, 0, 16)], (640 * 8 + 1) * 480);
    expect(() => validatePng(bytes, 640, 480)).not.toThrow();
    const decoder = vi.spyOn(PNG.sync, 'read');
    expect(() => sanitizeFrame(bytes, { width: 640, height: 480 }, [])).toThrow(
      expect.objectContaining({ code: 'CAPTURE_PNG_INVALID' }),
    );
    expect(decoder).not.toHaveBeenCalled();
  });
  it.each([2, 6])('masks supported 8-bit color type %s opaquely', (color) => {
    const channels = color === 2 ? 3 : 4;
    const bytes = png([header(320, 240, 0, 8, color)], (320 * channels + 1) * 240);
    const safe = PNG.sync.read(sanitizeFrame(bytes, { width: 320, height: 240 }, [{ x: 1, y: 1, width: 2, height: 2 }]));
    for (const pixel of [321, 322, 641, 642])
      expect([...safe.data.subarray(pixel * 4, pixel * 4 + 4)]).toEqual([16, 16, 16, 255]);
  });
});
