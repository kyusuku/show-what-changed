import { spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import { childEnvironment } from '../runtime/process-table.js';
import { checkCancelled, failure } from '../schema/errors.js';
import { SourceSettingsSchema } from '../schema/recipe.js';
import type { SourceSettings } from '../schema/recipe.js';

export const GIT_OPTIONS = ['--no-replace-objects', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'diff.external=', '-c', 'core.quotePath=false'];
const METADATA_LIMIT = 64 * 1024 * 1024;
export const SINGLE_FILE_LIMIT = 512 * 1024 * 1024;
const environment = () => ({ ...childEnvironment('git-probe'), GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_GRAFT_FILE: '/dev/null' });
export async function gitBytes(cwd: string, args: readonly string[], options: { input?: string; allowFailure?: boolean; signal?: AbortSignal; limit?: number } = {}): Promise<Buffer> {
  if (options.signal) checkCancelled(options.signal);
  const child = spawn('git', [...GIT_OPTIONS, ...args], { cwd, shell: false, detached: true, env: environment(), stdio: ['pipe', 'pipe', 'pipe'] });
  const chunks: Buffer[] = []; let size = 0; let failed = false;
  const limit = options.limit ?? METADATA_LIMIT;
  const stop = (): void => { failed = true; if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} } };
  const timer = setTimeout(stop, 30_000); timer.unref();
  const abort = (): void => stop(); options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) stop();
  child.stdout.on('data', (chunk: Buffer) => { size += chunk.length; if (size > limit) stop(); else chunks.push(chunk); });
  child.stderr.resume(); child.stdin.on('error', () => {});
  const done = new Promise<number | null>((resolve, reject) => { child.once('error', () => reject(failure(8, 'GIT_UNAVAILABLE', 'source', 'Git could not be started.', 'Install Git and retry.'))); child.once('close', resolve); });
  child.stdin.end(options.input);
  try {
    const code = await done;
    if (options.signal) checkCancelled(options.signal);
    if (failed || code !== 0 && !options.allowFailure) throw failure(2, 'GIT_FAILED', 'source', 'Git could not inspect the selected source.', 'Check the requested refs and repository state; fetch missing refs explicitly.');
    return Buffer.concat(chunks);
  } finally { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); }
}
export function utf8(bytes: Uint8Array): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw failure(2, 'UNSUPPORTED_SOURCE_LAYOUT', 'source', 'Source paths or metadata contain invalid UTF-8.', 'Use UTF-8 source filenames and metadata.'); }
}
export function nulStrings(bytes: Buffer): string[] { return utf8(bytes).split('\0').filter((entry) => entry.length > 0); }
export async function gitText(cwd: string, args: readonly string[], signal?: AbortSignal): Promise<string> { return utf8(await gitBytes(cwd, args, signal ? { signal } : {})).trim(); }
export async function repositoryRoot(invocationDir: string, signal?: AbortSignal): Promise<string> {
  const root = utf8(await gitBytes(invocationDir, ['rev-parse', '--show-toplevel'], signal ? { signal } : {})).replace(/\n$/, '');
  if (!root || await gitText(root, ['rev-parse', '--is-bare-repository'], signal) !== 'false') throw failure(2, 'REPOSITORY_REQUIRED', 'source', 'A nonbare Git repository is required.', 'Run inside a repository with an existing commit.');
  return realpath(root);
}
export async function resolveCommit(root: string, ref: string, signal?: AbortSignal): Promise<string> {
  if (!ref || ref.startsWith('-') || ref.includes('\0')) throw failure(2, 'INVALID_REF', 'source', 'Refs must be nonempty and cannot begin with a dash.', 'Pass an existing commit, branch or tag.');
  const oid = await gitText(root, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], signal);
  if (!/^[a-f0-9]{40,}$/.test(oid)) throw failure(2, 'INVALID_REF', 'source', 'The ref did not resolve to a full commit object ID.', 'Pass an existing commit, branch or tag.');
  return oid;
}
export type TreeFile = Readonly<{ path: string; mode: string; oid: string; byteLength: number }>;
export async function readTree(root: string, commit: string, signal?: AbortSignal, settings: SourceSettings = SourceSettingsSchema.parse({})): Promise<TreeFile[]> {
  const entries = nulStrings(await gitBytes(root, ['ls-tree', '-rlz', '--full-tree', commit], signal ? { signal } : {})).map((record) => {
    const match = /^(\d+) (\w+) ([a-f0-9]+) +(-|\d+)\t([\s\S]+)$/.exec(record);
    if (!match?.[1] || !match[2] || !match[3] || !match[4] || !match[5]) throw failure(2, 'GIT_FAILED', 'source', 'Git returned an invalid source tree entry.', 'Check repository integrity.');
    if (match[2] !== 'blob' || !['100644', '100755'].includes(match[1])) throw failure(2, 'UNSUPPORTED_SOURCE_LAYOUT', 'source', `Submodule, symlink or nonregular source entry ${JSON.stringify(match[5])} is unsupported.`, 'Use regular source files.');
    return { mode: match[1], oid: match[3], path: match[5], byteLength: Number(match[4]) };
  });
  const bytes = entries.reduce((total, entry) => total + entry.byteLength, 0);
  if (entries.length > settings.maxFiles || bytes > settings.maxBytes || entries.some((entry) => entry.byteLength > SINGLE_FILE_LIMIT)) throw failure(2, 'SOURCE_LIMIT', 'source', `Source contains ${entries.length} files and ${bytes} bytes; configured limits are ${settings.maxFiles} files, ${settings.maxBytes} bytes, and ${SINGLE_FILE_LIMIT} bytes per file.`, 'Increase source budgets within the supported bounds or reduce source inputs.');
  return entries;
}
class BlobReader {
  private readonly iterator: AsyncIterator<unknown>;
  private remaining: Buffer = Buffer.alloc(0);
  constructor(stream: Readable) { this.iterator = stream[Symbol.asyncIterator](); }
  private async fill(): Promise<void> {
    const next = await this.iterator.next();
    if (next.done || !Buffer.isBuffer(next.value)) throw failure(2, 'GIT_FAILED', 'source', 'Git returned an incomplete source object.', 'Check repository integrity.');
    this.remaining = next.value;
  }
  async line(): Promise<string> {
    const pieces: Buffer[] = []; let size = 0;
    while (true) {
      if (!this.remaining.length) await this.fill();
      const end = this.remaining.indexOf(10);
      const piece = end < 0 ? this.remaining : this.remaining.subarray(0, end);
      pieces.push(piece); size += piece.length;
      if (size > 1024) throw failure(2, 'GIT_FAILED', 'source', 'Git returned an oversized blob header.', 'Check repository integrity.');
      this.remaining = end < 0 ? Buffer.alloc(0) : this.remaining.subarray(end + 1);
      if (end >= 0) return utf8(Buffer.concat(pieces));
    }
  }
  async *bytes(size: number): AsyncGenerator<Buffer> {
    let left = size;
    while (left > 0) {
      if (!this.remaining.length) await this.fill();
      const length = Math.min(left, this.remaining.length, 64 * 1024);
      const chunk = this.remaining.subarray(0, length);
      this.remaining = this.remaining.subarray(length); left -= length;
      yield chunk;
    }
  }
}
export async function visitTreeBlobs(root: string, entries: readonly TreeFile[], visitor: (entry: TreeFile, chunks: AsyncIterable<Buffer>) => Promise<void>, signal?: AbortSignal): Promise<void> {
  if (signal) checkCancelled(signal);
  if (!entries.length) return;
  const child = spawn('git', [...GIT_OPTIONS, 'cat-file', '--batch'], { cwd: root, shell: false, detached: true, env: environment(), stdio: ['pipe', 'pipe', 'pipe'] });
  const stop = (): void => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} } };
  let spawnError = false;
  const done = new Promise<number | null>((resolve) => { child.once('error', () => { spawnError = true; resolve(null); }); child.once('close', resolve); });
  child.stderr.resume(); child.stdin.on('error', () => {});
  const timer = setTimeout(stop, 300_000); timer.unref();
  signal?.addEventListener('abort', stop, { once: true });
  const reader = new BlobReader(child.stdout);
  try {
    for (const entry of entries) {
      if (signal) checkCancelled(signal);
      child.stdin.write(`${entry.oid}\n`);
      const header = await reader.line();
      if (header !== `${entry.oid} blob ${entry.byteLength}`) throw failure(2, 'GIT_FAILED', 'source', 'Git returned an invalid source object.', 'Check repository integrity.');
      let consumed = 0;
      async function* chunks(): AsyncGenerator<Buffer> { for await (const chunk of reader.bytes(entry.byteLength)) { if (signal) checkCancelled(signal); consumed += chunk.length; yield chunk; } }
      await visitor(entry, chunks());
      if (consumed !== entry.byteLength || await reader.line() !== '') throw failure(2, 'GIT_FAILED', 'source', 'A source blob was not completely consumed.', 'Check repository integrity.');
    }
    child.stdin.end();
    const code = await done;
    if (signal) checkCancelled(signal);
    if (spawnError) throw failure(8, 'GIT_UNAVAILABLE', 'source', 'Git could not be started.', 'Install Git and retry.');
    if (code !== 0) throw failure(2, 'GIT_FAILED', 'source', 'Git could not stream source objects.', 'Check repository integrity.');
  } catch (error) { if (signal) checkCancelled(signal); if (spawnError) throw failure(8, 'GIT_UNAVAILABLE', 'source', 'Git could not be started.', 'Install Git and retry.'); throw error; }
  finally { stop(); child.stdin.destroy(); child.stdout.destroy(); clearTimeout(timer); signal?.removeEventListener('abort', stop); await done; }
}
