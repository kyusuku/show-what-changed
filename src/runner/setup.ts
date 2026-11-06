import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import type { CommandContext } from '../schema/contracts.js';
import type { DoctorReport, Result } from '../schema/index.js';
import { cancellation, checkCancelled, failure } from '../schema/errors.js';
import { processTable } from '../runtime/process-table.js';
import { createSupervisor } from '../runtime/supervisor.js';
import { doctor } from './doctor.js';
import { failureResult, normalizeFailure } from './index.js';

type InstallOutcome =
  | { kind: 'completed' }
  | { kind: 'failed'; code: 'BROWSER_INSTALL_FAILED' | 'BROWSER_INSTALL_UNAVAILABLE' }
  | { kind: 'skipped'; reason: 'unsupported-node' | 'process-inspection-unavailable' };

async function pinnedPlaywrightCli(): Promise<string> {
  const manifestPath = createRequire(import.meta.url).resolve('playwright/package.json');
  const manifest = z.object({ bin: z.object({ playwright: z.literal('cli.js') }) }).parse(JSON.parse(await readFile(manifestPath, 'utf8')));
  return resolve(dirname(manifestPath), manifest.bin.playwright);
}

async function installPinnedChromium(context: CommandContext, deadlineMs: number): Promise<InstallOutcome> {
  checkCancelled(context.signal);
  if (!/^v24\./.test(process.version)) return { kind: 'skipped', reason: 'unsupported-node' };
  try {
    if (!(await processTable()).some((row) => row.pid === process.pid)) return { kind: 'skipped', reason: 'process-inspection-unavailable' };
  } catch {
    checkCancelled(context.signal);
    return { kind: 'skipped', reason: 'process-inspection-unavailable' };
  }
  checkCancelled(context.signal);
  let cli: string;
  try { cli = await pinnedPlaywrightCli(); }
  catch { return { kind: 'failed', code: 'BROWSER_INSTALL_UNAVAILABLE' }; }
  const privateDir = await realpath(await mkdtemp(join(tmpdir(), 'show-what-changed-setup-')));
  let removePrivateDir = true;
  try {
    await chmod(privateDir, 0o700);
    const supervisor = createSupervisor({ runId: randomUUID(), privateDir, signal: context.signal, deadlineMs, diagnostics: { event() {} }, redactText: () => '[Browser installer output omitted.]\n' });
    try {
      const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
      context.diagnostics.event('Preparing the pinned Chromium browser. Installer output is omitted.');
      const child = await supervisor.spawn({ argv: [process.execPath, cli, 'install', 'chromium', '--no-progress', '--no-remove'], cwd: context.invocationDir, purpose: 'setup', env, captureStdout: true });
      const exit = await child.exited;
      checkCancelled(context.signal);
      return exit.code === 0 && exit.signal === null && exit.spawnError === null ? { kind: 'completed' } : { kind: 'failed', code: 'BROWSER_INSTALL_FAILED' };
    } catch {
      checkCancelled(context.signal);
      return { kind: 'failed', code: 'BROWSER_INSTALL_FAILED' };
    } finally {
      try {
        if ((await supervisor.stopAll()).status === 'failed') throw new Error('Incomplete cleanup');
      } catch {
        removePrivateDir = false;
        throw failure(5, 'BROWSER_INSTALL_CLEANUP_FAILED', 'cleanup', 'Browser installer cleanup did not complete.', 'Inspect the owned installer processes before retrying setup.');
      }
    }
  } finally {
    if (removePrivateDir) {
      try { await rm(privateDir, { recursive: true, force: true }); }
      catch { throw failure(5, 'BROWSER_INSTALL_CLEANUP_FAILED', 'cleanup', 'Browser installer private state could not be removed.', 'Inspect the owned installer state before retrying setup.'); }
    }
  }
}

export async function setup(context: CommandContext): Promise<Result<DoctorReport>> {
  const controller = new AbortController();
  const interrupt = (): void => controller.abort(context.signal.reason);
  context.signal.addEventListener('abort', interrupt, { once: true });
  if (context.signal.aborted) interrupt();
  const deadlineMs = performance.now() + context.timeoutMs;
  const timer = setTimeout(() => controller.abort(failure(10, 'SETUP_DEADLINE_EXCEEDED', 'setup', 'Machine setup reached its deadline.', 'Check network access and prerequisites, then rerun show-what-changed setup.')), context.timeoutMs);
  timer.unref();
  const boundedContext = { ...context, signal: controller.signal };
  try {
    const installation = await installPinnedChromium(boundedContext, deadlineMs);
    checkCancelled(controller.signal);
    const inspection: Result<DoctorReport> = { ...await doctor(boundedContext), command: 'setup' };
    if (inspection.warnings.some((warning) => warning.code === 'DOCTOR_CLEANUP_FAILED')) return { ...failureResult<DoctorReport>('setup', failure(5, 'BROWSER_INSTALL_CLEANUP_FAILED', 'cleanup', 'A temporary capability probe needs manual cleanup.', 'Inspect owned probe processes before retrying setup.')), data: inspection.data, warnings: inspection.warnings };
    checkCancelled(controller.signal);
    if (installation.kind === 'completed' || inspection.status === 'cancelled') return inspection;
    if (installation.kind === 'skipped' && inspection.status !== 'ok') return inspection;
    const code = installation.kind === 'failed' ? installation.code : installation.reason === 'unsupported-node' ? 'NODE_VERSION_UNSUPPORTED' : 'BROWSER_INSTALL_PROCESS_INSPECTION_UNAVAILABLE';
    const failed = failureResult<DoctorReport>('setup', failure(8, code, 'setup', 'The pinned Chromium installation did not complete.', 'Check the documented browser download settings and machine prerequisites, then rerun show-what-changed setup.'));
    return { ...failed, data: inspection.data, warnings: [...inspection.warnings, { code, message: 'Browser installation did not complete. The capability report describes the current machine.' }] };
  } catch (error) {
    const normalized = normalizeFailure(error, 'setup');
    return failureResult('setup', normalized.exitCode === 5 ? normalized : cancellation(controller.signal) ?? normalized);
  } finally {
    clearTimeout(timer);
    context.signal.removeEventListener('abort', interrupt);
  }
}
