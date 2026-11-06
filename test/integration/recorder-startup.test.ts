import { afterEach, expect, test, vi } from 'vitest';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright';
import { capture } from '../../src/recorder/index.js';
import * as browserRuntime from '../../src/runtime/browser.js';
import { cleanupRun, createRunContext } from '../../src/runtime/context.js';
import { groupMembers } from '../../src/runtime/process-table.js';
import { CaptureSettingsSchema, parseScenario } from '../../src/schema/index.js';
import type { RunContext, Server, ServerPair } from '../../src/schema/contracts.js';
import { failure } from '../../src/schema/errors.js';

const roots: string[] = [];
const runs: RunContext[] = [];
afterEach(async () => {
  for (const run of runs.splice(0)) await cleanupRun(run);
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((ready) => { resolve = ready; });
  return { promise, resolve };
}

async function fixture(name: string) {
  const root = await mkdtemp(join(tmpdir(), 'swc-recorder-startup-'));
  roots.push(root);
  const controller = new AbortController();
  const timeline: { event: string; atMs: number; side?: number; connected?: boolean }[] = [];
  const started = performance.now();
  const record = (event: string, detail: { side?: number; connected?: boolean } = {}) => {
    timeline.push({ event, atMs: Math.round(performance.now() - started), ...detail });
  };
  const run = await createRunContext({ repoRoot: root, timeoutMs: 30000, signal: controller.signal, diagnostics: { event() {} } });
  runs.push(run);
  const contexts: BrowserContext[] = [];
  const openBrowser = browserRuntime.openBrowser;
  const instrument = (contextCreated: (context: BrowserContext, browser: Browser, side: number) => Promise<void>) => {
    vi.spyOn(browserRuntime, 'openBrowser').mockImplementation(async (owner) => {
      const browser = await openBrowser(owner);
      browser.on('disconnected', () => record('browser-disconnected'));
      const newContext = browser.newContext.bind(browser);
      let side = 0;
      vi.spyOn(browser, 'newContext').mockImplementation(async (...args) => {
        const index = ++side;
        const context = await newContext(...args);
        contexts.push(context);
        record('context-acquired', { side: index });
        context.on('close', () => record('context-closed', { side: index }));
        const closeContext = context.close.bind(context);
        vi.spyOn(context, 'close').mockImplementation(async (...closeArgs) => {
          record('context-close-start', { side: index, connected: browser.isConnected() });
          await closeContext(...closeArgs);
          record('context-close-complete', { side: index, connected: browser.isConnected() });
        });
        await contextCreated(context, browser, index);
        return context;
      });
      return browser;
    });
  };
  const server = (side: 'before' | 'after'): Server => ({ side, origin: 'http://127.0.0.1:1', port: 1, sourceLabel: side, source: { requested: side, commit: 'a'.repeat(40), kind: 'commit', materializedHash: 'b'.repeat(64) }, storageState: null, exited: new Promise<never>(() => {}) });
  const servers: ServerPair = { before: server('before'), after: server('after') };
  const start = () => capture(servers, [parseScenario({ schemaVersion: 2, id: 'startup', title: 'Startup lifecycle', steps: [{ id: 'open', op: 'goto', path: '/' }] })], CaptureSettingsSchema.parse({ mode: 'keyframes', fixedTime: null, observeMs: 0 }), run);
  const finish = async () => {
    const outcome = await cleanupRun(run);
    const processes: { group: number }[] = JSON.parse(await readFile(join(run.paths.privateDir, 'processes.json'), 'utf8'));
    const survivors = await Promise.all(processes.map(({ group }) => groupMembers(group)));
    if (process.env.SWC_DIAGNOSTIC_OUTPUT) await writeFile(join(process.env.SWC_DIAGNOSTIC_OUTPUT, `${name}.json`), JSON.stringify({ timeline, outcome, processes, survivors }, null, 2));
    expect(processes).toHaveLength(1);
    expect(survivors).toEqual([[]]);
    expect(timeline.filter(({ event }) => event === 'context-closed')).toHaveLength(2);
    return outcome;
  };
  return { root, run, controller, contexts, timeline, record, instrument, start, finish };
}

function gateInitScript(context: BrowserContext, operation: (page: Page, execute: () => ReturnType<Page['addInitScript']>) => ReturnType<Page['addInitScript']>) {
  const newPage = context.newPage.bind(context);
  vi.spyOn(context, 'newPage').mockImplementation(async () => {
    const page = await newPage();
    const addInitScript = page.addInitScript.bind(page);
    vi.spyOn(page, 'addInitScript').mockImplementation(async (...args) => operation(page, () => addInitScript(...args)));
    return page;
  });
}

test.each(['deadline-reason', 'explicit'] as const)('normalizes %s cancellation during real page initialization and closes contexts before the browser', async (kind) => {
  const f = await fixture(`initialization-${kind}`);
  const ready = deferred();
  let waiting = 0;
  f.instrument(async (context, _browser, side) => {
    gateInitScript(context, async (page, execute) => {
      const closed = new Promise<void>((resolve) => page.once('close', () => resolve()));
      f.record('initialization-waiting', { side });
      if (++waiting === 2) ready.resolve();
      await closed;
      return execute();
    });
  });
  const pending = f.start().catch((error: unknown) => error);
  await ready.promise;
  f.controller.abort(kind === 'deadline-reason'
    ? failure(10, 'DEADLINE_EXCEEDED', 'execution', 'The overall run deadline was reached.', 'Retry.')
    : failure(130, 'INTERRUPTED', 'execution', 'Interrupted.', 'Retry.'));
  const error = await pending;
  expect(waiting).toBe(2);
  expect(error).toMatchObject(kind === 'deadline-reason' ? { exitCode: 10, detail: { code: 'DEADLINE_EXCEEDED' } } : { exitCode: 130, detail: { code: 'INTERRUPTED' } });
  expect(await f.finish()).toEqual({ status: 'ok', errors: [] });
  const closes = f.timeline.filter(({ event }) => event === 'context-close-complete');
  expect(closes).toHaveLength(2);
  expect(closes.every(({ connected }) => connected)).toBe(true);
  const disconnected = f.timeline.findIndex(({ event }) => event === 'browser-disconnected');
  expect(f.timeline.slice(disconnected).some(({ event }) => event === 'context-close-complete')).toBe(false);
}, 45000);

test('the runtime browser owner closes actual contexts whose acquisition result arrives after cancellation cleanup', async () => {
  const f = await fixture('late-context-acquisition');
  const acquired = deferred();
  const release = deferred();
  const pageCreation = vi.fn();
  f.instrument(async (context) => {
    vi.spyOn(context, 'newPage').mockImplementation(pageCreation);
    if (f.contexts.length === 2) acquired.resolve();
    await release.promise;
  });
  const pending = f.start().catch((error: unknown) => error);
  await acquired.promise;
  f.controller.abort(failure(130, 'INTERRUPTED', 'execution', 'Interrupted.', 'Retry.'));
  expect(await f.finish()).toEqual({ status: 'ok', errors: [] });
  release.resolve();
  expect(await pending).toMatchObject({ exitCode: 130, detail: { code: 'INTERRUPTED' } });
  expect(pageCreation).not.toHaveBeenCalled();
}, 45000);

test('preserves the first ordinary startup error while mandatory run cleanup releases pending peer initialization', async () => {
  const f = await fixture('ordinary-startup-failure');
  const ready = deferred();
  const peerSettled = deferred();
  const original = new Error('First side initialization failed');
  let waiting = 0;
  f.instrument(async (context, _browser, side) => {
    gateInitScript(context, async (page, execute) => {
      const closed = new Promise<void>((resolve) => page.once('close', () => resolve()));
      if (++waiting === 2) ready.resolve();
      await ready.promise;
      if (side === 1) throw original;
      await closed;
      try { return await execute(); }
      finally { peerSettled.resolve(); }
    });
  });
  expect(await f.start().catch((error: unknown) => error)).toBe(original);
  expect(f.run.signal.aborted).toBe(false);
  expect(await f.finish()).toEqual({ status: 'ok', errors: [] });
  await peerSettled.promise;
  expect(f.run.signal.aborted).toBe(false);
}, 45000);

test('retains a genuine connected context disposal failure and the repository lock after browser fallback', async () => {
  const f = await fixture('genuine-context-close-failure');
  const ready = deferred();
  const original = new Error('First side initialization failed');
  let waiting = 0;
  let failedWhileConnected = false;
  f.instrument(async (context, browser, side) => {
    if (side === 1) vi.spyOn(context, 'close').mockImplementation(async () => {
      failedWhileConnected = browser.isConnected();
      throw new Error('Injected context disposal failure');
    });
    gateInitScript(context, async (page, execute) => {
      const closed = new Promise<void>((resolve) => page.once('close', () => resolve()));
      if (++waiting === 2) ready.resolve();
      await ready.promise;
      if (side === 1) throw original;
      await closed;
      return execute();
    });
  });
  expect(await f.start().catch((error: unknown) => error)).toBe(original);
  expect(f.run.signal.aborted).toBe(false);
  const cleanup = await f.finish();
  expect(failedWhileConnected).toBe(true);
  expect(cleanup).toMatchObject({ status: 'failed', errors: [{ code: 'CLEANUP_FAILED', message: 'An owned context could not be removed.' }] });
  expect(await cleanupRun(f.run)).toBe(cleanup);
  await expect(access(join(f.root, '.show-what-changed', 'run.lock'))).resolves.toBeUndefined();
  await expect(access(f.run.paths.tempDir)).resolves.toBeUndefined();
}, 45000);
