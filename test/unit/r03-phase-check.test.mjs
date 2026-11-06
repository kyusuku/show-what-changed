import { chmod, copyFile, mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { PNG } from 'pngjs';
import { expect, test, vi } from 'vitest';
import { assertPhaseResult, assertWitnessInactive, inspectRetainedImages, inspectRetainedMedia, interruptPhaseCommand, phaseCases, phaseSelection, preparePhaseFixture, runPhaseCase, verifyPersistedMasks, witnessPhaseProcess } from '../../scripts/r03-phase-check.mjs';
import { command, hash, sourceState } from '../../scripts/release-harness.mjs';
import { ConfigSchema, ScenarioSchema } from '../../src/schema/index.js';

async function temporary(run) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'swc-phase-check-test-')));
  try { await run(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test('requires explicit installed input and selects only named missing phase cells', () => {
  expect(phaseCases.map(({ id }) => id)).toEqual(['setup-deadline', 'startup-deadline', 'recording-sigint', 'recording-sigterm', 'recording-deadline', 'encoding-deadline', 'setup-sigint', 'setup-sigterm', 'startup-sigint', 'startup-sigterm', 'encoding-sigint', 'encoding-sigterm']);
  const selected = phaseSelection(['--installed-root', '/installed', '--output-dir', '/evidence', '--case', 'setup-deadline']);
  expect(selected.cases.map(({ id }) => id)).toEqual(['setup-deadline']);
  expect(phaseSelection(['--tarball', '/candidate.tgz', '--output-dir', '/evidence', '--case', 'recording-sigint', '--case', 'recording-sigterm']).cases).toHaveLength(2);
  for (const args of [[], ['--installed-root', '/installed', '--output-dir', '/evidence'], ['--installed-root', '/installed', '--tarball', '/candidate.tgz', '--output-dir', '/evidence', '--case', 'setup-deadline'], ['--installed-root', '/installed', '--output-dir', '/evidence', '--case', 'unknown'], ['--installed-root', '/installed', '--output-dir', '/evidence', '--case', 'setup-deadline', '--case', 'setup-deadline']]) expect(() => phaseSelection(args)).toThrow();
});

test('every host phase offers both signals and its original overall deadline', () => {
  const deadlines = new Map([['setup', 8], ['startup', 8], ['recording', 20], ['encoding', 60]]);
  expect(new Set(phaseCases.map(({ id }) => id)).size).toBe(12);
  for (const [phase, runSeconds] of deadlines) {
    const entries = phaseCases.filter((entry) => entry.phase === phase);
    expect(entries.map(({ stimulus }) => stimulus).sort()).toEqual(['SIGINT', 'SIGTERM', 'deadline']);
    expect(entries.find(({ stimulus }) => stimulus === 'deadline')).toMatchObject({ runSeconds, exitCode: 10, errorCode: 'DEADLINE_EXCEEDED' });
    for (const entry of entries.filter(({ stimulus }) => stimulus !== 'deadline')) expect(entry).toMatchObject({ runSeconds: 60, exitCode: entry.stimulus === 'SIGINT' ? 130 : 143, errorCode: entry.stimulus });
  }
});

test.each([
  ['setup-sigint', 'setup', 'SIGINT', 130],
  ['setup-sigterm', 'setup', 'SIGTERM', 143],
  ['startup-sigint', 'startup', 'SIGINT', 130],
  ['startup-sigterm', 'startup', 'SIGTERM', 143],
  ['encoding-sigint', 'encoding', 'SIGINT', 130],
  ['encoding-sigterm', 'encoding', 'SIGTERM', 143],
])('dispatches selected %s after its controlled phase and validates its observed result', async (id, phase, signal, exitCode) => {
  await temporary(async (root) => {
    const [entry] = phaseSelection(['--installed-root', '/installed', '--output-dir', '/evidence', '--case', id]).cases;
    expect(entry).toMatchObject({ phase, stimulus: signal, exitCode, errorCode: signal, runSeconds: 60 });
    const marker = join(root, 'active.json'), script = join(root, 'selected-child.mjs');
    await writeFile(script, `import {writeFileSync} from 'node:fs';process.on(${JSON.stringify(signal)},()=>{const data={state:'terminal',status:'cancelled',exitCode:${exitCode}};process.stdout.write(JSON.stringify({status:'cancelled',exitCode:${exitCode},error:{code:${JSON.stringify(signal)}},data})+'\\n',()=>process.exit(${exitCode}))});writeFileSync(${JSON.stringify(marker)},JSON.stringify({phase:${JSON.stringify(phase)}}));setInterval(()=>{},1000);`);
    const probe = await interruptPhaseCommand({ argv: [process.execPath, script], cwd: root, entry, phaseWaitMs: 1000, observe: async () => await readFile(marker, 'utf8').then(JSON.parse, () => null) });
    expect(probe).toMatchObject({ code: exitCode, signal: null, phaseReached: true, marker: { phase }, signalSent: signal, timedOut: false, events: [] });
    const envelope = JSON.parse(probe.stdout);
    expect(() => assertPhaseResult(entry, probe, envelope)).not.toThrow();
    expect(() => assertPhaseResult(entry, { ...probe, signalSent: signal === 'SIGINT' ? 'SIGTERM' : 'SIGINT' }, envelope)).toThrow('Wrong external stimulus');
  });
});

test('an expected exit cannot conceal a phase that was never reached or a harness kill', () => {
  const entry = { phase: 'setup', stimulus: 'deadline', runSeconds: 1, exitCode: 10, errorCode: 'DEADLINE_EXCEEDED' };
  const probe = { code: 10, signal: null, phaseReached: true, marker: { elapsedMs: 500 }, signalSent: null, timedOut: false, overflow: false, exit: { observedElapsedMs: 1000 }, elapsedMs: 1000 };
  const envelope = { status: 'cancelled', exitCode: 10, error: { code: 'DEADLINE_EXCEEDED' }, data: { state: 'terminal', status: 'cancelled', exitCode: 10 } };
  expect(() => assertPhaseResult(entry, probe, envelope)).not.toThrow();
  expect(() => assertPhaseResult(entry, { ...probe, phaseReached: false }, envelope)).toThrow('PHASE_NOT_REACHED');
  expect(() => assertPhaseResult(entry, { ...probe, timedOut: true }, envelope)).toThrow('HARNESS_TIMEOUT');
  for (const observedElapsedMs of [undefined, null, -1, NaN, Infinity, 120, 999]) expect(() => assertPhaseResult(entry, { ...probe, exit: { observedElapsedMs } }, envelope)).toThrow('DEADLINE_TOO_EARLY');
  expect(() => assertPhaseResult(entry, { ...probe, exit: null }, envelope)).toThrow('DEADLINE_TOO_EARLY');
  expect(() => assertPhaseResult(entry, probe, { ...envelope, exitCode: 6 })).toThrow();
  expect(() => assertPhaseResult(entry, probe, { ...envelope, data: null })).toThrow();
});

test.each([
  ['deadline', 120_000, 10, 'DEADLINE_EXCEEDED'],
  ['SIGINT', 45_000, 130, 'SIGINT'],
  ['SIGTERM', 45_000, 143, 'SIGTERM'],
])('%s requires the completed phase witness strictly before its original reach limit', (stimulus, limit, exitCode, errorCode) => {
  const entry = { stimulus, runSeconds: 120, exitCode, errorCode };
  const probe = { code: exitCode, signal: null, phaseReached: true, marker: { elapsedMs: limit - 1 }, signalSent: stimulus === 'deadline' ? null : stimulus, timedOut: false, overflow: false, exit: { observedElapsedMs: 120_100 }, elapsedMs: 120_100 };
  const envelope = { status: 'cancelled', exitCode, error: { code: errorCode }, data: { state: 'terminal', status: 'cancelled', exitCode } };
  expect(() => assertPhaseResult(entry, probe, envelope)).not.toThrow();
  for (const elapsedMs of [undefined, null, -1, NaN, Infinity, limit, limit + 1]) expect(() => assertPhaseResult(entry, { ...probe, marker: { elapsedMs } }, envelope)).toThrow('PHASE_NOT_REACHED_IN_TIME');
  expect(() => assertPhaseResult(entry, { ...probe, marker: null }, envelope)).toThrow('PHASE_NOT_REACHED_IN_TIME');
});

test.each(['deadline', 'SIGINT'])('a %s observation that completes outside the reach window is retained without accepting or signalling it', async (stimulus) => {
  await temporary(async (root) => {
    const probe = await interruptPhaseCommand({ argv: [process.execPath, '-e', 'setTimeout(()=>process.exit(10),250)'], cwd: root, entry: { stimulus, runSeconds: stimulus === 'deadline' ? 0.08 : 2 }, phaseWaitMs: stimulus === 'deadline' ? 1000 : 40, observe: async () => { await new Promise((done) => setTimeout(done, 120)); return { phase: 'controlled-late' }; } });
    expect(probe).toMatchObject({ phaseReached: false, marker: { phase: 'controlled-late' }, signalSent: null });
    expect(probe.marker.elapsedMs).toBeGreaterThanOrEqual(stimulus === 'deadline' ? 80 : 40);
    if (stimulus === 'SIGINT') expect(probe.events).toContainEqual(expect.objectContaining({ signal: 'SIGTERM', kind: 'harness-stop' }));
  });
});

test('a real deadline result preserves an early phase witness and the expected output', async () => {
  await temporary(async (root) => {
    const marker = join(root, 'active');
    const entry = { stimulus: 'deadline', runSeconds: 0.2, exitCode: 10, errorCode: 'DEADLINE_EXCEEDED' };
    const envelope = { status: 'cancelled', exitCode: 10, error: { code: entry.errorCode }, data: { state: 'terminal', status: 'cancelled', exitCode: 10 } };
    const script = `require('node:fs').writeFileSync(${JSON.stringify(marker)},'active');setTimeout(()=>process.stdout.write(${JSON.stringify(JSON.stringify(envelope) + '\n')},()=>process.exit(10)),300)`;
    const probe = await interruptPhaseCommand({ argv: [process.execPath, '-e', script], cwd: root, entry, observe: async () => await readFile(marker, 'utf8').then(() => ({ phase: 'controlled' }), () => null) });
    expect(probe).toMatchObject({ code: 10, signal: null, phaseReached: true, signalSent: null, timedOut: false, overflow: false, events: [], transportError: null, exit: { code: 10, signal: null }, close: { code: 10, signal: null }, stdout: JSON.stringify(envelope) + '\n', stderr: '' });
    expect(() => assertPhaseResult(entry, probe, envelope)).not.toThrow();
    expect(() => assertPhaseResult(entry, { ...probe, transportError: 'PIPE_CLOSE_TIMEOUT' }, envelope)).toThrow('CLI_TRANSPORT_FAILED');
  });
});

test('normal stdout, stderr and exit evidence remain intact', async () => {
  await temporary(async (root) => {
    const probe = await interruptPhaseCommand({ argv: [process.execPath, '-e', "process.stdout.write('controlled output\\n');process.stderr.write('controlled diagnostic\\n');process.exitCode=7"], cwd: root, entry: { stimulus: 'SIGINT', runSeconds: 1 }, observe: async () => null });
    expect(probe).toMatchObject({ code: 7, signal: null, phaseReached: false, signalSent: null, timedOut: false, overflow: false, events: [], transportError: null, exit: { code: 7, signal: null }, close: { code: 7, signal: null }, stdout: 'controlled output\n', stderr: 'controlled diagnostic\n' });
  });
});

test('an early observed child exit cannot borrow later inherited-pipe closure to satisfy a deadline', async () => {
  await temporary(async (root) => {
    const marker = join(root, 'active');
    const entry = { stimulus: 'deadline', runSeconds: 120, exitCode: 10, errorCode: 'DEADLINE_EXCEEDED' };
    const envelope = { status: 'cancelled', exitCode: 10, error: { code: entry.errorCode }, data: { state: 'terminal', status: 'cancelled', exitCode: 10 } };
    const script = `const {spawn}=require('node:child_process');require('node:fs').writeFileSync(${JSON.stringify(marker)},'active');const holder=spawn(process.execPath,['-e','setTimeout(()=>process.exit(0),500)'],{stdio:['ignore','inherit','inherit']});setTimeout(()=>process.stdout.write(${JSON.stringify(JSON.stringify(envelope) + '\n')},()=>process.exit(10)),100);`;
    const probe = await interruptPhaseCommand({ argv: [process.execPath, '-e', script], cwd: root, entry, observe: async () => await readFile(marker, 'utf8').then(() => ({ phase: 'controlled' }), () => null) });
    expect(probe).toMatchObject({ code: 10, signal: null, phaseReached: true, transportError: null });
    expect(probe.exit.observedElapsedMs).toBeLessThan(probe.close.observedElapsedMs);
    expect(BigInt(probe.startedMonoNs)).toBeLessThan(BigInt(probe.exit.observedMonoNs));
    expect(BigInt(probe.exit.observedMonoNs)).toBeLessThan(BigInt(probe.close.observedMonoNs));
    const boundaryMs = (probe.exit.observedElapsedMs + probe.close.observedElapsedMs) / 2;
    expect(probe.elapsedMs).toBeGreaterThan(boundaryMs);
    expect(() => assertPhaseResult({ ...entry, runSeconds: boundaryMs / 1000 }, probe, envelope)).toThrow('DEADLINE_TOO_EARLY');
  });
});

test('output overflow still stops the owned child and retains only bounded diagnostics', async () => {
  await temporary(async (root) => {
    const probe = await interruptPhaseCommand({ argv: [process.execPath, '-e', 'process.stdout.write(Buffer.alloc(16*1024**2+1,97));setInterval(()=>{},1000)'], cwd: root, entry: { stimulus: 'SIGTERM', runSeconds: 1 }, observe: async () => null });
    expect(probe).toMatchObject({ overflow: true, phaseReached: false, signalSent: null, transportError: null });
    expect(probe.events).toContainEqual(expect.objectContaining({ kind: 'harness-stop', signal: 'SIGTERM' }));
    expect(Buffer.byteLength(probe.stdout) + Buffer.byteLength(probe.stderr)).toBeLessThanOrEqual(16 * 1024 ** 2);
  });
});

test.each(['exit', 'observation-error'])('inherited pipes settle as failed transport after child %s without claiming descendant cleanup', async (ending) => {
  await temporary(async (root) => {
    const marker = join(root, 'descendant.json'), script = join(root, 'pipe-child.mjs');
    await writeFile(script, `import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';const child=spawn(process.execPath,['-e','setTimeout(()=>process.exit(0),1800)'],{stdio:['ignore','inherit','inherit']});writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:child.pid}));${ending === 'exit' ? 'process.exit(10)' : 'setInterval(()=>{},1000)'};`);
    let cliPid;
    try {
      const running = interruptPhaseCommand({ argv: [process.execPath, script], cwd: root, entry: { stimulus: 'SIGTERM', runSeconds: 120 }, observe: async ({ pid }) => { cliPid = pid; const record = await readFile(marker, 'utf8').then(JSON.parse, () => null); if (record && ending === 'observation-error') throw new Error('Controlled held-pipe failure'); return null; } });
      let probe;
      if (ending === 'observation-error') { const error = await running.catch((error) => error); expect(error.message).toBe('Controlled held-pipe failure'); probe = error.probe; }
      else probe = await running;
      expect(probe).toMatchObject({ phaseReached: false, transportError: 'PIPE_CLOSE_TIMEOUT', close: null, exit: ending === 'exit' ? { code: 10, signal: null } : { code: null, signal: 'SIGTERM' } });
      expect(() => process.kill(cliPid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
      const { pid } = JSON.parse(await readFile(marker, 'utf8'));
      expect(() => process.kill(pid, 0)).not.toThrow();
    } finally {
      const record = await readFile(marker, 'utf8').then(JSON.parse, () => null);
      if (record) {
        const until = performance.now() + 3000;
        let inactive = false;
        while (performance.now() < until) {
          try { process.kill(record.pid, 0); } catch (error) { if (error.code === 'ESRCH') { inactive = true; break; } throw error; }
          await new Promise((done) => setTimeout(done, 20));
        }
        if (!inactive) throw new Error('The bounded pipe-holder fixture did not exit');
      }
    }
  });
});

test('the owned child retains its full twelve-second TERM allowance before KILL', async () => {
  await temporary(async (root) => {
    const marker = join(root, 'ready');
    let cliPid, observed;
    const reached = new Promise((done) => { observed = done; });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let running;
    try {
      running = interruptPhaseCommand({ argv: [process.execPath, '-e', `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(marker)},'ready');setInterval(()=>{},1000)`], cwd: root, entry: { stimulus: 'SIGTERM', runSeconds: 120 }, observe: async ({ pid }) => { cliPid = pid; const until = performance.now() + 3000; while (performance.now() < until) { if (await readFile(marker, 'utf8').catch(() => null)) { observed(); throw new Error('Controlled TERM allowance'); } await new Promise(setImmediate); } throw new Error('Fixture did not start'); } }).catch((error) => error);
      await reached; await new Promise(setImmediate);
      await vi.advanceTimersByTimeAsync(11_999);
      expect(() => process.kill(cliPid, 0)).not.toThrow();
      await vi.advanceTimersByTimeAsync(1);
      const error = await running;
      expect(error.message).toBe('Controlled TERM allowance');
      expect(error.probe).toMatchObject({ exit: { code: null, signal: 'SIGKILL' }, close: { code: null, signal: 'SIGKILL' }, transportError: null, events: [expect.objectContaining({ signal: 'SIGTERM' }), expect.objectContaining({ signal: 'SIGKILL' })] });
    } finally { await vi.advanceTimersByTimeAsync(13_000); if (running) await running; vi.useRealTimers(); }
  });
});

test('an observation failure retains bounded child diagnostics and its cleanup signals', async () => {
  await temporary(async (root) => {
    const marker = join(root, 'diagnostic-written');
    let caught;
    try {
      const script = `process.stdout.write('controlled-before-observation\\n',()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'ready'));setInterval(()=>{},1000);`;
      await interruptPhaseCommand({ argv: [process.execPath, '-e', script], cwd: root, entry: { stimulus: 'SIGTERM', runSeconds: 1 }, observe: async () => { if (await readFile(marker, 'utf8').catch((error) => { if (error.code === 'ENOENT') return null; throw error; })) throw new Error('Controlled observation failure'); return null; } });
    } catch (error) { caught = error; }
    expect(caught?.message).toBe('Controlled observation failure');
    expect(caught?.probe?.stdout).toContain('controlled-before-observation');
    expect(caught?.probe?.events).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'harness-stop', signal: 'SIGTERM' })]));
  });
});

test('delivers a real signal to only the selected child after its controlled phase marker', async () => {
  await temporary(async (root) => {
    const marker = join(root, 'marker');
    const script = join(root, 'child.mjs');
    await writeFile(script, `import {writeFileSync} from 'node:fs';process.on('SIGINT',()=>{process.stdout.write('controlled\\n');process.exit(130)});writeFileSync(${JSON.stringify(marker)},'active');setInterval(()=>{},1000);`);
    const result = await interruptPhaseCommand({ argv: [process.execPath, script], cwd: root, entry: { stimulus: 'SIGINT', runSeconds: 2 }, phaseWaitMs: 1000, observe: async () => await readFile(marker, 'utf8').then(() => ({ phase: 'controlled' }), () => null) });
    expect(result).toMatchObject({ code: 130, signal: null, phaseReached: true, signalSent: 'SIGINT', timedOut: false, overflow: false, stdout: 'controlled\n' });
  });
});

test('retains phase-not-reached when a controlled child exits with the expected deadline code', async () => {
  await temporary(async (root) => {
    const result = await interruptPhaseCommand({ argv: [process.execPath, '-e', 'setTimeout(()=>process.exit(10),50)'], cwd: root, entry: { stimulus: 'deadline', runSeconds: 1 }, phaseWaitMs: 200, observe: async () => null });
    expect(result).toMatchObject({ code: 10, phaseReached: false, signalSent: null, timedOut: false });
  });
});

test('an empty ownership ledger cannot conceal an independently witnessed live process', async () => {
  await temporary(async (root) => {
    await writeFile(join(root, 'processes.json'), '[]');
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd: root, stdio: 'ignore', detached: true });
    const closed = new Promise((done) => child.once('close', done));
    try {
      const witness = await witnessPhaseProcess({ pid: child.pid }, child.pid, root);
      expect(witness.processes).toEqual(expect.arrayContaining([expect.objectContaining({ pid: child.pid, group: child.pid })]));
      await expect(assertWitnessInactive(witness, root)).rejects.toThrow('remains alive');
      child.kill('SIGTERM'); await closed;
      expect(await assertWitnessInactive(witness, root)).toMatchObject({ status: 'absent', observedProcesses: 1, observedGroups: 0 });
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await closed; }
  });
});

test('phase preparation reuses the public general-app fixture and keeps its caller state unchanged', async () => {
  await temporary(async (root) => {
    const entry = phaseCases.find(({ id }) => id === 'setup-deadline');
    const fixture = await preparePhaseFixture(entry, root);
    const original = await sourceState(fixture.repo);
    const config = JSON.parse(await readFile(fixture.configPath, 'utf8'));
    expect(ConfigSchema.parse(config).schemaVersion).toBe(2);
    expect(ScenarioSchema.parse(JSON.parse(await readFile(fixture.scenarioPath, 'utf8'))).schemaVersion).toBe(2);
    expect(config.execution.start.argv).toContain('{input.server}');
    expect(config.execution.setup[0].argv).toContain('{input.setup}');
    expect(config.execution.setup[0].timeoutMs).toBeGreaterThan(entry.runSeconds * 1000);
    expect(config.capture.mode).toBe('motion');
    expect(config.execution.env.R8_CANARY).toEqual({ fromEnv: 'SWC_R8_CANARY' });
    for (const input of config.execution.inputs) await command([process.execPath, '--check', input.path], root, { expectedCode: 0, timeoutMs: 5000 });
    expect(await readFile(join(fixture.repo, 'caller-state.txt'), 'utf8')).toContain('unstaged');
    expect(await sourceState(fixture.repo)).toEqual(original);
  });
});

test('the encoding fixture and schema parse without starting an encoder', async () => {
  await temporary(async (root) => {
    const previous = process.env.SWC_FFMPEG;
    process.env.SWC_FFMPEG = process.execPath;
    try {
      const fixture = await preparePhaseFixture(phaseCases.find(({ id }) => id === 'encoding-deadline'), root);
      ConfigSchema.parse(JSON.parse(await readFile(fixture.configPath, 'utf8')));
      ScenarioSchema.parse(JSON.parse(await readFile(fixture.scenarioPath, 'utf8')));
      await command([process.execPath, '--check', fixture.ffmpeg], root, { expectedCode: 0, timeoutMs: 5000 });
    } finally { if (previous === undefined) delete process.env.SWC_FFMPEG; else process.env.SWC_FFMPEG = previous; }
  });
});

test('the controlled encoder wrapper waits for completed output progress, not submitted bytes or frame-only progress', async () => {
  await temporary(async (root) => {
    const fake = join(root, 'controlled-progress.mjs'), stage = join(root, 'progress-stage');
    await writeFile(fake, `#!${process.execPath}\nimport {writeFileSync,writeSync} from 'node:fs';let n=0;process.stdin.on('data',()=>{n++;writeSync(3,'frame='+n+'\\nout_time_us='+(n<3?0:33333)+'\\nprogress=continue\\n');writeFileSync(${JSON.stringify(stage)},String(n))});setInterval(()=>{},1000);`);
    await chmod(fake, 0o700);
    const previous = process.env.SWC_FFMPEG; process.env.SWC_FFMPEG = fake;
    let child, closed;
    try {
      const fixture = await preparePhaseFixture(phaseCases.find(({ id }) => id === 'encoding-deadline'), root);
      await mkdir(join(root, 'private'));
      child = spawn(fixture.ffmpeg, ['-video_size', '1x1', join(root, '001-encode.mp4')], { cwd: root, detached: true, stdio: ['pipe', 'ignore', 'ignore'] });
      closed = new Promise((done) => child.once('close', done));
      const waitStage = async (expected) => {
        const deadline = performance.now() + 2000;
        while (performance.now() < deadline) { if (await readFile(stage, 'utf8').catch((error) => { if (error.code === 'ENOENT') return ''; throw error; }) === expected) return deadline; await new Promise((done) => setTimeout(done, 20)); }
        throw new Error('Controlled progress phase was not reached');
      };
      child.stdin.write('a'); await waitStage('1');
      await expect(readFile(join(root, 'private/r8-encode.json'))).rejects.toMatchObject({ code: 'ENOENT' });
      child.stdin.write('b'); await waitStage('2');
      await expect(readFile(join(root, 'private/r8-encode.json'))).rejects.toMatchObject({ code: 'ENOENT' });
      child.stdin.write('c'); const progressDeadline = await waitStage('3');
      let marker;
      while (performance.now() < progressDeadline) {
        try { marker = JSON.parse(await readFile(join(root, 'private/r8-encode.json'), 'utf8')); break; }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        await new Promise((done) => setTimeout(done, 20));
      }
      expect(marker).toMatchObject({ phase: 'encoding', encodedFrames: 3, outputTimeUs: 33333, progressSource: 'real-encoder-pipe:3' });
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) process.kill(-child.pid, 'SIGTERM');
      if (closed) await closed;
      if (previous === undefined) delete process.env.SWC_FFMPEG; else process.env.SWC_FFMPEG = previous;
    }
  });
});

test.each(['none', 'caller', 'secret', 'raw', 'retained-video', 'early-deadline'])('controlled full phase reporting rejects %s corruption and preserves its unrelated sentinel', async (corruption) => {
  await temporary(async (root) => {
    const binary = join(root, 'controlled-cli.mjs');
    const earlyDeadline = corruption === 'early-deadline';
    const entry = phaseCases.find(({ id }) => id === (earlyDeadline ? 'setup-deadline' : 'setup-sigterm'));
    await writeFile(binary, `
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
const args=process.argv.slice(2);
if(args[0]==='plan') {
  console.log(JSON.stringify({data:{baseCommit:args[args.indexOf('--base')+1],headCommit:args[args.indexOf('--head')+1]}}));
} else {
  const runId='20261103T010203004Z-0123456789abcdef';
  const run=join(process.cwd(),'.show-what-changed/runs',runId);
  let finishing=false;
  const finish=async()=>{
    if(finishing)return;
    finishing=true;
    const manifest={runId,state:'terminal',status:'cancelled',exitCode:${entry.exitCode},cleanupOutcome:{status:'ok',errors:[]},artifacts:{video:null,poster:null,capture:null,timeline:null,pr:null}};
    await writeFile(join(run,'manifest.json'),JSON.stringify(manifest));
    process.stdout.write(JSON.stringify({status:'cancelled',exitCode:${entry.exitCode},error:{code:${JSON.stringify(entry.errorCode)}},data:manifest})+'\\n',()=>process.exit(${entry.exitCode}));
  };
  if(!${earlyDeadline})process.on('SIGTERM',finish);
  await mkdir(join(run,'private/execution/before/aaaaaaaaaaaaaaaa/state'),{recursive:true});
  await writeFile(join(run,'private/processes.json'),'[]');
  if(${JSON.stringify(corruption)}==='caller')await writeFile('caller-state.txt','changed');
  if(${JSON.stringify(corruption)}==='secret')await writeFile(join(run,'private/canary.log'),process.env.SWC_R8_CANARY);
  if(${JSON.stringify(corruption)}==='raw')await writeFile(join(run,'private/unsanitized.webm'),'forbidden raw fixture');
  if(${JSON.stringify(corruption)}==='retained-video')await writeFile(join(run,'private/001-encode.mp4'),'unknown retained media');
  await writeFile(join(run,'private/execution/before/aaaaaaaaaaaaaaaa/state/r8-phase.json'),JSON.stringify({phase:'setup',pid:process.pid}));
  if(${earlyDeadline})setTimeout(finish,350);
  else setInterval(()=>{},1000);
}`);
    const row = await runPhaseCase(entry, { evidenceClass: 'controlled-synthetic-cli', binary, schemas: { ResultSchema: { parse: (value) => value }, ManifestSchema: { parse: (value) => value } }, PNG }, join(root, 'case'));
    expect(row.phaseReached).toBe(true);
    expect(row.sentinelPreserved).toBe(true);
    expect(row.cleanup).toBe('ok');
    expect(row.evidence).toBe('controlled-synthetic-cli');
    if (corruption === 'none') expect(row.status).toBe('passed');
    else {
      expect(row.status).toBe('failed');
      expect(row.errors).toContainEqual(expect.objectContaining({ code: corruption === 'caller' ? 'CALLER_CHANGED' : 'PHASE_CHECK_FAILED', stage: corruption === 'caller' ? 'preservation' : corruption === 'early-deadline' ? 'result' : 'privacy' }));
      if (corruption === 'early-deadline') expect(JSON.parse(await readFile(join(root, 'case/failure.json'), 'utf8')).message).toBe('DEADLINE_TOO_EARLY');
    }
    expect(JSON.stringify(row)).not.toContain(root);
    expect(JSON.stringify(row)).not.toContain('SYNTHETIC_PHASE_');
  });
});

test.each(['none', 'capture-ok', 'checkpoint-missing', 'checkpoint-renamed', 'png-truncated', 'png-crc', 'png-dimensions', 'mask-rgb', 'mask-alpha', 'capture-step', 'capture-status', 'capture-kind', 'capture-path', 'capture-bytes', 'capture-hash', 'capture-malformed', 'capture-advertised', 'capture-undefined', 'retained-video'])('controlled recording cancellation handles %s through full phase reporting', async (corruption) => {
  await temporary(async (root) => {
    const entry = phaseCases.find(({ id }) => id === 'recording-sigterm');
    const image = new PNG({ width: 320, height: 240 }); image.data.fill(128);
    for (let y = 0; y < 100; y++) for (let x = 0; x < 140; x++) image.data.set([16, 16, 16, 255], (y * 320 + x) * 4);
    const checkpoint = PNG.sync.write(image), safePath = join(root, 'safe.png'); await writeFile(safePath, checkpoint);
    image.data[0] = 255; await writeFile(join(root, 'unmasked.png'), PNG.sync.write(image));
    image.data[0] = 16; image.data[3] = 254; await writeFile(join(root, 'alpha.png'), PNG.sync.write(image));
    const binary = join(root, 'controlled-cli.mjs');
    await writeFile(binary, `
import {copyFile,mkdir,readFile,rename,rm,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
const args=process.argv.slice(2),corruption=${JSON.stringify(corruption)},safePath=${JSON.stringify(safePath)};
if(args[0]==='plan') {
  console.log(JSON.stringify({data:{baseCommit:args[args.indexOf('--base')+1],headCommit:args[args.indexOf('--head')+1]}}));
} else {
  const runId='20261103T010203004Z-0123456789abcdef';
  const run=join(process.cwd(),'.show-what-changed/runs',runId),checkpointPath='frames/001-before.png';
  let finishing=false;
  const finish=async()=>{
    if(finishing)return;
    finishing=true;
    const bytes=await readFile(safePath),image={path:checkpointPath,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
    const before={status:'ok',imageKind:'checkpoint',image},step={id:'private-fill',before,after:{...before}};
    if(corruption==='checkpoint-missing')await rm(join(run,checkpointPath));
    if(corruption==='checkpoint-renamed')await rename(join(run,checkpointPath),join(run,'frames/002-before.png'));
    if(corruption==='png-truncated')await writeFile(join(run,checkpointPath),bytes.subarray(0,24));
    if(corruption==='png-crc'){bytes[29]^=1;await writeFile(join(run,checkpointPath),bytes)}
    if(corruption==='png-dimensions'){bytes.writeUInt32BE(321,16);await writeFile(join(run,checkpointPath),bytes)}
    if(corruption==='mask-rgb')await copyFile(${JSON.stringify(join(root, 'unmasked.png'))},join(run,checkpointPath));
    if(corruption==='mask-alpha')await copyFile(${JSON.stringify(join(root, 'alpha.png'))},join(run,checkpointPath));
    if(corruption==='capture-step')step.id='open';
    if(corruption==='capture-status')before.status='failed';
    if(corruption==='capture-kind')before.imageKind='neutral';
    if(corruption==='capture-path')image.path='frames/000-before.png';
    if(corruption==='capture-bytes')image.bytes++;
    if(corruption==='capture-hash')image.sha256='0'.repeat(64);
    const artifacts={video:null,poster:null,capture:null,timeline:null,pr:null};
    if(corruption.startsWith('capture-')&&!['capture-advertised','capture-undefined'].includes(corruption))await writeFile(join(run,'capture.json'),corruption==='capture-malformed'?'{':JSON.stringify({scenarios:[{id:'phase',steps:[step]}]}));
    if(corruption==='capture-advertised')artifacts.capture={path:'capture.json',bytes:1,sha256:'0'.repeat(64)};
    if(corruption==='capture-undefined')delete artifacts.capture;
    if(corruption==='retained-video')await writeFile(join(run,'private/001-encode.mp4'),'unknown retained media');
    const manifest={runId,state:'terminal',status:'cancelled',exitCode:143,cleanupOutcome:{status:'ok',errors:[]},artifacts};
    await writeFile(join(run,'manifest.json'),JSON.stringify(manifest));
    process.stdout.write(JSON.stringify({status:'cancelled',exitCode:143,error:{code:'SIGTERM'},data:manifest})+'\\n',()=>process.exit(143));
  };
  process.on('SIGTERM',finish);
  await mkdir(join(run,'private/execution/before/aaaaaaaaaaaaaaaa/state'),{recursive:true});
  await mkdir(join(run,'frames'));
  await writeFile(join(run,'private/processes.json'),'[]');
  await copyFile(safePath,join(run,'frames/000-before.png'));
  await copyFile(safePath,join(run,checkpointPath));
  await writeFile(join(run,'private/execution/before/aaaaaaaaaaaaaaaa/state/r8-phase.json'),JSON.stringify({phase:'recording',pid:process.pid}));
  setInterval(()=>{},1000);
}`);
    const schemas = Object.fromEntries(['ResultSchema', 'ManifestSchema', 'CaptureBundleSchema'].map((name) => [name, { parse: (value) => value }]));
    const row = await runPhaseCase(entry, { evidenceClass: 'controlled-synthetic-cli', binary, schemas, PNG }, join(root, 'case'));
    const failure = await readFile(join(root, 'case/failure.json'), 'utf8').then(JSON.parse).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
    expect(row).toMatchObject({ phaseReached: true, actualExit: 143, cleanup: 'ok', callerPreserved: true, sentinelPreserved: true, evidence: 'controlled-synthetic-cli' });
    if (['none', 'capture-ok'].includes(corruption)) {
      expect(row.status, failure?.message).toBe('passed');
      expect(row.postFillCheckpoint).toBe(true);
      expect(row.recordingCheckpoint).toEqual({ path: 'frames/001-before.png', bytes: checkpoint.length, sha256: hash(checkpoint) });
      expect(row.sourceMasks.checkedImages).toBe(2);
      expect(row.retainedImages.sourceFrames).toBe(2);
      expect(row.mediaInspection).toMatchObject({ status: 'none-present', files: [] });
      expect(row.rawRecordingFilesAbsent).toBe(true);
    } else {
      expect(row.status).toBe('failed');
      expect(row.errors).toContainEqual({ code: 'PHASE_CHECK_FAILED', stage: corruption === 'capture-advertised' ? 'result' : 'privacy' });
      expect(failure).not.toBe(null);
    }
    expect(JSON.stringify(row)).not.toContain(root);
    expect(JSON.stringify(row)).not.toContain('SYNTHETIC_PHASE_');
  });
});

test('existing media is never classified absent when the public manifest has no video', async () => {
  await temporary(async (root) => {
    const manifest = { artifacts: { video: null, poster: null } };
    expect(await inspectRetainedMedia(root, manifest, {})).toMatchObject({ status: 'none-present', files: [] });
    await mkdir(join(root, 'private'), { recursive: true });
    await writeFile(join(root, 'private/001-encode.mp4'), 'present undecoded application media');
    await expect(inspectRetainedMedia(root, manifest, {})).rejects.toThrow('bound capture and timeline');
    await rm(join(root, 'private/001-encode.mp4'));
    await writeFile(join(root, 'unreferenced.mp4'), 'present unrecognized media');
    await expect(inspectRetainedMedia(root, manifest, {})).rejects.toThrow('Unrecognized retained media');
  });
});

test.each([false, true])('retained capability inspection consumes real files and cleans only a successfully inspected directory (corrupt=%s)', async (corrupt) => {
  await temporary(async (root) => {
    const run = join(root, 'run'); await mkdir(join(run, 'private'), { recursive: true });
    await copyFile(new URL('../fixtures/r03-phase-capability.mp4', import.meta.url), join(run, 'private/000-capability.mp4'));
    const image = new PNG({ width: 1920, height: 686 });
    for (let offset = 0; offset < image.data.length; offset += 4) image.data.set([72, 76, 85, 255], offset);
    if (corrupt) image.data[0] = 255;
    const png = join(root, 'controlled-decoded.png'); await writeFile(png, PNG.sync.write(image));
    const decoder = join(root, 'controlled-decoder.mjs');
    await writeFile(decoder, `#!${process.execPath}\nimport {copyFile} from 'node:fs/promises';const output=process.argv.at(-1);for(const n of ['000001','000002'])await copyFile(${JSON.stringify(png)},output.replace('%06d',n));`); await chmod(decoder, 0o700);
    const previous = process.env.SWC_FFMPEG; process.env.SWC_FFMPEG = decoder;
    try {
      const result = inspectRetainedMedia(run, { artifacts: { video: null, poster: null } }, { PNG });
      if (corrupt) {
        await expect(result).rejects.toThrow('safe color');
        expect(await readFile(join(run, 'private/r8-decoded-1/000001.png'))).toBeInstanceOf(Buffer);
      } else {
        expect(await result).toMatchObject({ status: 'inspected', files: [{ path: 'private/000-capability.mp4', status: 'decoded-complete', decodedFrames: 2 }] });
        await expect(readFile(join(run, 'private/r8-decoded-1/000001.png'))).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(stat(join(run, 'private/r8-decoded-1'))).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await readFile(join(run, 'private/000-capability.mp4'))).toEqual(await readFile(new URL('../fixtures/r03-phase-capability.mp4', import.meta.url)));
      }
    } finally { if (previous === undefined) delete process.env.SWC_FFMPEG; else process.env.SWC_FFMPEG = previous; }
  });
}, 20_000);

test.each(['composed', 'boundary', 'poster'])('controlled %s image corruption fails pixels even when its recorded hashes agree', async (kind) => {
  await temporary(async (root) => {
    await mkdir(join(root, 'composed')); await mkdir(join(root, 'private'));
    const image = new PNG({ width: 1920, height: 686 }); image.data.fill(255);
    for (const left of [319, 1281]) for (let y = 227; y < 327; y++) for (let x = left; x < left + 140; x++) image.data.set([16, 16, 16, 255], (y * 1920 + x) * 4);
    const safe = PNG.sync.write(image);
    image.data[(231 * 1920 + 323) * 4] = 255;
    const unsafe = PNG.sync.write(image), composed = kind === 'composed' || kind === 'poster' ? unsafe : safe;
    await writeFile(join(root, 'composed/001-step.png'), composed);
    if (kind === 'boundary') await writeFile(join(root, 'private/decoded-boundary-30.png'), unsafe);
    if (kind === 'poster') await writeFile(join(root, 'poster.png'), unsafe);
    const capture = { scenarios: [{ id: 'phase', steps: [{ id: 'fill', before: { imageKind: 'checkpoint' }, after: { imageKind: 'checkpoint' } }] }] };
    const timeline = { runId: 'controlled', viewport: { width: 320, height: 240, deviceScaleFactor: 1 }, images: [{ path: 'composed/001-step.png', bytes: composed.length, sha256: hash(composed) }], poster: 'composed/001-step.png', posterSelection: { kind: 'checkpoint', scenarioId: 'phase', stepId: 'fill' }, selections: [{ frame: 30, before: 'controlled-source', after: 'controlled-source' }], segments: [] };
    await writeFile(join(root, 'capture.json'), JSON.stringify(capture)); await writeFile(join(root, 'timeline.json'), JSON.stringify(timeline));
    const candidate = { PNG, validateTimelineCapture: () => {}, schemas: { CaptureBundleSchema: { parse: (value) => value }, TimelineSchema: { parse: (value) => value } } };
    const manifest = { runId: 'controlled', artifacts: { poster: null, video: null } };
    await expect(kind === 'poster' ? inspectRetainedMedia(root, manifest, candidate) : inspectRetainedImages(root, manifest, candidate)).rejects.toThrow(/mask/i);
  });
});

test('a frame directory read error cannot be relabeled as zero persisted images', async () => {
  await temporary(async (root) => {
    await writeFile(join(root, 'frames'), 'not a directory');
    await expect(verifyPersistedMasks(root, PNG)).rejects.toMatchObject({ code: 'ENOTDIR' });
  });
});

test('checks every persisted viewport PNG and rejects one unmasked pixel before accepting privacy evidence', async () => {
  await temporary(async (root) => {
    await mkdir(join(root, 'frames'));
    const viewport = { width: 8, height: 8 };
    const mask = { x: 0, y: 0, width: 4, height: 4 };
    const image = new PNG(viewport); image.data.fill(128);
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) { const p = (y * 8 + x) * 4; image.data.set([16, 16, 16, 255], p); }
    const bytes = PNG.sync.write(image);
    await writeFile(join(root, 'frames', 'source.png'), bytes);
    await writeFile(join(root, 'frames', 'checkpoint.png'), bytes);
    expect(await verifyPersistedMasks(root, PNG, viewport, mask)).toEqual({ checkedImages: 2 });
    image.data[0] = 255;
    await writeFile(join(root, 'frames', 'source.png'), PNG.sync.write(image));
    await expect(verifyPersistedMasks(root, PNG, viewport, mask)).rejects.toThrow();
  });
});
