import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { ManifestSchema, ResultSchema } from '../../src/schema/index.js';
import { sha256 } from '../../src/schema/io.js';
import { groupMembers } from '../../src/runtime/process-table.js';

const execute = promisify(execFile);
const sourceCli = new URL('../../src/cli/index.ts', import.meta.url).href;
const loader = "import {registerHooks} from 'node:module';registerHooks({resolve(specifier,context,next){if(context.parentURL?.includes('/src/')&&specifier.startsWith('.')&&specifier.endsWith('.js'))return next(specifier.replace(/\\.js$/,'.ts'),context);return next(specifier,context)}});await import(process.argv[1]);";

test('T03 T04 adds a visible provenance caveat when the app creates a new source file during capture', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'swc-capture-provenance-')));
  const app = join(root, 'app');
  await mkdir(app);
  const git = async (...args: string[]) => (await execute('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args], { cwd: app, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } })).stdout.trim();
  try {
    const pkg = { name: 'capture-provenance-fixture', version: '1.0.0', private: true };
    await writeFile(join(app, 'package.json'), JSON.stringify(pkg));
    await writeFile(join(app, 'package-lock.json'), JSON.stringify({ ...pkg, lockfileVersion: 3, packages: { '': pkg } }));
    await writeFile(join(app, '.gitignore'), 'node_modules/\n.show-what-changed/\n');
    const html = '<h1>Provenance fixture</h1><button onclick="fetch(\'/mutate\').then(()=>document.getElementById(\'ready\').textContent=\'Mutation complete\')">Create source</button><p id="ready">Ready</p>';
    const server = `import http from 'node:http';import fs from 'node:fs';http.createServer((request,response)=>{if(request.url==='/mutate'){if(process.env.SWC_SIDE==='after')fs.writeFileSync('new-app-source.txt','Created during capture');response.end('ok');return;}response.setHeader('content-type','text/html');response.end(request.url==='/health'?'healthy':${JSON.stringify(html)});}).listen(Number(process.argv[2]),'127.0.0.1');`;
    await writeFile(join(app, 'server.mjs'), server);
    await writeFile(join(app, 'show-what-changed.config.json'), JSON.stringify({ schemaVersion: 2, execution: { start: { kind: 'process', argv: [process.execPath, 'server.mjs', '{port}'] }, ready: { path: '/health' }, state: { kind: 'stateless' } }, capture: { mode: 'keyframes', observeMs: 200 } }));
    await git('init', '-q'); await git('config', 'user.name', 'Provenance Fixture'); await git('config', 'user.email', 'fixture@example.invalid');
    await git('add', '.'); await git('commit', '-qm', 'Synthetic provenance fixture');
    const scenario = join(root, 'scenario.json');
    await writeFile(scenario, JSON.stringify({ schemaVersion: 2, id: 'source-mutation', title: 'New source file during capture', steps: [
      { id: 'open', op: 'goto', path: '/' }, { id: 'mutate', op: 'click', target: { role: 'button', name: 'Create source' } },
      { id: 'ready', op: 'expectVisible', target: { text: 'Mutation complete' } }, { id: 'poster', op: 'screenshot' },
    ] }));
    const original = { head: await git('rev-parse', 'HEAD'), index: await readFile(join(app, '.git/index')), server: await readFile(join(app, 'server.mjs')) };
    const result = await execute(process.execPath, ['--no-warnings', '--experimental-transform-types', '--input-type=module', '-e', loader, sourceCli, 'compare', '--head', 'HEAD', '--scenario', scenario, '--allow-exec', '--json'], { cwd: app, maxBuffer: 10 * 1024 * 1024, timeout: 45_000 }).then(() => { throw new Error('Mutation comparison incorrectly succeeded'); }, (error: { code: number; stdout: string; stderr: string }) => error);
    expect(result.code).toBe(3);
    expect(result.stdout.trim().split('\n')).toHaveLength(1);
    const envelope = ResultSchema.parse(JSON.parse(result.stdout));
    const manifest = ManifestSchema.parse(envelope.data);
    expect(manifest.summary.verifiedPairs).toBe(4);
    expect(manifest.comparisonOutcome).toMatchObject({ status: 'partial', capture: 'ok', provenance: { before: { valid: true }, after: { valid: false, errors: [{ code: 'SOURCE_MUTATED' }] } } });
    expect(manifest.encodingOutcome.status).toBe('ok');
    expect(manifest.cleanupOutcome.status).toBe('ok');
    const runDir = join(app, '.show-what-changed/runs', manifest.runId);
    expect(JSON.parse(await readFile(join(runDir, 'manifest.json'), 'utf8'))).toEqual(manifest);
    for (const artifact of Object.values(manifest.artifacts)) if (artifact) {
      const bytes = await readFile(join(runDir, artifact.path));
      expect(bytes.length).toBe(artifact.bytes); expect(sha256(bytes)).toBe(artifact.sha256);
    }
    const owned: { group: number }[] = JSON.parse(await readFile(join(runDir, 'private/processes.json'), 'utf8'));
    for (const process of owned) expect(await groupMembers(process.group)).toEqual([]);
    await expect(access(join(app, 'new-app-source.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await git('rev-parse', 'HEAD')).toBe(original.head);
    expect(await readFile(join(app, '.git/index'))).toEqual(original.index);
    expect(await readFile(join(app, 'server.mjs'))).toEqual(original.server);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 60_000);
