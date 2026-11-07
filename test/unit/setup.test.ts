import { access, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandContext, ProcessExit } from '../../src/schema/contracts.js';
import type { DoctorReport, Result } from '../../src/schema/index.js';
import { ResultSchema } from '../../src/schema/index.js';
import { failure } from '../../src/schema/errors.js';

const mocks = vi.hoisted(() => ({ doctor: vi.fn(), processTable: vi.fn(), spawn: vi.fn(), stopAll: vi.fn(), createSupervisor: vi.fn() }));
vi.mock('../../src/runner/doctor.js', () => ({ doctor: mocks.doctor }));
vi.mock('../../src/runtime/process-table.js', () => ({ processTable: mocks.processTable }));
vi.mock('../../src/runtime/supervisor.js', () => ({ createSupervisor: mocks.createSupervisor }));
const { setup } = await import('../../src/runner/setup.js');

const ready: Result<DoctorReport> = { schemaVersion: 2, command: 'doctor', status: 'ok', exitCode: 0, data: { schemaVersion: 2, platform: 'synthetic', capabilities: [{ name: 'chromium', available: true, version: 'synthetic', message: 'Launch passed.', setupCommand: null }, { name: 'docker', available: false, version: null, message: 'Optional.', setupCommand: null }], abandonedRuns: [] }, error: null, warnings: [] };
let directory: string;
let context: CommandContext;
beforeEach(async () => {
  vi.resetAllMocks();
  directory = await mkdtemp(join(tmpdir(), 'swc-setup-unit-'));
  context = { invocationDir: directory, signal: new AbortController().signal, timeoutMs: 10000, consent: { kind: 'deny' }, diagnostics: { event: vi.fn() } };
  mocks.doctor.mockResolvedValue(ready);
  mocks.processTable.mockResolvedValue([{ pid: process.pid }]);
  mocks.spawn.mockResolvedValue({ exited: Promise.resolve({ code: 0, signal: null, spawnError: null } satisfies ProcessExit) });
  mocks.stopAll.mockResolvedValue({ status: 'ok', errors: [] });
  mocks.createSupervisor.mockImplementation(() => ({ spawn: mocks.spawn, stopAll: mocks.stopAll }));
});
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const [options] of mocks.createSupervisor.mock.calls) await rm(options.privateDir, { recursive: true, force: true });
  await rm(directory, { recursive: true, force: true });
});

describe('machine setup contract', () => {
  it('uses the packaged pinned installer without consent or application writes', async () => {
    const manifest = createRequire(import.meta.url).resolve('playwright/package.json');
    mocks.spawn.mockImplementation(async () => {
      const options = mocks.createSupervisor.mock.calls[0]?.[0];
      expect((await stat(options.privateDir)).mode & 0o777).toBe(0o700);
      expect(options.redactText('https://user:password@example.test/private?token=secret')).toBe('[Browser installer output omitted.]\n');
      return { exited: Promise.resolve({ code: 0, signal: null, spawnError: null }) };
    });
    const result = await setup(context);
    expect(result).toEqual({ ...ready, command: 'setup' });
    expect(ResultSchema.parse(result).command).toBe('setup');
    expect(mocks.spawn).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ argv: [process.execPath, join(dirname(manifest), 'cli.js'), 'install', 'chromium', '--no-progress', '--no-remove'], cwd: directory, purpose: 'setup', captureStdout: true }));
    expect(mocks.doctor).toHaveBeenCalledOnce();
    expect(mocks.stopAll).toHaveBeenCalledOnce();
    expect(await readdir(directory)).toEqual([]);
    await expect(access(mocks.createSupervisor.mock.calls[0]?.[0].privateDir)).rejects.toThrow();
  });

  it.each([undefined, '/custom/browser-cache', 'relative-browser-cache', '0'])('inherits the browser cache setting %s and proxy environment', async (cache) => {
    vi.stubEnv('PLAYWRIGHT_BROWSERS_PATH', cache);
    vi.stubEnv('HTTPS_PROXY', 'https://user:password@proxy.invalid');
    vi.stubEnv('NODE_EXTRA_CA_CERTS', '/synthetic/cert.pem');
    vi.stubEnv('INIT_CWD', '/synthetic/caller');
    vi.stubEnv('npm_config_playwright_browsers_path', 'npm-cache');
    await setup(context);
    const env = mocks.spawn.mock.calls[0]?.[0].env;
    expect(env.PLAYWRIGHT_BROWSERS_PATH).toBe(cache);
    expect(env).toMatchObject({ HTTPS_PROXY: 'https://user:password@proxy.invalid', NODE_EXTRA_CA_CERTS: '/synthetic/cert.pem', INIT_CWD: '/synthetic/caller', npm_config_playwright_browsers_path: 'npm-cache' });
  });

  it.each([{ code: 1, signal: null, spawnError: null }, { code: null, signal: 'SIGKILL', spawnError: null }, { code: null, signal: null, spawnError: 'secret' }])('keeps install failure after a passing cached browser probe', async (exit) => {
    mocks.spawn.mockResolvedValue({ exited: Promise.resolve(exit) });
    const result = await setup(context);
    expect(result).toMatchObject({ command: 'setup', status: 'failed', exitCode: 8, data: ready.data, error: { code: 'BROWSER_INSTALL_FAILED', hint: expect.stringContaining('show-what-changed setup') } });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(mocks.doctor).toHaveBeenCalledOnce();
  });

  it('runs final capability checks after spawn failure and preserves required failures', async () => {
    mocks.spawn.mockRejectedValue(new Error('https://user:secret@proxy.invalid'));
    mocks.doctor.mockResolvedValue({ ...ready, status: 'failed', exitCode: 8 });
    const result = await setup(context);
    expect(result).toMatchObject({ status: 'failed', exitCode: 8, data: ready.data });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(mocks.stopAll).toHaveBeenCalledOnce();
  });

  it('skips unsafe installation when process inspection is unavailable', async () => {
    mocks.processTable.mockRejectedValue(new Error('missing ps'));
    mocks.doctor.mockResolvedValue({ ...ready, status: 'failed', exitCode: 8 });
    expect(await setup(context)).toMatchObject({ command: 'setup', status: 'failed', exitCode: 8 });
    expect(mocks.createSupervisor).not.toHaveBeenCalled();
    expect(mocks.doctor).toHaveBeenCalledOnce();
  });

  it('keeps a skipped download failed even if process inspection recovers during doctor', async () => {
    mocks.processTable.mockRejectedValue(new Error('transient ps failure'));
    expect(await setup(context)).toMatchObject({ command: 'setup', status: 'failed', exitCode: 8, data: ready.data, error: { code: 'BROWSER_INSTALL_PROCESS_INSPECTION_UNAVAILABLE' } });
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('skips installation on unsupported Node and retains doctor diagnosis', async () => {
    const originalVersion = process.version;
    Object.defineProperty(process, 'version', { value: 'v22.0.0' });
    try {
      mocks.doctor.mockResolvedValue({ ...ready, status: 'failed', exitCode: 8 });
      expect(await setup(context)).toMatchObject({ command: 'setup', status: 'failed', exitCode: 8 });
      expect(mocks.processTable).not.toHaveBeenCalled();
    } finally { Object.defineProperty(process, 'version', { value: originalVersion }); }
  });

  it('retains private state and reports cleanup failure over cancellation', async () => {
    const controller = new AbortController();
    mocks.spawn.mockImplementation(async () => { controller.abort(failure(130, 'SIGINT', 'execution', 'Interrupted.', 'Retry.')); return { exited: Promise.resolve({ code: null, signal: 'SIGTERM', spawnError: null }) }; });
    mocks.stopAll.mockResolvedValue({ status: 'failed', errors: [] });
    expect(await setup({ ...context, signal: controller.signal })).toMatchObject({ command: 'setup', status: 'failed', exitCode: 5, error: { code: 'BROWSER_INSTALL_CLEANUP_FAILED' } });
    expect(mocks.doctor).not.toHaveBeenCalled();
    await expect(access(mocks.createSupervisor.mock.calls[0]?.[0].privateDir)).resolves.toBeUndefined();
  });

  it.each([
    { interruption: 'SIGINT', exitCode: 130, cleanupFailed: true },
    { interruption: 'deadline', exitCode: 10, cleanupFailed: true },
    { interruption: 'SIGINT', exitCode: 130, cleanupFailed: false },
    { interruption: 'deadline', exitCode: 10, cleanupFailed: false },
  ] as const)('preserves final doctor cleanup precedence for $interruption with cleanup failed $cleanupFailed', async ({ interruption, exitCode, cleanupFailed }) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const controller = new AbortController();
    const warnings = cleanupFailed ? [{ code: 'DOCTOR_CLEANUP_FAILED', message: 'A temporary capability probe needs manual cleanup.' }] : [];
    mocks.doctor.mockImplementation(async (inspectionContext: CommandContext) => {
      if (interruption === 'SIGINT') controller.abort(failure(130, 'SIGINT', 'execution', 'Interrupted.', 'Retry.'));
      else await vi.advanceTimersByTimeAsync(context.timeoutMs);
      expect(inspectionContext.signal.aborted).toBe(true);
      return { ...ready, status: 'cancelled', exitCode, data: null, error: { code: interruption === 'SIGINT' ? 'SIGINT' : 'SETUP_DEADLINE_EXCEEDED', phase: 'setup', message: 'Stopped.', hint: 'Retry.' }, warnings };
    });
    const result = await setup({ ...context, signal: controller.signal });
    expect(result).toMatchObject({ command: 'setup', status: cleanupFailed ? 'failed' : 'cancelled', exitCode: cleanupFailed ? 5 : exitCode, data: null, error: { code: cleanupFailed ? 'BROWSER_INSTALL_CLEANUP_FAILED' : interruption === 'SIGINT' ? 'SIGINT' : 'SETUP_DEADLINE_EXCEEDED' }, warnings });
    expect(ResultSchema.parse(result)).toEqual(result);
    expect(mocks.doctor).toHaveBeenCalledOnce();
  });

  it.each([130, 143] as const)('does not start work when already interrupted with exit %s', async (exitCode) => {
    const controller = new AbortController();
    controller.abort(failure(exitCode, exitCode === 130 ? 'SIGINT' : 'SIGTERM', 'execution', 'Stopped.', 'Retry.'));
    expect(await setup({ ...context, signal: controller.signal })).toMatchObject({ command: 'setup', status: 'cancelled', exitCode });
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(mocks.doctor).not.toHaveBeenCalled();
  });
});
