import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readdir, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import type { Artifact } from '../schema/index.js';
import type { RunContext } from '../schema/contracts.js';
import { failure } from '../schema/errors.js';
import { sha256 } from '../schema/io.js';

const written = new WeakMap<RunContext, Set<string>>();
export function containedPath(root: string, path: string): string {
  if (!path || isAbsolute(path) || path.includes('\\') || path.split('/').some((part) => !part || part === '.' || part === '..') || path.includes('\0')) {
    throw failure(2, 'UNSAFE_PATH', 'artifacts', 'Artifact paths must be contained relative paths.', 'Use a path inside the owned run directory.');
  }
  const resolved = resolve(root, path);
  if (relative(root, resolved).startsWith(`..${sep}`) || relative(root, resolved) === '..') throw failure(2, 'UNSAFE_PATH', 'artifacts', 'Path escapes its owned root.', 'Use a contained path.');
  return resolved;
}
export async function safeDirectory(path: string, create = false): Promise<void> {
  const absolute = resolve(path);
  let cursor = parse(absolute).root;
  for (const part of absolute.slice(cursor.length).split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    if (create) {
      try { await mkdir(cursor, { mode: 0o700 }); } catch (error) { if (!hasCode(error, 'EEXIST')) throw error; }
    }
    const stat = await lstat(cursor);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw failure(2, 'UNSAFE_PATH', 'artifacts', 'A managed path has a symlink or non-directory ancestor.', 'Remove the unsafe output path and retry.');
  }
  if (await realpath(absolute) !== absolute) throw failure(2, 'UNSAFE_PATH', 'artifacts', 'A managed directory is not canonical.', 'Use its canonical directory.');
}
export function hasCode(error: unknown, code: string): boolean { return error instanceof Error && 'code' in error && error.code === code; }
export async function readContainedFile(root: string, relativePath: string, maxBytes: number): Promise<Buffer> {
  const path = containedPath(root, relativePath);
  await safeDirectory(dirname(path));
  const namedBefore = await lstat(path);
  if (!namedBefore.isFile() || namedBefore.isSymbolicLink()) throw failure(2, 'INVALID_ARTIFACT', 'artifacts', 'Input must be a regular file.', 'Use an intact run artifact.');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const initial = await file.stat();
    if (!initial.isFile() || initial.size > maxBytes) throw failure(2, 'INVALID_ARTIFACT', 'artifacts', 'Input must be a bounded regular file.', 'Use an intact run artifact.');
    const bytes = Buffer.alloc(initial.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const { bytesRead } = await file.read(bytes, size, bytes.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    const after = await file.stat();
    const named = await lstat(path);
    await safeDirectory(dirname(path));
    if (size !== initial.size || after.size !== initial.size || after.mtimeMs !== initial.mtimeMs || after.ctimeMs !== initial.ctimeMs || named.ino !== initial.ino || named.dev !== initial.dev || !named.isFile()) {
      throw failure(2, 'INPUT_CHANGED', 'artifacts', 'Input changed while being read.', 'Retry with stable input files.');
    }
    return bytes.subarray(0, size);
  } finally { await file.close(); }
}
export async function atomicPrivateFile(root: string, relativePath: string, contents: string | Uint8Array, replace: boolean, expectedSha256?: string): Promise<void> {
  const path = containedPath(root, relativePath);
  await safeDirectory(dirname(path), true);
  try {
    const existing = await lstat(path);
    if (!replace || !existing.isFile() || existing.isSymbolicLink()) throw failure(2, 'UNSAFE_OUTPUT', 'artifacts', 'Refusing to replace an unowned or nonregular file.', 'Choose a fresh owned output path.');
  } catch (error) { if (!hasCode(error, 'ENOENT')) throw error; }
  const assertExpected = async (): Promise<void> => {
    if (expectedSha256 === undefined) return;
    let matches = false;
    try { matches = sha256(await readContainedFile(root, relativePath, 128 * 1024 * 1024)) === expectedSha256; } catch {}
    if (!matches) throw failure(2, 'UNSAFE_OUTPUT', 'artifacts', 'The owned output changed before replacement.', 'Inspect the changed file before generating a replacement.');
  };
  await assertExpected();
  const temporary = join(dirname(path), `.swc-${randomBytes(12).toString('hex')}.tmp`);
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await file.writeFile(contents);
    await file.sync();
    await file.close();
    await safeDirectory(dirname(path));
    try { const stat = await lstat(path); if (!replace || !stat.isFile() || stat.isSymbolicLink()) throw failure(2, 'UNSAFE_OUTPUT', 'artifacts', 'Output changed during write.', 'Retry in a fresh run.'); } catch (error) { if (!hasCode(error, 'ENOENT')) throw error; }
    await assertExpected();
    if (replace) await rename(temporary, path); else await link(temporary, path);
  } finally { await file.close().catch(() => {}); await unlink(temporary).catch((error: unknown) => { if (!hasCode(error, 'ENOENT')) throw error; }); }
}
export async function writeRunFile(run: RunContext, relativePath: string, contents: string | Uint8Array): Promise<void> {
  let paths = written.get(run);
  if (!paths) { paths = new Set(); written.set(run, paths); }
  await atomicPrivateFile(run.paths.runDir, relativePath, contents, paths.has(relativePath));
  paths.add(relativePath);
}
export async function readRunFile(runDir: string, relativePath: string, maxBytes: number): Promise<Buffer> { return readContainedFile(runDir, relativePath, maxBytes); }
export async function artifactInfo(runDir: string, relativePath: string): Promise<Artifact> {
  const path = containedPath(runDir, relativePath); await safeDirectory(dirname(path));
  const namedBefore = await lstat(path);
  if (!namedBefore.isFile() || namedBefore.isSymbolicLink()) throw failure(2, 'INVALID_ARTIFACT', 'artifacts', 'Input must be a regular file.', 'Use an intact run artifact.');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const initial = await file.stat();
    if (!initial.isFile() || initial.size > 512 * 1024 * 1024) throw failure(2, 'INVALID_ARTIFACT', 'artifacts', 'Artifact must be a bounded regular file.', 'Use an intact run artifact.');
    const hash = createHash('sha256'); const chunk = Buffer.alloc(64 * 1024); let size = 0;
    while (true) { const { bytesRead } = await file.read(chunk, 0, chunk.length, null); if (!bytesRead) break; size += bytesRead; if (size > initial.size) throw failure(2, 'INPUT_CHANGED', 'artifacts', 'Artifact changed while hashing.', 'Retry with stable run artifacts.'); hash.update(chunk.subarray(0, bytesRead)); }
    const after = await file.stat(); const named = await lstat(path); await safeDirectory(dirname(path));
    if (size !== initial.size || after.ctimeMs !== initial.ctimeMs || after.mtimeMs !== initial.mtimeMs || named.ino !== initial.ino || named.dev !== initial.dev || !named.isFile()) throw failure(2, 'INPUT_CHANGED', 'artifacts', 'Artifact changed while hashing.', 'Retry with stable run artifacts.');
    return { path: relativePath, sha256: hash.digest('hex'), bytes: size };
  } finally { await file.close(); }
}
export async function registerExistingRunFiles(run: RunContext): Promise<void> {
  const paths = new Set<string>();
  const visit = async (directory: string, prefix: string): Promise<void> => {
    await safeDirectory(directory);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw failure(2, 'UNSAFE_PATH', 'artifacts', 'A saved run contains a symlink.', 'Use an intact owned run.');
      if (entry.isDirectory()) await visit(join(directory, entry.name), relative);
      else if (entry.isFile()) paths.add(relative);
      else throw failure(2, 'UNSAFE_PATH', 'artifacts', 'A saved run contains a nonregular entry.', 'Use an intact owned run.');
    }
  };
  await visit(run.paths.runDir, ''); written.set(run, paths);
}
export async function renameRunFile(run: RunContext, fromRelative: string, toRelative: string): Promise<void> {
  const source = containedPath(run.paths.runDir, fromRelative);
  const destination = containedPath(run.paths.runDir, toRelative);
  await safeDirectory(dirname(source)); await safeDirectory(dirname(destination), true);
  const sourceStat = await lstat(source);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) throw failure(2, 'UNSAFE_OUTPUT', 'artifacts', 'Media output must be a regular file.', 'Use an intact owned output.');
  const file = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!(await file.stat()).isFile()) throw failure(2, 'UNSAFE_OUTPUT', 'artifacts', 'Media output is not a regular file.', 'Retry in a fresh run.');
    await file.chmod(0o600);
    let paths = written.get(run); if (!paths) { paths = new Set(); written.set(run, paths); }
    try { const existing = await lstat(destination); if (!paths.has(toRelative) || !existing.isFile() || existing.isSymbolicLink()) throw failure(2, 'UNSAFE_OUTPUT', 'artifacts', 'Refusing to replace an unowned output.', 'Use a fresh owned output file.'); } catch (error) { if (!hasCode(error, 'ENOENT')) throw error; }
    const held = await file.stat(); const named = await lstat(source);
    if (held.ino !== named.ino || held.dev !== named.dev || !named.isFile()) throw failure(2, 'UNSAFE_OUTPUT', 'artifacts', 'Media output changed during validation.', 'Retry in a fresh run.');
    await safeDirectory(dirname(source)); await safeDirectory(dirname(destination));
    await rename(source, destination); paths.add(toRelative); paths.delete(fromRelative);
  } finally { await file.close(); }
}
