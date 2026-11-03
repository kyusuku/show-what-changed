import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdtemp, mkdir, readFile, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';
import { verifyPackageSource } from '../../scripts/verify-package-source.mjs';

const execute = promisify(execFile);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function snapshot(root, prefix = '') {
  const entries = [];
  for (const name of (await readdir(root)).sort()) {
    const path = join(root, name);
    const info = await lstat(path);
    const entry = { path: prefix + name, mode: info.mode & 0o777 };
    if (info.isSymbolicLink()) entries.push({ ...entry, kind: 'link', target: await readlink(path) });
    else if (info.isDirectory()) entries.push({ ...entry, kind: 'directory' }, ...await snapshot(path, prefix + name + '/'));
    else entries.push({ ...entry, kind: 'file', sha256: hash(await readFile(path)) });
  }
  return entries;
}

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'swc-package-binding-test-'));
  const source = join(root, 'source');
  const output = join(root, 'reports');
  try {
    await mkdir(join(source, 'dist'), { recursive: true });
    await mkdir(join(source, 'schema'));
    await mkdir(join(source, 'node_modules'));
    await mkdir(output);
    await writeFile(join(source, 'package.json'), JSON.stringify({
      name: 'synthetic-source-binding', version: '1.2.3', files: ['dist', 'schema'],
      bin: { synthetic: 'dist/index.js' },
      scripts: { prepack: 'node -e "process.exit(97)"', prepare: 'node -e "process.exit(98)"' },
    }) + '\n');
    await writeFile(join(source, 'dist/index.js'), '#!/usr/bin/env node\nconsole.log("original");\n');
    await chmod(join(source, 'dist/index.js'), 0o755);
    await writeFile(join(source, 'schema/contract.json'), '{"type":"object"}\n');
    await writeFile(join(source, 'node_modules/sentinel'), 'Caller dependency state.\n');
    await symlink('sentinel', join(source, 'node_modules/local-link'));
    await writeFile(join(output, 'unrelated.txt'), 'Keep this caller report.\n');
    await writeFile(join(root, 'user.npmrc'), '');
    await writeFile(join(root, 'global.npmrc'), '');
    const pack = async (name) => {
      const destination = join(root, name);
      await mkdir(destination);
      const { stdout } = await execute('npm', [
        'pack', '--ignore-scripts', '--json', '--workspaces=false', '--dry-run=false',
        '--pack-destination', destination, '--cache', join(root, 'cache'),
        '--userconfig', join(root, 'user.npmrc'), '--globalconfig', join(root, 'global.npmrc'),
        '--offline', '--no-audit', '--no-fund', '--no-update-notifier',
      ], { cwd: source, timeout: 30_000, maxBuffer: 1024 * 1024, encoding: 'utf8' });
      return join(destination, JSON.parse(stdout)[0].filename);
    };
    await run({ root, source, output, pack });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('identical independent packs bind to source and preserve caller files, modes, and links', async () => {
  await fixture(async ({ source, output, pack }) => {
    const before = await snapshot(source);
    const first = await pack('first');
    const second = await pack('second');
    const candidate = await readFile(first);
    expect(await readFile(second)).toEqual(candidate);
    const hostile = { GIT_DIR: join(source, 'node_modules'), GIT_WORK_TREE: source, NPM_CONFIG_DRY_RUN: 'true', NPM_CONFIG_CACHE: join(source, 'unwanted-cache') };
    const original = Object.fromEntries(Object.keys(hostile).map((key) => [key, process.env[key]]));
    let report;
    try {
      Object.assign(process.env, hostile);
      report = await verifyPackageSource(first, source, output);
      for (const [key, value] of Object.entries(hostile)) expect(process.env[key]).toBe(value);
    } finally {
      for (const [key, value] of Object.entries(original)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
    expect(report).toMatchObject({
      status: 'passed', comparison: 'exact-tarball-bytes',
      sourcePackage: { name: 'synthetic-source-binding', version: '1.2.3' },
      toolchain: { node: process.version, npm: '11.12.1' },
      candidate: { sha256: hash(candidate), bytes: candidate.length },
      rebuilt: { sha256: hash(candidate), bytes: candidate.length },
      archivePrivacy: 'not-evaluated',
    });
    expect(await verifyPackageSource(second, source, output)).toEqual(report);
    expect(JSON.parse(await readFile(join(output, 'package-source-binding.json'), 'utf8'))).toEqual(report);
    expect(await snapshot(source)).toEqual(before);
    expect(await readFile(first)).toEqual(candidate);
    expect(await readFile(join(output, 'unrelated.txt'), 'utf8')).toBe('Keep this caller report.\n');
    expect((await readdir(output)).sort()).toEqual(['package-source-binding.json', 'unrelated.txt']);
    expect(JSON.stringify(report)).not.toContain(source);
  });
}, 30_000);

test('changed executable payload fails even when generated schemas are identical', async () => {
  await fixture(async ({ source, output, pack }) => {
    const candidate = await pack('candidate');
    const schema = await readFile(join(source, 'schema/contract.json'));
    await writeFile(join(source, 'dist/index.js'), '#!/usr/bin/env node\nconsole.log("changed");\n');
    const before = await snapshot(source);
    await expect(verifyPackageSource(candidate, source, output)).rejects.toMatchObject({ code: 'PACKAGE_SOURCE_MISMATCH' });
    const report = JSON.parse(await readFile(join(output, 'package-source-binding.json'), 'utf8'));
    expect(report.status).toBe('failed');
    expect(report.candidate.sha256).not.toBe(report.rebuilt.sha256);
    expect(await readFile(join(source, 'schema/contract.json'))).toEqual(schema);
    expect(await snapshot(source)).toEqual(before);
    expect((await readdir(output)).sort()).toEqual(['package-source-binding.json', 'unrelated.txt']);
  });
}, 30_000);

test('report paths cannot write inside source or replace the supplied candidate', async () => {
  await fixture(async ({ root, source, output, pack }) => {
    const candidate = await pack('candidate');
    const before = await snapshot(source);
    await expect(verifyPackageSource(candidate, source, join(source, 'reports'))).rejects.toMatchObject({ code: 'INVALID_OUTPUT_DIRECTORY' });
    await symlink(source, join(root, 'source-link'));
    await expect(verifyPackageSource(candidate, source, join(root, 'source-link/reports'))).rejects.toMatchObject({ code: 'INVALID_OUTPUT_DIRECTORY' });
    const collision = join(output, 'package-source-binding.json');
    await writeFile(collision, 'Do not replace this candidate.\n');
    await expect(verifyPackageSource(collision, source, output)).rejects.toMatchObject({ code: 'INVALID_OUTPUT_DIRECTORY' });
    expect(await readFile(collision, 'utf8')).toBe('Do not replace this candidate.\n');
    expect(await snapshot(source)).toEqual(before);
  });
}, 30_000);

test('missing, directory, and corrupt candidates fail clearly without deleting caller input', async () => {
  await fixture(async ({ root, source, output }) => {
    for (const candidate of [join(root, 'missing.tgz'), source]) {
      await expect(verifyPackageSource(candidate, source, output)).rejects.toMatchObject({ code: 'INVALID_CANDIDATE' });
    }
    const corrupt = join(root, 'corrupt.tgz');
    await writeFile(corrupt, 'This is not a package archive.\n');
    await expect(verifyPackageSource(corrupt, source, output)).rejects.toMatchObject({ code: 'PACKAGE_SOURCE_MISMATCH' });
    expect(await readFile(corrupt, 'utf8')).toBe('This is not a package archive.\n');
    expect((await readdir(output)).sort()).toEqual(['package-source-binding.json', 'unrelated.txt']);
  });
}, 30_000);

test('the guarded CLI uses the script parent as source and requires both arguments', async () => {
  await fixture(async ({ source, output, pack }) => {
    const script = join(source, 'scripts/verify-package-source.mjs');
    await mkdir(join(source, 'scripts'));
    await writeFile(script, await readFile(new URL('../../scripts/verify-package-source.mjs', import.meta.url)));
    const candidate = await pack('candidate');
    const before = await snapshot(source);
    const result = await execute(process.execPath, [script, candidate, output], { encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 });
    expect(JSON.parse(result.stdout).status).toBe('passed');
    await expect(execute(process.execPath, [script], { encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 })).rejects.toMatchObject({ code: 2, stderr: expect.stringContaining('Usage:') });
    expect(await snapshot(source)).toEqual(before);
  });
}, 30_000);
