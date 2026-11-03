import { chromium } from 'playwright';
import type { Browser } from 'playwright';
import { performance } from 'node:perf_hooks';
import type { RunContext } from '../schema/contracts.js';
import { checkCancelled, failure } from '../schema/errors.js';
import { beforeDeadline } from './context.js';
import { childEnvironment } from './process-table.js';

export async function openBrowser(run: RunContext): Promise<Browser> {
  checkCancelled(run.signal);
  const timeout = Math.max(1, Math.min(30_000, run.deadlineMs - performance.now()));
  let server;
  try { server = await chromium.launchServer({ headless: true, chromiumSandbox: true, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false, timeout, env: childEnvironment(run.runId) }); }
  catch { checkCancelled(run.signal); throw failure(8, 'BROWSER_UNAVAILABLE', 'browser', 'The pinned Chromium browser could not be launched.', 'Run doctor and install the pinned Playwright browser prerequisites.'); }
  const child = server.process();
  const owned = await run.supervisor.adopt(child, 'browser').catch(async (error: unknown) => { await server.kill(); throw error; });
  run.resources.register({ kind: 'browser', identity: `chromium-${owned.id}`, dispose: async (deadline) => {
    try { await beforeDeadline(server.close(), Math.min(deadline, performance.now() + 1500)); }
    catch { await run.supervisor.stop(owned); await beforeDeadline(server.kill(), deadline); }
  } });
  checkCancelled(run.signal);
  try { return await chromium.connect(server.wsEndpoint(), { timeout }); }
  catch { await run.supervisor.stop(owned); checkCancelled(run.signal); throw failure(8, 'BROWSER_UNAVAILABLE', 'browser', 'The owned Chromium browser could not be connected.', 'Run doctor and retry.'); }
}
