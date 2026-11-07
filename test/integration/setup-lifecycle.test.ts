import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, expect, test } from 'vitest';
import { z } from 'zod';
import { ResultSchema } from '../../src/schema/index.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const exists = async (path: string): Promise<boolean> => access(path).then(() => true, () => false);
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const ready = { schemaVersion: 2, command: 'doctor', status: 'ok', exitCode: 0, data: { schemaVersion: 2, platform: 'fixture', capabilities: [{ name: 'chromium', available: true, version: 'fixture', message: 'Controlled cached browser.', setupCommand: null }], abandonedRuns: [] }, error: null, warnings: [] };

async function probe(mode: 'completed' | 'failed' | 'timeout' | 'SIGINT' | 'SIGTERM', args = ['setup', '--json']) {
  const root = await mkdtemp(join(tmpdir(), 'swc-setup-lifecycle-'));
  roots.push(root);
  const tools = join(root, 'tools');
  await mkdir(tools);
  await symlink('/bin/ps', join(tools, 'ps'));
  const fixture = join(root, 'installer.cjs');
  const marker = join(root, 'owned.json');
  const doctorMarker = join(root, 'doctor-called');
  const snapshot = join(root, 'diagnostics.json');
  await writeFile(fixture, `
const {spawn}=require('node:child_process');
const {writeFileSync}=require('node:fs');
process.stdout.write('\\u001b[31mhttps://user:fixture-password@invalid.example/download?token=fixture-token\\u001b[0m\\n');
process.stderr.write('secret=fixture-secret\\n');
if (${JSON.stringify(mode)} === 'completed' || ${JSON.stringify(mode)} === 'failed') process.exit(${mode === 'failed' ? 1 : 0});
process.on('SIGTERM',()=>{});
const descendant=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});
writeFileSync(${JSON.stringify(marker)},JSON.stringify({parent:process.pid,descendant:descendant.pid}));
setInterval(()=>{},1000);
`);
  const loader = join(root, 'loader.mjs');
  await writeFile(loader, `
import {registerHooks} from 'node:module';
registerHooks({
  resolve(specifier,context,next){if(context.parentURL?.includes('/src/')&&specifier.startsWith('.')&&specifier.endsWith('.js'))return next(specifier.replace(/\\.js$/,'.ts'),context);return next(specifier,context)},
  load(url,context,next){
    if(url.endsWith('/src/runner/doctor.ts'))return {format:'module',shortCircuit:true,source:${JSON.stringify(`import {writeFile} from 'node:fs/promises';export async function doctor(){await writeFile(${JSON.stringify(doctorMarker)},'called');return ${JSON.stringify(ready)}}`)}};
    const result=next(url,context);let source=String(result.source);
    if(url.endsWith('/src/runtime/supervisor.ts'))source=source.replace('async spawn(spec) {',${JSON.stringify(`async spawn(spec) { if (spec.purpose === 'setup') spec = { ...spec, argv: [process.execPath, ${JSON.stringify(fixture)}] };`)});
    if(url.endsWith('/src/cli/index.ts'))source=source.replace(': 600000,',': ${mode === 'timeout' ? 1000 : 15000},');
    if(url.endsWith('/src/runner/setup.ts'))source=source.replace('if (removePrivateDir) {',${JSON.stringify(`if (removePrivateDir) { const fs = await import('node:fs/promises'); const names = await fs.readdir(privateDir); const logs = await Promise.all(names.filter(name=>name.endsWith('.log')).map(name=>fs.readFile(join(privateDir,name),'utf8'))); await fs.writeFile(${JSON.stringify(snapshot)}, JSON.stringify(logs));`)});
    return {...result,source};
  }
});
await import(${JSON.stringify(new URL('../../src/cli/index.ts', import.meta.url).href)});
`);
  const sentinel = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  const child = spawn(process.execPath, ['--no-warnings', '--experimental-transform-types', loader, ...args], { cwd: root, env: { ...process.env, PATH: tools }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', (bytes: Buffer) => { stdout += bytes; });
  child.stderr.on('data', (bytes: Buffer) => { stderr += bytes; });
  const finished = new Promise<number | null>((resolve) => child.once('close', resolve));
  const deadline = setTimeout(() => child.kill('SIGKILL'), 20000);
  try {
    if (mode === 'SIGINT' || mode === 'SIGTERM') {
      const until = Date.now() + 10000;
      while (!await exists(marker) && child.exitCode === null && Date.now() < until) await delay(10);
      expect(await exists(marker), stdout + stderr).toBe(true);
      child.kill(mode);
    }
    const code = await finished;
    expect(stdout.trim().split('\n'), stderr).toHaveLength(1);
    expect(stdout + stderr).not.toMatch(/fixture-password|fixture-token|fixture-secret|\u001b/);
    expect(sentinel.pid && alive(sentinel.pid)).toBe(true);
    if (await exists(marker)) {
      const owned = z.object({ parent: z.number().int(), descendant: z.number().int() }).parse(JSON.parse(await readFile(marker, 'utf8')));
      for (const pid of [owned.parent, owned.descendant]) {
        const until = Date.now() + 2000;
        while (alive(pid) && Date.now() < until) await delay(20);
        expect(alive(pid), `Owned PID ${pid} survived.`).toBe(false);
      }
    }
    if (await exists(snapshot)) {
      const logs = z.array(z.string()).parse(JSON.parse(await readFile(snapshot, 'utf8')));
      expect(logs).toEqual(['[Browser installer output omitted.]\n']);
    }
    return { code, result: ResultSchema.parse(JSON.parse(stdout)), doctorCalled: await exists(doctorMarker) };
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    sentinel.kill('SIGKILL');
    await finished;
  }
}

test.each(['completed', 'failed'] as const)('runs the final doctor after a real %s installer with lsof absent', async (mode) => {
  const observed = await probe(mode);
  expect(observed.code).toBe(mode === 'completed' ? 0 : 8);
  expect(observed.result).toMatchObject({ command: 'setup', status: mode === 'completed' ? 'ok' : 'failed', data: ready.data });
  expect(observed.doctorCalled).toBe(true);
}, 25000);

test.each([{ mode: 'timeout', code: 10 }, { mode: 'SIGINT', code: 130 }, { mode: 'SIGTERM', code: 143 }] as const)('stops owned installer descendants on $mode and preserves unrelated processes', async ({ mode, code }) => {
  const observed = await probe(mode);
  expect(observed.code).toBe(code);
  expect(observed.result).toMatchObject({ command: 'setup', status: 'cancelled', exitCode: code });
  expect(observed.doctorCalled).toBe(false);
}, 25000);

test.each([['setup', '--unknown', '--json'], ['--json', 'setup', 'extra'], ['setup', '--allow-exec', '--json']].map((args) => ({ args })))('attributes strict argv failure $args to setup in one JSON record', async ({ args }) => {
  const observed = await probe('completed', args);
  expect(observed.result).toMatchObject({ command: 'setup', status: 'failed', exitCode: 2, data: null });
  expect(observed.doctorCalled).toBe(false);
});
