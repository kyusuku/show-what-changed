import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import type { Server as HttpServer, ServerResponse } from 'node:http';
import { cp, mkdir, mkdtemp, readFile, rm, stat, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { capture } from '../../src/recorder/index.js';
import * as images from '../../src/recorder/images.js';
import { CaptureBundleSchema, CaptureSettingsSchema, parseScenario } from '../../src/schema/index.js';
import type { CaptureBundle, Scenario, Side } from '../../src/schema/index.js';
import type { RunContext, ServerPair } from '../../src/schema/contracts.js';
import { cleanupRun, createRunContext } from '../../src/runtime/context.js';
import { failure } from '../../src/schema/errors.js';

const settings = CaptureSettingsSchema.parse({
  mode: 'keyframes',
  fixedTime: '2000-01-01T00:00:00.000Z',
  observeMs: 0,
  stepTimeoutMs: 5000,
  maskSelectors: ['.secret', '.not-present'],
});
function scenario(id: string, steps: unknown[]): Scenario {
  return parseScenario({ schemaVersion: 2, id, title: 'Recorder integration', steps });
}
const motionHtml = await readFile(new URL('../../fixtures/motion/index.html', import.meta.url), 'utf8');
const open = { id: 'open', op: 'goto', path: '/' };

function html(side: 'before' | 'after'): string {
  return `<!doctype html><html><head><style>
  body{margin:0;font:20px sans-serif;background:white}.secret{position:fixed;left:10px;top:10px;width:400px;height:40px;background:#ff0000;color:#0000ff;white-space:nowrap;overflow:hidden}
  main{padding:80px 40px}button{margin:5px;padding:10px}#hover{background:#ddd}#hover:hover{background:#00ff00}#hover-state{display:none}#hover:hover #hover-state{display:inline}
  .hidden{display:none}.tall{margin-top:1400px}
  </style></head><body><div class="secret">SYNTHETIC-SECRET-777</div><main>
  <h1>Pricing</h1><p id="date"></p><p id="frames"></p><p id="ready"></p><p id="results"></p>
  <label>Search plans<input id="search"></label><button id="hover">Get Pro<span id="hover-state" data-testid="hover-state">Hover retained</span></button>
  ${side === 'after' ? '<button role="switch" aria-label="Yearly" onclick="document.getElementById(\'saving\').hidden=false">Yearly</button>' : '<button onclick="this.textContent=\'Legacy opened\'">Legacy details</button>'}
  <p id="saving" hidden>Save 20%</p><button data-testid="css-button" onclick="this.dataset.clicked=\'yes\'">CSS action</button>
  <button class="duplicate" onclick="fetch('/clicked-duplicate')">Duplicate</button><button class="duplicate" onclick="fetch('/clicked-neighbor')">Duplicate</button><button class="hidden" aria-label="Hidden">Hidden</button><button disabled>Disabled</button>
  <button id="popup" onclick="window.open('/popup')">Popup</button><button id="dialog" onclick="alert('synthetic')">Dialog</button>
  <button id="chooser" onclick="document.getElementById('file').click()">Choose file</button><input id="file" type="file" hidden>
  <a href="/download" download>Download</a><a href="https://example.invalid/escaped">External</a>
  <a href="/second">Second document</a><a href="/failure">Failed document</a><a href="about:blank">Blank document</a>
  <button id="error" onclick="throw new Error('SYNTHETIC-SECRET-777')">Page error</button>
  <button id="overlay" onclick="document.body.insertAdjacentHTML('beforeend','<div data-nextjs-dialog-overlay>Error</div>')">Overlay</button>
  <button id="set-storage" onclick="localStorage.setItem('state','dirty')">Store state</button><p id="fresh"></p>
  <h2 id="details" class="tall">Readiness details</h2></main><script>
  document.getElementById('date').textContent=new Date().toISOString();
  requestAnimationFrame(()=>requestAnimationFrame(()=>document.getElementById('frames').textContent='Animation frames live'));
  setTimeout(()=>document.getElementById('ready').textContent='Data ready',150);
  document.getElementById('fresh').textContent=localStorage.getItem('state')?'Dirty context':'Fresh context';
  let timer;document.getElementById('search').addEventListener('input',event=>{clearTimeout(timer);timer=setTimeout(()=>document.getElementById('results').textContent='Results for '+event.target.value,100)});
  setInterval(()=>fetch('/poll').catch(()=>{}),30); console.warn('SYNTHETIC-SECRET-777');
  </script></body></html>`;
}

describe('real Chromium recorder', () => {
  let root: string;
  let run: RunContext;
  let servers: ServerPair;
  let httpServers: HttpServer[];
  let controller: AbortController;
  let diagnostics: string[];
  let exitBefore: () => void;
  let clicks: string[];
  let pendingControls: Map<Side, ServerResponse>;
  let peerPending: Promise<void>;
  let markPeerPending: () => void;
  let releasePeer: () => void;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'swc-recorder-'));
    controller = new AbortController();
    diagnostics = [];
    httpServers = [];
    clicks = [];
    pendingControls = new Map();
    peerPending = new Promise<void>((resolve) => { markPeerPending = resolve; });
    run = await createRunContext({
      repoRoot: root,
      timeoutMs: 60000,
      signal: controller.signal,
      diagnostics: { event: (value) => {
        diagnostics.push(value);
        try {
          if (['capture-timestamp-rejection', 'capture-shutdown-failure'].includes(JSON.parse(value).kind)) process.stderr.write(value + '\n');
        } catch {}
      } },
    });
    const makeServer = async (side: 'before' | 'after') => {
      const server = createServer((request, response) => {
        if (request.url === '/motion') {
          response.writeHead(200, { 'content-type': 'text/html' });
          response.end(motionHtml);
          return;
        }
        if (request.url === '/failure') {
          response.writeHead(500);
          response.end('Failed');
          return;
        }
        if (request.url === '/redirect') {
          response.writeHead(302, { location: 'https://example.invalid/' });
          response.end();
          return;
        }
        if (request.url === '/download') {
          response.writeHead(200, {
            'content-type': 'application/octet-stream',
            'content-disposition': 'attachment; filename="file.txt"',
          });
          response.end('synthetic');
          return;
        }
        if (request.url === '/poll') {
          response.writeHead(204);
          response.end();
          return;
        }
        if (request.url?.startsWith('/clicked-')) {
          clicks.push(request.url);
          response.writeHead(204);
          response.end();
          return;
        }
        if (request.url === '/pending-control') {
          response.writeHead(200, { 'content-type': 'text/html' });
          response.end('<button id="late" disabled onclick="fetch(\'/clicked-late\')">Late control</button><script>fetch("/enable-late").then(()=>document.getElementById("late").disabled=false)</script>');
          return;
        }
        if (request.url === '/enable-late') {
          pendingControls.set(side, response);
          return;
        }
        if (request.url === '/font-hang') {
          response.writeHead(200, { 'content-type': 'text/html' });
          response.end(
            '<style>@font-face{font-family:pending;src:url(/slow-font)}body{font-family:pending}</style><p>Pending font</p>',
          );
          return;
        }
        if (request.url === '/slow-font') {
          response.writeHead(200, { 'content-type': 'font/woff2' });
          response.flushHeaders();
          return;
        }
        if (request.url === '/async-error') {
          response.writeHead(200, { 'content-type': 'text/html' });
          response.end('<p>Waiting</p><script>setTimeout(()=>{throw new Error("synthetic")},250)</script>');
          return;
        }
        if (request.url === '/late-error' || request.url === '/late-exit') {
          if (side === 'after') {
            releasePeer = () => {
              response.writeHead(200, { 'content-type': 'text/html' });
              response.end('<p>Peer ready</p>');
            };
            markPeerPending();
            return;
          }
          response.writeHead(200, { 'content-type': 'text/html' });
          response.end('<p>First ready</p>');
          return;
        }
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end(html(side));
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      httpServers.push(server);
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing HTTP port');
      const exited = new Promise<{ code: number; signal: null; spawnError: null }>((resolve) => {
        if (side === 'before') exitBefore = () => resolve({ code: 1, signal: null, spawnError: null });
      });
      return {
        side,
        origin: `http://127.0.0.1:${address.port}`,
        port: address.port,
        sourceLabel: `${side} fixture`,
        source: { requested: side, commit: 'a'.repeat(40), kind: 'commit' as const, materializedHash: 'b'.repeat(64) },
        storageState: null,
        exited,
      };
    };
    servers = { before: await makeServer('before'), after: await makeServer('after') };
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    const outcome = await cleanupRun(run);
    await Promise.all(
      httpServers.map(
        (server) =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      ),
    );
    await rm(root, { recursive: true, force: true });
    expect(outcome).toEqual({ status: 'ok', errors: [] });
  });

  const step = (bundle: CaptureBundle, index: number) => {
    const value = bundle.scenarios[0]?.steps[index];
    if (!value) throw new Error('Missing captured step');
    return value;
  };
  async function assertMasked(bundle: CaptureBundle): Promise<void> {
    const frames = await readdir(run.paths.framesDir);
    expect(frames.length).toBe(bundle.scenarios.reduce((count, item) => count + item.steps.length * 2, 0));
    for (const filename of frames) {
      expect(filename).toMatch(/^\d{3}-(before|after)\.png$/);
      const path = join(run.paths.framesDir, filename);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      const image = PNG.sync.read(await readFile(path));
      expect([image.width, image.height]).toEqual([1280, 800]);
      const offset = (20 * image.width + 20) * 4;
      const color = [...image.data.subarray(offset, offset + 3)];
      expect([
        [16, 16, 16],
        [32, 36, 44],
      ]).toContainEqual(color);
      for (let position = 0; position < image.data.length; position += 4) {
        if (image.data[position] === 255 && image.data[position + 1] === 0 && image.data[position + 2] === 0)
          throw new Error(`Unmasked synthetic secret in ${filename}`);
        if (image.data[position] === 0 && image.data[position + 1] === 0 && image.data[position + 2] === 255)
          throw new Error(`Unmasked synthetic secret text in ${filename}`);
      }
    }
  }

  it('executes all seven operations with exact locator variants, fragment navigation, hover and live timers', async () => {
    const bundle = await capture(
      servers,
      [
        scenario('all-actions', [
          open,
          { id: 'ready', op: 'expectVisible', target: { text: 'Data ready' } },
          { id: 'date', op: 'expectVisible', target: { text: settings.fixedTime } },
          { id: 'frames', op: 'expectVisible', target: { text: 'Animation frames live' } },
          { id: 'fill', op: 'fill', target: { label: 'Search plans' }, value: 'PRIVATE-FILL-123' },
          { id: 'debounce', op: 'expectVisible', target: { text: 'Results for PRIVATE-FILL-123' } },
          { id: 'css', op: 'click', target: { css: '[data-testid="css-button"]' } },
          { id: 'hover', op: 'hover', target: { role: 'button', name: 'Get Pro' } },
          { id: 'retained', op: 'expectVisible', target: { testId: 'hover-state' } },
          { id: 'poster', op: 'screenshot' },
          { id: 'fragment', op: 'goto', path: '/#details' },
          { id: 'scroll', op: 'scrollBy', y: -600 },
        ]),
      ],
      settings,
      run,
    );
    expect(
      bundle.scenarios[0]?.outcome,
      JSON.stringify(
        bundle.scenarios[0]?.steps.map(({ id, before, after }) => ({
          id,
          before: before.status + ':' + before.reasonCode,
          after: after.status + ':' + after.reasonCode,
        })),
      ),
    ).toBe('ok');
    expect(
      bundle.scenarios[0]?.steps.every(
        (item) => item.before.status === 'ok' && item.after.status === 'ok' && item.changeRatio !== null,
      ),
    ).toBe(true);
    expect(bundle.warnings.map((warning) => warning.code)).toContain('CSS_LOCATOR');
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics.join(' ')).not.toContain('SYNTHETIC-SECRET-777');
    const persisted = await readFile(join(run.paths.runDir, 'capture.json'), 'utf8');
    expect(persisted).not.toContain('PRIVATE-FILL-123');
    expect(persisted).not.toContain(servers.before.origin);
    expect(CaptureBundleSchema.parse(JSON.parse(persisted))).toEqual(bundle);
    const hover = PNG.sync.read(await readFile(join(run.paths.runDir, step(bundle, 9).before.image.path)));
    let greenPixels = 0;
    for (let index = 0; index < hover.data.length; index += 4)
      if (hover.data[index] === 0 && hover.data[index + 1] === 255 && hover.data[index + 2] === 0) greenPixels++;
    expect(greenPixels).toBeGreaterThan(100);
    await assertMasked(bundle);
  }, 60000);

  it('allows bounded zero-match absence and immediate side exclusions without verified metrics', async () => {
    const bundle = await capture(
      servers,
      [
        scenario('expected-absence', [
          open,
          {
            id: 'toggle',
            op: 'click',
            target: { role: 'switch', name: 'Yearly' },
            allowMissing: ['before'],
          },
          { id: 'saving', op: 'expectVisible', target: { text: 'Save 20%' }, only: 'after' },
          { id: 'poster', op: 'screenshot' },
        ]),
      ],
      settings,
      run,
    );
    expect(
      bundle.scenarios[0]?.outcome,
      JSON.stringify(bundle.scenarios[0]?.steps.map(({ id, before, after }) => ({ id, before, after }))),
    ).toBe('ok');
    expect(step(bundle, 1).before).toMatchObject({ status: 'expected_absent', heldFromStepId: 'open' });
    expect(step(bundle, 2).before).toMatchObject({ status: 'skipped_by_side', heldFromStepId: 'open' });
    expect(step(bundle, 1).changeRatio).toBeNull();
    expect(step(bundle, 2).changeRatio).toBeNull();
    expect(step(bundle, 3).before.status).toBe('ok');
    await assertMasked(bundle);
  }, 30000);

  it.each(['before', 'after'] satisfies Side[])(
    'fails required %s control, blocks later steps and lets the peer continue',
    async (side) => {
      const target =
        side === 'before' ? { role: 'switch', name: 'Yearly' } : { role: 'button', name: 'Legacy details' };
      const bundle = await capture(
        servers,
        [
          scenario('required-failure', [
            open,
            { id: 'required', op: 'click', target },
            { id: 'blocked', op: 'screenshot' },
          ]),
        ],
        settings,
        run,
      );
      const peer = side === 'before' ? 'after' : 'before';
      const results = JSON.stringify(
        bundle.scenarios[0]?.steps.map(({ id, before, after }) => ({
          id,
          before: { status: before.status, reasonCode: before.reasonCode, elapsedMs: before.elapsedMs },
          after: { status: after.status, reasonCode: after.reasonCode, elapsedMs: after.elapsedMs },
        })),
      );
      expect(bundle.scenarios[0]?.outcome, results).toBe('partial');
      expect(step(bundle, 1)[side], results).toMatchObject({
        status: 'failed',
        reasonCode: expect.stringMatching(/^(LOCATOR_MISSING|STEP_TIMEOUT)$/),
        heldFromStepId: 'open',
      });
      expect(step(bundle, 2)[side], results).toMatchObject({
        status: 'blocked',
        reasonCode: 'PREVIOUS_STEP_FAILED',
        heldFromStepId: 'open',
      });
      expect(step(bundle, 1)[peer].status, results).toBe('ok');
      expect(step(bundle, 2)[peer].status, results).toBe('ok');
      expect(step(bundle, 1).changeRatio).toBeNull();
      expect(step(bundle, 2).changeRatio).toBeNull();
      await assertMasked(bundle);
    },
    30000,
  );

  it('uses generated neutral frames when the first navigation fails', async () => {
    const bundle = await capture(
      servers,
      [
        scenario('first-failure', [
          { ...open, path: '/failure' },
          { id: 'later', op: 'screenshot' },
        ]),
      ],
      settings,
      run,
    );
    expect(step(bundle, 0).before).toMatchObject({
      status: 'failed',
      reasonCode: 'NAVIGATION_STATUS',
      heldFromStepId: null,
    });
    expect(step(bundle, 1).before).toMatchObject({ status: 'blocked', heldFromStepId: null });
    await assertMasked(bundle);
  }, 30000);

  it('keeps an excluded side neutral from the first navigation without looking up its targets', async () => {
    const bundle = await capture(
      servers,
      [
        scenario('after-only-route', [
          { ...open, only: 'after' },
          { id: 'ready', op: 'expectVisible', target: { role: 'heading', name: 'Pricing' }, only: 'after' },
          { id: 'poster', op: 'screenshot', only: 'after' },
        ]),
      ],
      settings,
      run,
    );
    expect(
      bundle.scenarios[0]?.outcome,
      JSON.stringify(bundle.scenarios[0]?.steps.map(({ id, before, after }) => ({ id, before, after }))),
    ).toBe('ok');
    expect(
      bundle.scenarios[0]?.steps.every(
        (item) =>
          item.before.status === 'skipped_by_side' &&
          item.before.heldFromStepId === null &&
          item.after.status === 'ok' &&
          item.changeRatio === null,
      ),
    ).toBe(true);
    await assertMasked(bundle);
  }, 30000);

  it('never verifies an about:blank checkpoint after excluding initial navigation', async () => {
    const bundle = await capture(
      servers,
      [
        scenario('excluded-navigation', [
          { ...open, only: 'after' },
          { id: 'checkpoint', op: 'screenshot' },
          { id: 'blocked', op: 'screenshot' },
        ]),
      ],
      settings,
      run,
    );
    expect(step(bundle, 0).before.status).toBe('skipped_by_side');
    expect(step(bundle, 1).before).toMatchObject({
      status: 'failed',
      reasonCode: 'DOCUMENT_UNAVAILABLE',
      imageKind: 'neutral',
    });
    expect(step(bundle, 1).changeRatio).toBeNull();
    expect(step(bundle, 2).before.status).toBe('blocked');
    expect(step(bundle, 2).after.status).toBe('ok');
  });

  it('accepts a fragment from a successful clicked document and rejects an unchanged null-response navigation', async () => {
    const bundle = await capture(
      servers,
      [
        scenario('click-navigation', [
          open,
          { id: 'second', op: 'click', target: { role: 'link', name: 'Second document' } },
          { id: 'fragment', op: 'goto', path: '/second#details' },
          { id: 'same-fragment', op: 'goto', path: '/second#details' },
        ]),
      ],
      settings,
      run,
    );
    expect(step(bundle, 1).before.status).toBe('ok');
    expect(step(bundle, 2).before.status).toBe('ok');
    expect(step(bundle, 3).before).toMatchObject({ status: 'failed', reasonCode: 'NAVIGATION_NO_RESPONSE' });
  }, 30000);

  it.each([
    ['ambiguous', { role: 'button', name: 'Duplicate' }],
    ['hidden', { text: 'Hidden' }],
    ['hidden-role', { role: 'button', name: 'Hidden' }],
    ['disabled', { role: 'button', name: 'Disabled' }],
    ['selector-engine-chain', { css: '.duplicate >> nth=0' }],
    ['xpath-chain', { css: '.duplicate >> xpath=..' }],
  ])(
    'does not excuse %s elements through allowMissing',
    async (_label, target) => {
      const bundle = await capture(
        servers,
        [
          scenario('strict-control', [
            open,
            { id: 'bad', op: 'click', target, allowMissing: ['before', 'after'], timeoutMs: 350 },
            { id: 'blocked', op: 'screenshot' },
          ]),
        ],
        settings,
        run,
      );
      expect(step(bundle, 1).before.status).toBe('failed');
      expect(step(bundle, 1).after.status).toBe('failed');
      expect(step(bundle, 2).before.status).toBe('blocked');
      expect(clicks).toEqual([]);
      await assertMasked(bundle);
    },
    30000,
  );

  it('fails invalid mask CSS with no raw screenshot fallback', async () => {
    const bundle = await capture(
      servers,
      [scenario('invalid-mask', [open, { id: 'blocked', op: 'screenshot' }])],
      { ...settings, mode: 'keyframes', maskSelectors: ['['] },
      run,
    );
    expect(step(bundle, 0).before.reasonCode).toBe('INVALID_MASK_SELECTOR');
    expect(step(bundle, 0).before.heldFromStepId).toBeNull();
    await assertMasked(bundle);
  }, 30000);

  it('closes a timed-out context before a pending control can become actionable', async () => {
    type ContextWitness = { checkpointAt: number; closedAt: number | null };
    const contexts = new Map<Side, ContextWitness>();
    const maskedFrame = images.maskedFrame;
    vi.spyOn(images, 'maskedFrame').mockImplementation((...args) => {
      const pending = maskedFrame(...args);
      void pending.then(() => {
        const [page] = args;
        for (const side of ['before', 'after'] satisfies Side[]) {
          if (page.url() !== servers[side].origin + '/pending-control') continue;
          const witness: ContextWitness = { checkpointAt: performance.now(), closedAt: null };
          contexts.set(side, witness);
          page.context().once('close', () => { witness.closedAt = performance.now(); });
        }
      }, () => {});
      return pending;
    });
    const bundle = await capture(
      servers,
      [
        scenario('pending-action', [
          { ...open, path: '/pending-control' },
          { id: 'late', op: 'click', target: { role: 'button', name: 'Late control' }, timeoutMs: 350 },
          { id: 'blocked', op: 'screenshot' },
        ]),
      ],
      settings,
      run,
    );
    const checkpointTimes: number[] = [];
    const contextCloseTimes: number[] = [];
    for (const side of ['before', 'after'] satisfies Side[]) {
      expect(step(bundle, 0)[side].status).toBe('ok');
      expect(step(bundle, 1)[side]).toMatchObject({ status: 'failed', reasonCode: 'STEP_TIMEOUT' });
      expect(step(bundle, 1)[side].elapsedMs).toBeLessThan(2500);
      expect(step(bundle, 2)[side].status).toBe('blocked');
      const witness = contexts.get(side);
      expect(witness?.closedAt).toEqual(expect.any(Number));
      if (!witness || witness.closedAt === null) throw new Error('Missing context close witness');
      checkpointTimes.push(witness.checkpointAt);
      contextCloseTimes.push(witness.closedAt);
    }
    expect(Math.max(...contextCloseTimes) - Math.max(...checkpointTimes)).toBeLessThan(2500);
    expect([...pendingControls.keys()].sort()).toEqual(['after', 'before']);
    for (const response of pendingControls.values()) response.end();
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(clicks).toEqual([]);
  }, 30000);

  it('bounds font settlement by the same whole-step deadline', async () => {
    const started = performance.now();
    const bundle = await capture(
      servers,
      [
        scenario('settle-timeout', [
          { ...open, path: '/font-hang', timeoutMs: 350 },
          { id: 'blocked', op: 'screenshot' },
        ]),
      ],
      settings,
      run,
    );
    expect(step(bundle, 0).before).toMatchObject({
      status: 'failed',
      reasonCode: 'STEP_TIMEOUT',
      heldFromStepId: null,
    });
    expect(step(bundle, 1).before.status).toBe('blocked');
    expect(performance.now() - started).toBeLessThan(2500);
  }, 30000);

  it('fails asynchronous page errors while waiting for explicit readiness', async () => {
    const bundle = await capture(
      servers,
      [
        scenario('async-page-error', [
          { ...open, path: '/async-error' },
          { id: 'waiting', op: 'expectVisible', target: { text: 'Never ready' } },
          { id: 'blocked', op: 'screenshot' },
        ]),
      ],
      settings,
      run,
    );
    expect(bundle.scenarios[0]?.steps.some((item) => item.before.reasonCode === 'PAGE_ERROR')).toBe(true);
    expect(step(bundle, 2).before.status).toBe('blocked');
  }, 30000);

  it.each([
    ['/late-error', 'PAGE_ERROR'],
    ['/late-exit', 'SERVER_EXITED'],
  ])(
    'records a fault after one side captures while its peer is pending at %s',
    async (path, reason) => {
      const ordering: string[] = [];
      let checkpoint: Buffer | undefined;
      const maskedFrame = images.maskedFrame;
      vi.spyOn(images, 'maskedFrame').mockImplementation((...args) => {
        const pending = maskedFrame(...args);
        void pending.then((bytes) => {
          const [page] = args;
          if (page.url() === servers.before.origin + path) {
            checkpoint = bytes;
            ordering.push('before checkpoint');
            void peerPending.then(() => setImmediate(() => {
              const observed = () => {
                ordering.push('fault observed');
                releasePeer();
                ordering.push('peer released');
              };
              if (reason === 'PAGE_ERROR') {
                page.once('pageerror', observed);
                void page.evaluate(() => {
                  const script = document.createElement('script');
                  script.textContent = 'throw new Error("synthetic")';
                  document.body.append(script);
                }).catch(() => {});
              } else {
                void servers.before.exited.then(observed);
                exitBefore();
              }
            }));
          }
        }, () => {});
        return pending;
      });
      const bundle = await capture(servers, [scenario('late-fault', [{ ...open, path }])], settings, run);
      expect(ordering).toEqual(['before checkpoint', 'fault observed', 'peer released']);
      expect(bundle.scenarios[0]?.outcome).toBe('partial');
      expect(step(bundle, 0).before).toMatchObject({
        status: 'failed', reasonCode: reason, heldFromStepId: 'open', imageKind: 'held',
      });
      expect(await readFile(join(run.paths.runDir, step(bundle, 0).before.image.path))).toEqual(checkpoint);
      expect(step(bundle, 0).after.status).toBe('ok');
      expect(step(bundle, 0).changeRatio).toBeNull();
    },
    30000,
  );

  it.each([
    ['Popup', 'UNSUPPORTED_POPUP'],
    ['Dialog', 'UNSUPPORTED_DIALOG'],
    ['Choose file', 'UNSUPPORTED_FILE_CHOOSER'],
    ['Download', 'UNSUPPORTED_DOWNLOAD'],
    ['External', 'NAVIGATION_ORIGIN'],
    ['Blank document', 'NAVIGATION_ORIGIN'],
    ['Failed document', 'NAVIGATION_STATUS'],
    ['Page error', 'PAGE_ERROR'],
    ['Overlay', 'APPLICATION_ERROR_OVERLAY'],
  ])(
    'fails unsupported or unhealthy browser event %s',
    async (name, reason) => {
      const bundle = await capture(
        servers,
        [
          scenario('scope-event', [
            open,
            { id: 'event', op: 'click', target: { text: name } },
            { id: 'blocked', op: 'screenshot' },
          ]),
        ],
        settings,
        run,
      );
      expect(step(bundle, 1).before).toMatchObject({ status: 'failed', reasonCode: reason });
      expect(step(bundle, 2).before.status).toBe('blocked');
      await assertMasked(bundle);
    },
    30000,
  );

  it('fails redirects outside the supplied origin', async () => {
    const bundle = await capture(
      servers,
      [scenario('redirect-scope', [{ ...open, path: '/redirect' }])],
      settings,
      run,
    );
    expect(step(bundle, 0).before.status).toBe('failed');
    expect(step(bundle, 0).changeRatio).toBeNull();
    await assertMasked(bundle);
  }, 30000);

  it('starts each sequential scenario with fresh browser storage', async () => {
    const bundle = await capture(
      servers,
      [
        scenario('storage-write', [open, { id: 'store', op: 'click', target: { text: 'Store state' } }]),
        scenario('storage-fresh', [open, { id: 'fresh', op: 'expectVisible', target: { text: 'Fresh context' } }]),
      ],
      settings,
      run,
    );
    expect(bundle.scenarios.map((item) => item.outcome)).toEqual(['ok', 'ok']);
    await assertMasked(bundle);
  }, 30000);

  it('fails a side when its supplied server exit signal resolves during recording', async () => {
    const task = capture(
      servers,
      [
        scenario('server-exit', [
          open,
          { id: 'waiting', op: 'expectVisible', target: { text: 'Never here' } },
          { id: 'blocked', op: 'screenshot' },
        ]),
      ],
      settings,
      run,
    );
    setTimeout(() => exitBefore(), 700);
    const bundle = await task;
    expect(bundle.scenarios[0]?.outcome).toBe('partial');
    expect(bundle.scenarios[0]?.steps.some((item) => item.before.reasonCode === 'SERVER_EXITED')).toBe(true);
    await assertMasked(bundle);
  }, 30000);

  it('cancels the whole recording with the supplied typed cancellation and stops pending actions', async () => {
    const task = capture(
      servers,
      [scenario('cancel-action', [open, { id: 'hidden', op: 'click', target: { text: 'Hidden' }, timeoutMs: 10000 }])],
      settings,
      run,
    );
    setTimeout(() => controller.abort(failure(130, 'SIGINT', 'execution', 'Interrupted.', 'Run again.')), 800);
    await expect(task).rejects.toMatchObject({ exitCode: 130, detail: { code: 'SIGINT' } });
  }, 30000);

  it('records live narrow odd-sized motion, fixed Date, masks every frame and scrolls an inner target', async () => {
    const motionSettings = CaptureSettingsSchema.parse({
      mode: 'motion',
      viewport: { width: 391, height: 845 },
      fixedTime: '2000-01-01T00:00:00.000Z',
      maskRects: [{ x: 0, y: 0, width: 140, height: 100 }],
      observeMs: 0,
    });
    let bundle: CaptureBundle | undefined;
    try {
      bundle = await capture(
        servers,
        [
          scenario('narrow-motion', [
            { ...open, path: '/motion', observeMs: 50 },
            { id: 'move', op: 'click', target: { role: 'button', name: 'Start motion' }, observeMs: 700 },
            { id: 'inner', op: 'scrollBy', target: { testId: 'inner-scroll' }, y: 600, observeMs: 30 },
            { id: 'poster', op: 'screenshot' },
          ]),
        ],
        motionSettings,
        run,
      );
      expect(bundle.scenarios[0]?.outcome, JSON.stringify(bundle.scenarios)).toBe('ok');
      expect(bundle.viewport).toEqual({ width: 391, height: 845, deviceScaleFactor: 1 });
      if (bundle.captureMode !== 'motion') throw new Error('Expected motion');
      for (const side of ['before', 'after'] as const) {
        const track = bundle.motion[0]?.tracks[side];
        expect(track?.status).toBe('ok');
        if (!track) throw new Error('Missing track');
        expect(track.frames.length).toBeGreaterThan(15);
        expect(track.stats.receivedFrames).toBe(track.stats.acknowledgedFrames);
        expect(track.stats.persistedFrames).toBe(track.stats.receivedFrames);
        for (const frame of track.frames) {
          const png = PNG.sync.read(await readFile(join(run.paths.runDir, frame.artifact.path)));
          expect([png.width, png.height]).toEqual([391, 845]);
          for (let y = 0; y < 100; y++)
            for (let x = 0; x < 140; x++) {
              const p = (y * png.width + x) * 4;
              if (png.data[p] !== 16 || png.data[p + 1] !== 16 || png.data[p + 2] !== 16 || png.data[p + 3] !== 255)
                throw new Error('Unsafe source mask');
            }
        }
      }
    } catch (cause) {
      const artifactRoot = join(process.cwd(), 'evidence/artifacts/recorder-failures');
      await mkdir(artifactRoot, { recursive: true });
      const retained = await mkdtemp(join(artifactRoot, 'narrow-motion-'));
      await cp(run.paths.runDir, join(retained, 'run'), { recursive: true });
      await writeFile(join(retained, 'observation.json'), JSON.stringify({ bundle, diagnostics }, null, 2) + '\n');
      throw cause;
    }
  }, 30000);

  it('keeps peer-side motion when a server exit is already known before the first scenario step', async () => {
    const pair = {
      ...servers,
      before: { ...servers.before, exited: Promise.resolve({ code: 1, signal: null, spawnError: null }) },
    };
    const motionSettings = CaptureSettingsSchema.parse({
      mode: 'motion',
      viewport: { width: 391, height: 845 },
      maskRects: [{ x: 0, y: 0, width: 391, height: 60 }],
      observeMs: 0,
    });
    const bundle = await capture(
      pair,
      [scenario('early-server-exit', [open, { id: 'later', op: 'screenshot' }])],
      motionSettings,
      run,
    );
    expect(bundle.scenarios[0]?.outcome).toBe('partial');
    expect(step(bundle, 0).before).toMatchObject({ status: 'failed', reasonCode: 'SERVER_EXITED' });
    expect(step(bundle, 1).before.status).toBe('blocked');
    expect(step(bundle, 1).after.status).toBe('ok');
    if (bundle.captureMode !== 'motion') throw new Error('Expected motion');
    const first = bundle.motion[0]?.steps[0];
    expect(first?.before.kind).toBe('failed');
    if (first?.before.kind === 'failed') {
      const marker = first.before.failure;
      expect(marker.kind === 'source' ? marker.hostBeforeMs : marker.runElapsedMs).toBeGreaterThanOrEqual(first.barrierMs);
    }
    expect(CaptureBundleSchema.parse(bundle)).toEqual(bundle);
  }, 30000);

  it('preserves the real overall deadline cancellation code during a pending action', async () => {
    await cleanupRun(run);
    run = await createRunContext({
      repoRoot: root,
      timeoutMs: 1000,
      signal: controller.signal,
      diagnostics: { event: (value) => {
        diagnostics.push(value);
        try {
          if (['capture-timestamp-rejection', 'capture-shutdown-failure'].includes(JSON.parse(value).kind)) process.stderr.write(value + '\n');
        } catch {}
      } },
    });
    await expect(
      capture(
        servers,
        [
          scenario('whole-run-timeout', [
            open,
            { id: 'hidden', op: 'click', target: { text: 'Hidden' }, timeoutMs: 10000 },
          ]),
        ],
        settings,
        run,
      ),
    ).rejects.toMatchObject({ exitCode: 10, detail: { code: 'DEADLINE_EXCEEDED' } });
  }, 30000);
});
