import { access, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { CommandContext, RunContext } from '../../src/schema/contracts.js';
import { failure } from '../../src/schema/errors.js';
import { ResultSchema } from '../../src/schema/index.js';
import { runCleanupLifetime } from '../../src/runtime/cleanup-lifetime.js';

const boundary = vi.hoisted(() => ({ deniedPath: '', media: vi.fn() }));
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, rm: async (...args: Parameters<typeof actual.rm>) => {
    if (String(args[0]) === boundary.deniedPath) throw Object.assign(new Error('Injected cleanup permission failure.'), { code: 'EACCES' });
    return actual.rm(...args);
  } };
});
vi.mock('../../src/runtime/process-table.js', async (original) => ({
  ...await original<typeof import('../../src/runtime/process-table.js')>(),
  systemProbe: async () => ({ code: 0, stdout: 'synthetic 4.99.7', stderr: '' }),
  processTable: async () => [{ pid: process.pid, parent: process.ppid, group: process.pid, started: 'synthetic owner' }],
}));
vi.mock('../../src/runtime/docker.js', () => ({ dockerCapabilities: async () => ({ available: false, version: null, buildx: null }) }));
vi.mock('playwright', () => ({ chromium: { executablePath: () => process.execPath } }));
vi.mock('../../src/runtime/browser.js', () => ({ openBrowser: async () => { throw new Error('Browser probe is unavailable in this fixture.'); } }));
vi.mock('../../src/composer/index.js', () => ({ checkMediaCapabilities: boundary.media }));
const { doctor } = await import('../../src/runner/doctor.js');

let run: RunContext | undefined;
afterEach(async () => {
  boundary.deniedPath = '';
  boundary.media.mockReset();
  if (run) {
    runCleanupLifetime(run).finish();
    await rm(run.paths.repoRoot, { recursive: true, force: true });
    run = undefined;
  }
});

it('retains failed probe cleanup warnings when doctor is interrupted', async () => {
  const controller = new AbortController();
  boundary.media.mockImplementation(async (probeRun: RunContext) => {
    run = probeRun;
    boundary.deniedPath = probeRun.paths.tempDir;
    controller.abort(failure(130, 'SIGINT', 'execution', 'Interrupted.', 'Retry.'));
  });
  const context: CommandContext = { invocationDir: process.cwd(), signal: controller.signal, timeoutMs: 10000, consent: { kind: 'deny' }, diagnostics: { event() {} } };
  const result = await doctor(context);
  expect(result).toMatchObject({ command: 'doctor', status: 'cancelled', exitCode: 130, error: { code: 'SIGINT' }, warnings: [{ code: 'DOCTOR_CLEANUP_FAILED' }] });
  expect(ResultSchema.parse(result)).toEqual(result);
  if (!run) throw new Error('The real capability probe context was not created.');
  await expect(access(run.paths.tempDir)).resolves.toBeUndefined();
  expect(JSON.parse(await readFile(join(run.paths.repoRoot, '.show-what-changed', 'run.lock', 'owner.json'), 'utf8'))).toMatchObject({ runId: run.runId, state: 'active' });
});
