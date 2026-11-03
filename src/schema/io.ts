import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';

export function sanitizeText(text: string): string {
  return text.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x1f\x7f-\x9f]/g, '');
}
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(Reflect.get(value, key))}`).join(',')}}`;
  }
  throw new TypeError('Canonical JSON accepts only JSON values');
}
export function sha256(bytes: Uint8Array | string): string { return createHash('sha256').update(bytes).digest('hex'); }
export function digest(value: unknown): string { return sha256(canonicalJson(value)); }
export async function readJsonDocument(path: string, limit = 1024 * 1024): Promise<{ value: unknown; rawSha256: string }> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error(`JSON input must be a regular file no larger than ${limit} bytes`);
    const bytes = Buffer.alloc(Math.min(limit + 1, stat.size + 1));
    let offset = 0;
    while (offset < bytes.length) {
      const chunk = await file.read(bytes, offset, bytes.length - offset, null);
      if (!chunk.bytesRead) break;
      offset += chunk.bytesRead;
    }
    if (offset > limit || offset !== stat.size) throw new Error('JSON input changed while reading or exceeded its limit');
    const content = bytes.subarray(0, offset);
    return { value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(content)), rawSha256: sha256(content) };
  } finally { await file.close(); }
}

export async function readJsonInput(path: string, limit = 1024 * 1024): Promise<unknown> {
  return (await readJsonDocument(path, limit)).value;
}
