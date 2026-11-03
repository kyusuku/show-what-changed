import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const reportName = 'package-source-binding.json';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const identity = (bytes) => ({ sha256: hash(bytes), bytes: bytes.length });
class PackageSourceError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const failure = (code, message) => new PackageSourceError(code, message);

async function canonicalPath(path) {
  path = resolve(path);
  try { return await realpath(path); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return join(await canonicalPath(dirname(path)), basename(path));
  }
}

function contains(root, target) {
  const path = relative(root, target);
  return path === '' || path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path);
}

async function npm(args, cwd, ownedRoot) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:GIT_|NPM_CONFIG_|NODE_OPTIONS$)/i.test(key)));
  try {
    return (await execute('npm', [
      ...args, '--cache', join(ownedRoot, 'cache'),
      '--userconfig', join(ownedRoot, 'user.npmrc'), '--globalconfig', join(ownedRoot, 'global.npmrc'),
      '--offline', '--no-audit', '--no-fund', '--no-update-notifier', '--loglevel=error',
    ], { cwd, env, encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024, killSignal: 'SIGKILL' })).stdout;
  } catch {
    throw failure('NPM_COMMAND_FAILED', 'The bounded offline npm command failed.');
  }
}

export async function verifyPackageSource(candidate, sourceRoot, outputDir) {
  sourceRoot = await realpath(sourceRoot);
  outputDir = await canonicalPath(outputDir);
  if (contains(sourceRoot, outputDir)) throw failure('INVALID_OUTPUT_DIRECTORY', 'The report directory must be outside the source tree.');
  if (await canonicalPath(candidate) === join(outputDir, reportName)) throw failure('INVALID_OUTPUT_DIRECTORY', 'The report must not overwrite the supplied candidate.');
  await mkdir(outputDir, { recursive: true });
  const ownedRoot = await mkdtemp(join(outputDir, '.swc-package-source-'));
  const report = {
    schemaVersion: 1, status: 'failed', comparison: 'exact-tarball-bytes',
    sourcePackage: null, toolchain: { node: process.version, npm: null, requiredNode: '24.x', requiredNpm: '11.12.1' },
    candidate: null, rebuilt: null, archivePrivacy: 'not-evaluated',
  };
  let error;
  try {
    if (!/^v24\./.test(process.version)) throw failure('UNSUPPORTED_NODE_VERSION', 'Package source binding requires Node 24.');
    let metadata;
    try { metadata = JSON.parse(await readFile(join(sourceRoot, 'package.json'), 'utf8')); }
    catch { throw failure('INVALID_SOURCE_PACKAGE', 'The source package metadata could not be read.'); }
    if (typeof metadata.name !== 'string' || typeof metadata.version !== 'string') throw failure('INVALID_SOURCE_PACKAGE', 'The source package requires a name and version.');
    report.sourcePackage = { name: metadata.name, version: metadata.version };
    let supplied;
    try {
      if (!(await lstat(candidate)).isFile()) throw new Error();
      supplied = await readFile(candidate);
    } catch { throw failure('INVALID_CANDIDATE', 'The supplied candidate must be a readable regular file.'); }
    report.candidate = identity(supplied);
    await writeFile(join(ownedRoot, 'user.npmrc'), '', { mode: 0o600 });
    await writeFile(join(ownedRoot, 'global.npmrc'), '', { mode: 0o600 });
    report.toolchain.npm = (await npm(['--version'], ownedRoot, ownedRoot)).trim();
    if (report.toolchain.npm !== '11.12.1') throw failure('UNSUPPORTED_NPM_VERSION', 'Package source binding requires npm 11.12.1.');
    const destination = join(ownedRoot, 'pack');
    await mkdir(destination);
    const output = await npm(['pack', '--ignore-scripts', '--json', '--workspaces=false', '--dry-run=false', '--pack-destination', destination], sourceRoot, ownedRoot);
    let packs;
    try { packs = JSON.parse(output); }
    catch { throw failure('INVALID_PACK_RESULT', 'npm did not return a valid package result.'); }
    if (!Array.isArray(packs) || packs.length !== 1 || typeof packs[0]?.filename !== 'string' || basename(packs[0].filename) !== packs[0].filename || !packs[0].filename.endsWith('.tgz')) {
      throw failure('INVALID_PACK_RESULT', 'npm must produce exactly one local package archive.');
    }
    const rebuiltPath = join(destination, packs[0].filename);
    if (!(await lstat(rebuiltPath)).isFile()) throw failure('INVALID_PACK_RESULT', 'The rebuilt package must be a regular file.');
    const rebuilt = await readFile(rebuiltPath);
    report.rebuilt = identity(rebuilt);
    if (report.candidate.sha256 !== report.rebuilt.sha256 || !supplied.equals(rebuilt)) throw failure('PACKAGE_SOURCE_MISMATCH', 'The supplied candidate differs from the freshly packed source.');
    report.status = 'passed';
  } catch (caught) {
    error = caught instanceof PackageSourceError ? caught : failure('PACKAGE_SOURCE_CHECK_FAILED', 'Package source binding could not be completed.');
    report.failure = { code: error.code, message: error.message };
    error.report = report;
  }
  try {
    const staged = join(ownedRoot, reportName);
    await writeFile(staged, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    await rename(staged, join(outputDir, reportName));
  } finally {
    await rm(ownedRoot, { recursive: true, force: true });
  }
  if (error) throw error;
  return report;
}

if (process.argv[1] && await realpath(process.argv[1]).catch(() => undefined) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4) {
    process.stderr.write('Usage: node scripts/verify-package-source.mjs candidate.tgz output-directory\n');
    process.exitCode = 2;
  } else {
    try {
      const report = await verifyPackageSource(process.argv[2], resolve(fileURLToPath(new URL('..', import.meta.url))), process.argv[3]);
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    } catch (error) {
      process.stderr.write(JSON.stringify(error.report ?? { status: 'failed', code: error.code ?? 'PACKAGE_SOURCE_CHECK_FAILED', message: 'Package source binding failed.' }, null, 2) + '\n');
      process.exitCode = 1;
    }
  }
}
