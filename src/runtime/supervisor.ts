import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { constants as osConstants } from 'node:os';
import { z } from 'zod';
import { PROCESS_ANCHOR } from './process-anchor.js';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import type { CleanupOutcome, DiagnosticSink, OwnedProcess, ProcessExit, SpawnSpec, Supervisor } from '../schema/contracts.js';
import { checkCancelled, failure } from '../schema/errors.js';
import { sanitizeText } from '../schema/io.js';
import { atomicPrivateFile } from './files.js';
import { childEnvironment, groupMembers } from './process-table.js';

function isSignal(value: unknown): value is NodeJS.Signals { return typeof value === 'string' && value in osConstants.signals; }
const CommandExitSchema = z.strictObject({ kind: z.enum(['exit', 'closed']), code: z.number().int().nullable(), signal: z.custom<NodeJS.Signals>(isSignal).nullable(), spawnError: z.string().nullable() });
const LIMIT = 5 * 1024 * 1024;
type Managed = { public: OwnedProcess; child: ChildProcess; anchored: boolean; known: Map<number, string>; stopping?: Promise<void>; poll: NodeJS.Timeout; flush: () => Promise<void> };
export function createSupervisor(options: { runId: string; privateDir: string; signal: AbortSignal; deadlineMs: number; diagnostics: DiagnosticSink; redactText?: (value: string) => string; onCancel?: () => void }): Supervisor {
  const processes = new Map<string, Managed>();
  let counter = 0;
  let stopping: Promise<CleanupOutcome> | undefined;
  let registryWrite = Promise.resolve();
  const persistProcesses = (): Promise<void> => { registryWrite = registryWrite.then(() => atomicPrivateFile(options.privateDir, 'processes.json', JSON.stringify([...processes.values()].map((item) => ({ pid: item.public.pid, group: item.public.groupId, started: item.known.get(item.public.pid) ?? null }))), true)); return registryWrite; };
  const redact = (text: string, sensitiveValues: readonly string[] = []): string => { for (const value of [...sensitiveValues].filter(Boolean).sort((a, b) => b.length - a.length)) text = text.split(value).join('[redacted]'); return sanitizeText(text).replace(/(?:Bearer\s+)[A-Za-z0-9._~+\/-]+/gi, 'Bearer [redacted]').replace(/((?:token|password|secret|authorization|api[_-]?key)\s*[=:]\s*)[^\s,;]+/gi, '$1[redacted]'); };
  async function register(child: ChildProcess, spec: Pick<SpawnSpec, 'purpose' | 'timeoutMs' | 'sensitiveValues'>, anchored = false): Promise<OwnedProcess> {
    const pid = child.pid;
    if (!pid) throw failure(8, 'SPAWN_FAILED', 'runtime', 'A required executable could not be started.', 'Check that the executable is installed and runnable.');
    const id = `${String(++counter).padStart(3, '0')}-${spec.purpose}`;
    let done = child.exitCode !== null || child.signalCode !== null;
    let stdout = Buffer.alloc(0); let stderr = Buffer.alloc(0); let truncated = false;
    let resolveExit: (result: ProcessExit) => void = () => {};
    const exited = new Promise<ProcessExit>((resolve) => { resolveExit = resolve; });
    let timer: NodeJS.Timeout | undefined;
    let settled = false;
    let stopPolling = (): void => {};
    const complete = (value: ProcessExit): void => { if (!settled) { settled = true; done = true; stopPolling(); if (timer) clearTimeout(timer); resolveExit(value); } };
    child.once('exit', () => { done = true; if (timer) clearTimeout(timer); });
    const stdoutEnded = child.stdout ? new Promise<void>((resolve) => child.stdout?.once('end', resolve)) : Promise.resolve();
    const stderrEnded = child.stderr ? new Promise<void>((resolve) => child.stderr?.once('end', resolve)) : Promise.resolve();
    if (anchored) child.on('message', (message: unknown) => {
      const parsed = CommandExitSchema.safeParse(message);
      if (!parsed.success) return;
      done = true; stopPolling(); if (timer && (spec.purpose === 'server' || spec.purpose === 'service')) clearTimeout(timer);
      if (parsed.data.kind === 'exit' && (spec.purpose === 'server' || spec.purpose === 'service')) complete(parsed.data);
      if (parsed.data.kind === 'closed') void Promise.all([stdoutEnded, stderrEnded]).then(() => complete(parsed.data));
    });
    child.once('close', (code, signal) => complete({ code, signal, spawnError: null }));
    child.once('error', () => complete({ code: null, signal: null, spawnError: 'Process could not be started.' }));
    if (done) resolveExit({ code: child.exitCode, signal: child.signalCode, spawnError: null });
    const append = (stream: 'stdout' | 'stderr', chunk: Buffer): void => {
      const remaining = LIMIT - stdout.length - stderr.length;
      if (chunk.length > remaining) truncated = true;
      if (remaining > 0) { if (stream === 'stdout') stdout = Buffer.concat([stdout, chunk.subarray(0, remaining)]); else stderr = Buffer.concat([stderr, chunk.subarray(0, remaining)]); }
    };
    child.stdout?.on('data', (bytes: Buffer) => append('stdout', bytes));
    child.stderr?.on('data', (bytes: Buffer) => append('stderr', bytes));
    child.stdin?.on('error', () => {});
    const owned: OwnedProcess = { id, pid, groupId: pid, exited, stdin: child.stdin, isAlive: () => !done, output: () => ({ stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'), truncated }) };
    const known = new Map<number, string>();
    const record = async (): Promise<void> => { if (child.exitCode === null && child.signalCode === null) for (const row of await groupMembers(pid)) known.set(row.pid, row.started); };
    const poll = setInterval(() => { void record().catch(() => {}); }, 150); poll.unref(); stopPolling = () => clearInterval(poll);
    const managed: Managed = { public: owned, child, anchored, known, poll, flush: async () => { await atomicPrivateFile(options.privateDir, `${id}.log`, Buffer.from((options.redactText ?? ((value: string) => value))(redact(`${stdout.toString('utf8')}\n${stderr.toString('utf8')}`, spec.sensitiveValues))).subarray(0, LIMIT - (truncated ? 64 : 0)).toString('utf8') + (truncated ? '\n[process log truncated at 5 MiB]\n' : ''), true); if (truncated) options.diagnostics.event(`Process ${id} diagnostic log was truncated.`); } };
    processes.set(id, managed);
    try {
      const members = await groupMembers(pid);
      const leader = members.find((row) => row.pid === pid);
      if (child.exitCode === null && child.signalCode === null && !leader) throw failure(8, 'PROCESS_OWNERSHIP_UNVERIFIED', 'runtime', 'The child is not in its own process group.', 'Run on a supported Linux or macOS host.');
      for (const row of members) known.set(row.pid, row.started);
      await persistProcesses();
      if (anchored) {
        const duration = Math.min(spec.timeoutMs ?? Infinity, options.deadlineMs - performance.now());
        timer = setTimeout(() => { void stop(owned).catch(() => {}); }, Math.max(1, duration)); timer.unref();
      }
      if (options.signal.aborted) await stop(owned);
      return owned;
    } catch (error) { if (child.exitCode === null && child.signalCode === null) { try { process.kill(-pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } } throw error; }
  }
  async function stop(owned: OwnedProcess): Promise<void> {
    const managed = processes.get(owned.id);
    if (!managed || managed.public !== owned) throw failure(2, 'UNOWNED_PROCESS', 'cleanup', 'Refusing to stop a process not owned by this run.', 'Use the original run supervisor.');
    if (managed.stopping) return managed.stopping;
    managed.stopping = (async () => {
      clearInterval(managed.poll);
      const signalGroup = async (signal: NodeJS.Signals): Promise<boolean> => {
        const rows = await groupMembers(owned.groupId);
        if (!rows.length) return false;
        const anchored = managed.child.exitCode === null && managed.child.signalCode === null && rows.some((row) => row.pid === owned.pid) || rows.some((row) => managed.known.get(row.pid) === row.started);
        if (!anchored) throw failure(5, 'PROCESS_OWNERSHIP_UNCERTAIN', 'cleanup', 'Process group identity can no longer be established safely.', 'Inspect remaining processes manually; no uncertain group was signalled.');
        for (const row of rows) managed.known.set(row.pid, row.started);
        try { process.kill(-owned.groupId, signal); } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error; }
        return true;
      };
      if (await signalGroup('SIGTERM')) {
        const remaining = async () => (await groupMembers(owned.groupId)).filter((row) => !managed.anchored || row.pid !== owned.pid);
        const until = performance.now() + 3000;
        while (performance.now() < until && (await remaining()).length) await delay(50);
        if ((await remaining()).length) await signalGroup('SIGKILL');
        else if (managed.anchored && managed.child.connected) managed.child.send({ kind: 'release' });
        const killUntil = performance.now() + 1500;
        while (performance.now() < killUntil && (await groupMembers(owned.groupId)).length) await delay(30);
        if ((await groupMembers(owned.groupId)).length) {
          await signalGroup('SIGKILL');
          throw failure(5, 'PROCESS_CLEANUP_FAILED', 'cleanup', 'Owned processes survived cleanup.', 'Inspect the owned process group manually.');
        }
      }
      await managed.flush();
    })();
    return managed.stopping;
  }
  const supervisor: Supervisor = {
    async spawn(spec) {
      checkCancelled(options.signal);
      if (stopping || performance.now() >= options.deadlineMs) throw failure(10, 'DEADLINE_EXCEEDED', 'execution', 'The run deadline was reached.', 'Increase the bounded timeout or simplify the scenario.');
      const [command] = spec.argv;
      if (!command) throw new TypeError('Process argv must contain an executable');
      const child = spawn(process.execPath, ['-e', PROCESS_ANCHOR, spec.input === 'pipe' ? 'pipe' : 'ignore', ...spec.argv], { cwd: spec.cwd, shell: false, detached: true, env: { ...childEnvironment(options.runId, spec.side, spec.port), ...spec.env }, stdio: [spec.input === 'pipe' ? 'pipe' : 'ignore', 'pipe', 'pipe', 'ipc'] });
      if (!child.pid) { await new Promise<void>((resolve) => { child.once('error', () => resolve()); child.once('spawn', () => resolve()); }); }
      return register(child, spec, true);
    },
    async adopt(child) { const owned = await register(child, { purpose: 'browser' }); if (stopping || options.signal.aborted) { await stop(owned); checkCancelled(options.signal); throw failure(10, 'RUN_STOPPED', 'browser', 'The run stopped before browser adoption.', 'Retry the comparison.'); } return owned; },
    stop,
    stopAll() {
      if (!stopping) stopping = (async () => {
        const results = await Promise.allSettled([...processes.values()].map((item) => stop(item.public)));
        const errors = results.flatMap((result) => result.status === 'rejected' ? [{ code: 'CLEANUP_FAILED', phase: 'cleanup', message: 'An owned process could not be cleaned up.', hint: 'Inspect private diagnostics and remaining owned processes.' }] : []);
        return { status: errors.length ? 'failed' : 'ok', errors };
      })();
      return stopping;
    },
  };
  options.signal.addEventListener('abort', () => { if (options.onCancel) options.onCancel(); else void supervisor.stopAll(); }, { once: true });
  return supervisor;
}
