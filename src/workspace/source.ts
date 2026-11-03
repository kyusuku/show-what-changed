import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat, open } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { InventoryEntry, SourceInspection, SourceInventory, SourceRequest } from '../schema/contracts.js';
import type { Plan } from '../schema/index.js';
import { SourceSettingsSchema } from '../schema/recipe.js';
import type { SourceSettings } from '../schema/recipe.js';
import { checkCancelled, failure } from '../schema/errors.js';
import { digest } from '../schema/io.js';
import { hasCode, safeDirectory } from '../runtime/files.js';
import { registeredOutputPaths, untrackedSourcePaths } from '../runtime/outputs.js';
import type { OutputPaths } from '../runtime/outputs.js';
import { gitBytes, gitText, nulStrings, readTree, repositoryRoot, resolveCommit, SINGLE_FILE_LIMIT, utf8, visitTreeBlobs } from './git.js';
import type { TreeFile } from './git.js';

const METADATA_LIMIT = 1024 * 1024;
const defaults = SourceSettingsSchema.parse({});
export function byteSort(a: string, b: string): number { return Buffer.compare(Buffer.from(a), Buffer.from(b)); }
export function excludedSource(path: string): boolean { return path === '.git' || path.startsWith('.git/'); }
export function validateSourcePath(path: string): void {
  if (!path || Buffer.byteLength(path) > 4096 || isAbsolute(path) || path.includes('\0') || path.includes('\\') || path.split('/').some((part) => part === '.' || part === '..' || !part || part.toLowerCase() === '.git')) unsupported('A source filename cannot be safely represented.');
}
export function fingerprintInventory(entries: SourceInventory): string { return digest([...entries].sort((a, b) => byteSort(a.path, b.path))); }
export function validateInventory(entries: SourceInventory, settings: SourceSettings = defaults): void {
  let bytes = 0; let files = 0; const paths = new Set<string>();
  for (const entry of entries) {
    validateSourcePath(entry.path);
    if (paths.has(entry.path)) unsupported(`The source inventory contains duplicate path ${JSON.stringify(entry.path)}.`);
    paths.add(entry.path);
    if (entry.exists) {
      if (!Number.isSafeInteger(entry.byteLength) || entry.byteLength < 0 || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new TypeError('Invalid source inventory');
      bytes += entry.byteLength; files++;
      if (entry.byteLength > SINGLE_FILE_LIMIT) sourceLimit(files, bytes, settings, entry.byteLength);
    }
  }
  if (entries.length > settings.maxFiles || bytes > settings.maxBytes) sourceLimit(files, bytes, settings);
}
function sourceLimit(files: number, bytes: number, settings: SourceSettings, single?: number): never {
  throw failure(2, 'SOURCE_LIMIT', 'source', `Source contains ${files} files and ${bytes} bytes${single === undefined ? '' : `; one file contains ${single} bytes`}. Limits are ${settings.maxFiles} files, ${settings.maxBytes} bytes, and ${SINGLE_FILE_LIMIT} bytes per file.`, 'Increase source budgets within the supported bounds or reduce source inputs.');
}
export function sourceStats(inventory: SourceInventory): Plan['sourceStats']['before'] {
  return { files: inventory.filter((entry) => entry.exists).length, bytes: inventory.reduce((total, entry) => total + (entry.exists ? entry.byteLength : 0), 0), fingerprint: fingerprintInventory(inventory) };
}
export function validateGeneratedDirs(settings: SourceSettings, inventories: readonly SourceInventory[]): void {
  for (const prefix of settings.generatedDirs) {
    validateSourcePath(prefix);
    if (excludedSource(prefix)) unsupported('Generated directories cannot cover Git internals.');
    if (inventories.some((inventory) => inventory.some((entry) => entry.exists && (entry.path === prefix || entry.path.startsWith(`${prefix}/`))))) throw failure(2, 'GENERATED_DIR_CONFLICT', 'source', `Generated directory ${JSON.stringify(prefix)} covers an existing source input.`, 'Declare only output directories with no eligible pre-existing inputs.');
  }
}
export function validateOverlay(before: SourceInventory, after: SourceInventory): void {
  const first = new Set(before.filter((entry) => entry.exists).map((entry) => entry.path));
  const second = new Set(after.filter((entry) => entry.exists).map((entry) => entry.path));
  for (const [files, other] of [[first, second], [second, first]]) {
    if (!files || !other) continue;
    for (const path of files) {
      let parent = dirname(path);
      while (parent !== '.') { if (other.has(parent)) throw failure(2, 'UNSUPPORTED_SOURCE_LAYOUT', 'source', `File-to-directory source transitions at ${JSON.stringify(parent)} are unsupported.`, 'Commit the layout change and compare explicit commit refs.'); parent = dirname(parent); }
    }
  }
}
export function diffInventories(before: SourceInventory, after: SourceInventory): Plan['changedFiles'] {
  const left = new Map(before.map((entry) => [entry.path, entry])); const right = new Map(after.map((entry) => [entry.path, entry]));
  return [...new Set([...left.keys(), ...right.keys()])].sort(byteSort).flatMap<Plan['changedFiles'][number]>((path) => {
    const a = left.get(path); const b = right.get(path);
    if (!a?.exists && !b?.exists) return [];
    if (!a?.exists) return [{ status: 'A', oldPath: null, newPath: path }];
    if (!b?.exists) return [{ status: 'D', oldPath: path, newPath: null }];
    return a.sha256 === b.sha256 && a.byteLength === b.byteLength && a.executable === b.executable ? [] : [{ status: 'M', oldPath: path, newPath: path }];
  });
}
function inspectPrefix(path: string, prefix: Buffer): void {
  if (prefix.subarray(0, 200).toString('utf8').startsWith('version https://git-lfs.github.com/spec/v1')) unsupported(`Git LFS pointer file ${JSON.stringify(path)} is unsupported.`);
  if (path.endsWith('.gitattributes') && /(?:^|\s)(?:filter(?:=\S*)?|[!-]filter)(?:\s|$)/m.test(utf8(prefix))) unsupported(`Git filter attributes in ${JSON.stringify(path)} are unsupported.`);
}
export async function treeInventory(root: string, files: readonly TreeFile[], signal?: AbortSignal, settings: SourceSettings = defaults): Promise<SourceInventory> {
  const result: InventoryEntry[] = [];
  await visitTreeBlobs(root, files, async (file, chunks) => {
    validateSourcePath(file.path);
    if (file.path.endsWith('.gitattributes') && file.byteLength > METADATA_LIMIT) unsupported('Git attributes metadata exceeds 1 MiB.');
    const hash = createHash('sha256'); const prefixes: Buffer[] = []; let prefixSize = 0;
    const prefixLimit = file.path.endsWith('.gitattributes') ? METADATA_LIMIT : 200;
    for await (const chunk of chunks) { hash.update(chunk); if (prefixSize < prefixLimit) { const piece = chunk.subarray(0, prefixLimit - prefixSize); prefixes.push(Buffer.from(piece)); prefixSize += piece.length; } }
    inspectPrefix(file.path, Buffer.concat(prefixes));
    result.push({ path: file.path, exists: true, executable: file.mode === '100755', byteLength: file.byteLength, sha256: hash.digest('hex') });
  }, signal);
  result.sort((a, b) => byteSort(a.path, b.path)); validateInventory(result, settings); return result;
}
export async function visitSourceFile(root: string, path: string, visitor: (chunk: Buffer) => Promise<void> | void, signal?: AbortSignal, limit = SINGLE_FILE_LIMIT): Promise<Extract<InventoryEntry, { exists: true }> | null> {
  if (signal) checkCancelled(signal);
  validateSourcePath(path);
  const absolute = resolve(root, path);
  if (relative(root, absolute).startsWith(`..${sep}`)) throw new TypeError('Escaping source path');
  try {
    await safeDirectory(dirname(absolute));
    const namedBefore = await lstat(absolute);
    if (!namedBefore.isFile() || namedBefore.isSymbolicLink()) unsupported(`Source file ${JSON.stringify(path)} is not a regular file.`);
    const file = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const initial = await file.stat();
      if (!initial.isFile() || initial.ino !== namedBefore.ino || initial.dev !== namedBefore.dev) unsupported(`Source file ${JSON.stringify(path)} is not a stable regular file.`);
      if (initial.size > limit) throw failure(2, 'SOURCE_LIMIT', 'source', `Source file ${JSON.stringify(path)} contains ${initial.size} bytes; the limit is ${limit}.`, 'Reduce the file size to the supported input bound.');
      if (path.endsWith('.gitattributes') && initial.size > METADATA_LIMIT) unsupported('Git attributes metadata exceeds 1 MiB.');
      const buffer = Buffer.alloc(64 * 1024); const hash = createHash('sha256'); let offset = 0;
      const prefixes: Buffer[] = []; let prefixSize = 0; const prefixLimit = path.endsWith('.gitattributes') ? METADATA_LIMIT : 200;
      while (true) {
        if (signal) checkCancelled(signal);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, null); if (!bytesRead) break;
        offset += bytesRead;
        if (offset > limit || offset > initial.size) throw failure(2, 'STALE_SOURCE', 'source', 'Source changed while it was read.', 'Rerun after source edits finish.');
        const chunk = buffer.subarray(0, bytesRead); hash.update(chunk);
        if (prefixSize < prefixLimit) { const piece = chunk.subarray(0, prefixLimit - prefixSize); prefixes.push(Buffer.from(piece)); prefixSize += piece.length; }
        await visitor(chunk);
      }
      const final = await file.stat(); const named = await lstat(absolute); await safeDirectory(dirname(absolute));
      if (initial.size !== offset || initial.size !== final.size || initial.mtimeMs !== final.mtimeMs || initial.ctimeMs !== final.ctimeMs || initial.mode !== final.mode || named.ino !== initial.ino || named.dev !== initial.dev || named.size !== final.size || named.mtimeMs !== final.mtimeMs || named.ctimeMs !== final.ctimeMs || !named.isFile()) throw failure(2, 'STALE_SOURCE', 'source', 'Source changed while it was read.', 'Rerun after source edits finish.');
      inspectPrefix(path, Buffer.concat(prefixes));
      return { path, exists: true, executable: (initial.mode & 0o111) !== 0, byteLength: offset, sha256: hash.digest('hex') };
    } finally { await file.close(); }
  } catch (error) { if (hasCode(error, 'ENOENT')) return null; if (hasCode(error, 'ELOOP') || hasCode(error, 'ENOTDIR')) unsupported(`Source path ${JSON.stringify(path)} contains a symlink or file-to-directory transition.`); throw error; }
}
export async function readSourceFile(root: string, path: string, signal?: AbortSignal, limit = METADATA_LIMIT): Promise<{ bytes: Buffer; executable: boolean } | null> {
  const chunks: Buffer[] = [];
  const entry = await visitSourceFile(root, path, (chunk) => { chunks.push(Buffer.from(chunk)); }, signal, limit);
  return entry ? { bytes: Buffer.concat(chunks), executable: entry.executable } : null;
}
export async function diskFiles(root: string, pinnedCommit: string, signal?: AbortSignal, settings: SourceSettings = defaults, generatedDirs: readonly string[] = [], outputs?: OutputPaths): Promise<{ inventory: SourceInventory }> {
  const head = nulStrings(await gitBytes(root, ['ls-tree', '-rz', '--name-only', pinnedCommit], signal ? { signal } : {}));
  const tracked = nulStrings(await gitBytes(root, ['ls-files', '--cached', '-z'], signal ? { signal } : {}));
  const owned = outputs ?? await registeredOutputPaths(root, signal);
  const others = await untrackedSourcePaths(root, owned, signal);
  const paths = [...new Set([...head, ...tracked, ...others])].filter((path) => !excludedSource(path) && !generatedDirs.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))).sort(byteSort);
  if (paths.length > settings.maxFiles) sourceLimit(paths.length, 0, settings);
  const inventory: InventoryEntry[] = []; let bytes = 0;
  for (const path of paths) {
    const file = await visitSourceFile(root, path, () => {}, signal);
    if (!file) inventory.push({ path, exists: false });
    else { bytes += file.byteLength; if (bytes > settings.maxBytes) sourceLimit(inventory.length + 1, bytes, settings); inventory.push(file); }
  }
  validateInventory(inventory, settings); return { inventory };
}
function unsupported(message: string): never { throw failure(2, 'UNSUPPORTED_SOURCE_LAYOUT', 'source', message, 'Use a full checkout with regular source files, no Git filters, symlinks, submodules, or LFS pointers.'); }
export async function preflightGit(root: string, signal?: AbortSignal): Promise<void> {
  if ((await gitBytes(root, ['ls-files', '-u', '-z'], signal ? { signal } : {})).length) unsupported('Resolve all unmerged index entries first.');
  const sparse = utf8(await gitBytes(root, ['config', '--bool', '--get', 'core.sparseCheckout'], { allowFailure: true, ...(signal ? { signal } : {}) })).trim();
  if (sparse === 'true') unsupported('Sparse checkouts enabled by Git core.sparseCheckout are unsupported. Use a full checkout.');
  if ((await gitBytes(root, ['config', '--null', '--get-regexp', '^filter\.'], { allowFailure: true, ...(signal ? { signal } : {}) })).length) unsupported('Configured Git filter drivers in Git configuration are unsupported. Remove custom filter drivers.');
  const info = await gitText(root, ['rev-parse', '--git-path', 'info/attributes'], signal);
  const configured = utf8(await gitBytes(root, ['config', '--path', '--get', 'core.attributesFile'], { allowFailure: true, ...(signal ? { signal } : {}) })).trim();
  const external = [{ path: resolve(root, info), label: 'Git info/attributes' }, { path: configured ? resolve(root, configured) : join(process.env.HOME ?? '/', '.config/git/attributes'), label: configured ? `Git core.attributesFile ${JSON.stringify(basename(configured))}` : 'Git user .config/git/attributes' }];
  for (const { path, label } of external) {
    try {
      const file = await readSourceFile(dirname(path), basename(path), signal, METADATA_LIMIT);
      if (file && /(?:^|\s)(?:filter(?:=\S*)?|[!-]filter)(?:\s|$)/m.test(utf8(file.bytes))) unsupported(`External Git filter attributes in ${label} are unsupported.`);
    } catch (error) { if (!hasCode(error, 'ENOENT')) throw error; }
  }
}
export async function inspectSources(request: SourceRequest, signal?: AbortSignal): Promise<SourceInspection> {
  const repoRoot = await repositoryRoot(request.invocationDir, signal); const settings = SourceSettingsSchema.parse(request.source);
  const requestedBase = request.base ?? 'HEAD'; const requestedHead = request.head ?? 'WORKTREE';
  const headKind = requestedHead === 'WORKTREE' ? 'worktree' : 'commit';
  const headCommit = await resolveCommit(repoRoot, headKind === 'worktree' ? 'HEAD' : requestedHead, signal);
  let baseCommit = await resolveCommit(repoRoot, requestedBase, signal);
  if (request.mergeBase) { const bases = utf8(await gitBytes(repoRoot, ['merge-base', '--all', baseCommit, headCommit], { allowFailure: true, ...(signal ? { signal } : {}) })).trim().split('\n').filter(Boolean); if (bases.length !== 1 || !bases[0]) throw failure(2, 'AMBIGUOUS_MERGE_BASE', 'source', 'The selected refs do not have exactly one merge base.', 'Choose an explicit BEFORE commit.'); baseCommit = bases[0]; }
  await preflightGit(repoRoot, signal);
  const beforeFiles = await readTree(repoRoot, baseCommit, signal, settings);
  const before = await treeInventory(repoRoot, beforeFiles, signal, settings);
  const headFiles = headCommit === baseCommit ? beforeFiles : await readTree(repoRoot, headCommit, signal, settings);
  const headInventory = headCommit === baseCommit ? before : await treeInventory(repoRoot, headFiles, signal, settings);
  const disk = headKind === 'worktree' || settings.generatedDirs.length ? await diskFiles(repoRoot, headCommit, signal, settings) : null;
  const after = headKind === 'worktree' && disk ? disk.inventory : headInventory;
  validateGeneratedDirs(settings, [before, headInventory, ...(disk ? [disk.inventory] : [])]);
  if (headKind === 'worktree') validateOverlay(headInventory, after);
  let changedFiles = diffInventories(before, after);
  if (headKind === 'commit') {
    const parts = nulStrings(await gitBytes(repoRoot, ['diff', '--no-ext-diff', '--no-textconv', '--name-status', '-z', '--no-renames', baseCommit, headCommit, '--'], signal ? { signal } : {}));
    changedFiles = [];
    for (let index = 0; index < parts.length; index += 2) { const status = parts[index]; const path = parts[index + 1]; if (!path || !status || !(status === 'A' || status === 'D' || status === 'M' || status === 'T')) unsupported('Git returned an unsupported tree change.'); if (!excludedSource(path)) changedFiles.push({ status, oldPath: status === 'A' ? null : path, newPath: status === 'D' ? null : path }); }
    changedFiles.sort((a, b) => byteSort(a.newPath ?? a.oldPath ?? '', b.newPath ?? b.oldPath ?? ''));
  }
  return { repoRoot, requestedBase, requestedHead, baseCommit, headCommit, baseResolution: request.mergeBase ? 'merge-base' : 'exact', headKind, inventories: { before, after }, sourceFingerprint: headKind === 'worktree' ? fingerprintInventory(after) : null, changedFiles, stats: { before: sourceStats(before), after: sourceStats(after) }, warnings: [] };
}
