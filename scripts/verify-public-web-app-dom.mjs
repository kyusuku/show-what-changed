#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const argumentsList = process.argv.slice(2);
assert(argumentsList.length % 2 === 0, 'Arguments must be --source-root <path> and --output <path>.');
const options = new Map();
for (let index = 0; index < argumentsList.length; index += 2) {
  const option = argumentsList[index];
  assert(['--source-root', '--output'].includes(option) && !options.has(option), `Unknown or duplicate option ${option}.`);
  options.set(option, argumentsList[index + 1]);
}
const sourceRoot = resolve(options.get('--source-root') ?? join(dirname(fileURLToPath(import.meta.url)), '..'));
const scratchRoot = mkdtempSync(join(tmpdir(), 'swc-public-dom-'));
const outputPath = resolve(options.get('--output') ?? join(scratchRoot, 'report.json'));
const requireFromSource = createRequire(join(sourceRoot, 'package.json'));
const { chromium } = requireFromSource('playwright');
const { createPublicWebApp } = await import(pathToFileURL(join(sourceRoot, 'scripts/create-public-web-app.mjs')).href);
const childEnvironment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
Object.assign(childEnvironment, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });
const diagnostics = [];
const sideWorktrees = [];
const ownedProcessIds = new Set();
let browserServer;
let ownedBrowserProfile;
let browser;
let server;
let fixture;
let failure;
const report = {
  schemaVersion: 1, observedAt: new Date().toISOString(),
  repeatCommand: 'node scripts/verify-public-web-app-dom.mjs --output evidence/revision-0.3/public-dom-observation.json',
  purpose: 'Independent public Workshop board DOM observation. This does not establish final installed-package acceptance or normal-speed media acceptance.',
  sourceIdentity: {}, runtime: {}, viewport: { width: 390, height: 844 }, observations: [], cleanup: {},
  commands: ['pnpm install --frozen-lockfile --offline', 'pnpm --filter @workshop/board-data build', 'node apps/web/server.mjs <owned-loopback-port>'],
  limitations: ['Source fixture execution only. No installed comparison package was exercised.', 'DOM samples prove intermediate drawer positions. They do not prove decoded comparison-media cadence or normal-speed playback.', 'The app is a self-authored MIT example with local tab state and no external service. This does not prove universal web-app compatibility.'],
};
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const run = (argv, cwd, timeout = 20000) => {
  try {
    const output = execFileSync(argv[0], argv.slice(1), { cwd, encoding: 'utf8', env: childEnvironment, timeout, maxBuffer: 2 * 1024 * 1024 });
    diagnostics.push({ argv, cwd, exitCode: 0, output });
    return output.trim();
  } catch (error) {
    diagnostics.push({ argv, cwd, exitCode: error.status, signal: error.signal, output: `${error.stdout ?? ''}${error.stderr ?? ''}` });
    throw error;
  }
};
const git = (cwd, ...args) => run(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], cwd);
const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
};
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const bounded = async (promise, ms, message) => {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]); }
  finally { clearTimeout(timer); }
};
const stopServer = async () => {
  if (!server) return;
  const current = server;
  if (current.exitCode === null && current.signalCode === null) current.kill('SIGTERM');
  const deadline = Date.now() + 3000;
  while (alive(current.pid) && Date.now() < deadline) await pause(25);
  if (alive(current.pid)) current.kill('SIGKILL');
  const killDeadline = Date.now() + 1000;
  while (alive(current.pid) && Date.now() < killDeadline) await pause(25);
  assert(!alive(current.pid), 'Owned application process must stop.');
  server = undefined;
};
const trackOwnedProcesses = () => {
  const rows = execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8', timeout: 2000 }).split('\n').map((line) => line.trim().match(/^(\d+)\s+(\d+)$/)).filter(Boolean).map((row) => ({ pid: Number(row[1]), ppid: Number(row[2]) }));
  for (let pass = 0; pass < rows.length; pass += 1) for (const row of rows) if (ownedProcessIds.has(row.ppid)) ownedProcessIds.add(row.pid);
};
const watchdog = setTimeout(() => {
  server?.kill('SIGKILL');
  const browserProcess = browserServer?.process();
  if (browserProcess && alive(browserProcess.pid)) browserProcess.kill('SIGKILL');
  process.stderr.write('Public DOM probe exceeded its 120 second hard bound.\n');
  process.exit(124);
}, 120000);

try {
  assert.match(process.version, /^v24\./, 'The public fixture requires Node 24.');
  assert.equal(run(['pnpm', '--version'], scratchRoot), '11.9.0');
  const files = [];
  const collect = (relativePath) => {
    for (const entry of readdirSync(join(sourceRoot, 'fixtures/public-web-app', relativePath), { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name, 'en'))) {
      if (['node_modules', 'dist', '.git', '.show-what-changed'].includes(entry.name)) continue;
      const name = relativePath ? `${relativePath}/${entry.name}` : entry.name;
      if (entry.isDirectory()) collect(name);
      else { assert(entry.isFile(), 'The public input must contain regular files.'); files.push({ path: name, sha256: sha256(readFileSync(join(sourceRoot, 'fixtures/public-web-app', name))) }); }
    }
  };
  collect('');
  fixture = createPublicWebApp(join(scratchRoot, 'workshop'));
  report.sourceIdentity = {
    application: 'Workshop board', origin: 'Self-authored public example with no upstream application.', license: 'MIT',
    licenseSha256: sha256(readFileSync(join(fixture.repoRoot, 'LICENSE'))),
    fixtureFilesSha256: sha256(JSON.stringify(files)), fixtureFiles: files,
    generatorSha256: sha256(readFileSync(join(sourceRoot, 'scripts/create-public-web-app.mjs'))),
    probeSha256: sha256(readFileSync(fileURLToPath(import.meta.url))),
    baseCommit: fixture.baseCommit, headCommit: fixture.headCommit,
    baseTree: git(fixture.repoRoot, 'rev-parse', `${fixture.baseCommit}^{tree}`),
    headTree: git(fixture.repoRoot, 'rev-parse', `${fixture.headCommit}^{tree}`),
    changedPaths: git(fixture.repoRoot, 'diff', '--name-only', fixture.baseCommit, fixture.headCommit).split('\n'),
  };
  report.runtime = { node: process.version, pnpm: '11.9.0', git: run(['git', '--version'], sourceRoot), playwright: requireFromSource('playwright/package.json').version, browser: '' };
  browserServer = await chromium.launchServer({ headless: true, timeout: 10000 });
  ownedProcessIds.add(browserServer.process().pid);
  ownedBrowserProfile = browserServer.process().spawnargs.find((argument) => argument.startsWith('--user-data-dir='))?.slice('--user-data-dir='.length);
  assert(ownedBrowserProfile, 'The owned browser profile must be identifiable for cleanup.');
  browser = await chromium.connect(browserServer.wsEndpoint(), { timeout: 10000 });
  report.runtime.browser = browser.version();
  trackOwnedProcesses();
  const sides = [
    { side: 'before', commit: fixture.baseCommit, expected: fixture.expectedValidation.before },
    { side: 'after', commit: fixture.headCommit, expected: fixture.expectedValidation.after },
  ];
  for (const side of sides) {
    const sideRoot = join(scratchRoot, side.side);
    git(fixture.repoRoot, 'worktree', 'add', '--detach', sideRoot, side.commit);
    sideWorktrees.push(sideRoot);
    const indexBefore = git(sideRoot, 'write-tree');
    const trackedBefore = git(sideRoot, 'diff', '--binary', 'HEAD');
    run(['pnpm', 'install', '--frozen-lockfile', '--offline'], sideRoot, 30000);
    run(['pnpm', '--filter', '@workshop/board-data', 'build'], sideRoot, 15000);
    const sharedPackageBuilt = existsSync(join(sideRoot, 'packages/board-data/dist/index.mjs'));
    assert(sharedPackageBuilt, 'The actual shared package build must exist.');
    const sharedImport = run([process.execPath, '--input-type=module', '-e', 'import { feedback } from "@workshop/board-data"; process.stdout.write(JSON.stringify(feedback));'], join(sideRoot, 'apps/web'));
    assert.deepEqual(JSON.parse(sharedImport), side.expected, 'The nested application must import built shared data.');
    const portReservation = createServer();
    await new Promise((done, reject) => { portReservation.once('error', reject); portReservation.listen(0, '127.0.0.1', done); });
    const port = portReservation.address().port;
    await new Promise((done) => portReservation.close(done));
    server = spawn(process.execPath, ['apps/web/server.mjs', String(port)], { cwd: sideRoot, env: childEnvironment, stdio: ['ignore', 'pipe', 'pipe'] });
    ownedProcessIds.add(server.pid);
    server.stdout.on('data', (value) => diagnostics.push({ side: side.side, stream: 'stdout', value: value.toString() }));
    server.stderr.on('data', (value) => diagnostics.push({ side: side.side, stream: 'stderr', value: value.toString() }));
    server.once('error', (error) => diagnostics.push({ side: side.side, spawnError: error.message }));
    const origin = `http://127.0.0.1:${port}`;
    const readyDeadline = Date.now() + 10000;
    let ready = false;
    while (!ready && Date.now() < readyDeadline) {
      assert(server.exitCode === null && server.signalCode === null, 'The owned fixture server must remain alive.');
      try { const response = await fetch(`${origin}/board`, { signal: AbortSignal.timeout(500) }); ready = response.status === 200; await response.arrayBuffer(); }
      catch {}
      if (!ready) await pause(50);
    }
    assert(ready, 'The actual normal board route must answer HTTP 200.');
    const context = await browser.newContext({ viewport: report.viewport, deviceScaleFactor: 1, reducedMotion: 'no-preference' });
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.goto(`${origin}/board`, { waitUntil: 'networkidle', timeout: 10000 });
    await page.getByRole('heading', { name: 'Workshop board', exact: true }).waitFor({ state: 'visible' });
    assert.equal(await page.locator('body').getAttribute('data-ready'), 'true');
    const startSampling = async () => {
      await page.evaluate(() => {
        const panel = document.querySelector('[data-testid="library-panel"]');
        window.__publicDrawerProbe = { done: false, samples: [] };
        const start = performance.now();
        const sample = (now) => {
          const box = panel.getBoundingClientRect();
          window.__publicDrawerProbe.samples.push({ elapsedMs: Math.round((now - start) * 1000) / 1000, x: Math.round(box.x * 1000) / 1000, y: box.y, width: box.width, height: box.height, open: panel.dataset.open === 'true', visibility: getComputedStyle(panel).visibility });
          if (now - start < 650) requestAnimationFrame(sample);
          else window.__publicDrawerProbe.done = true;
        };
        requestAnimationFrame(sample);
      });
    };
    const finishSampling = async (direction) => {
      await page.waitForFunction(() => window.__publicDrawerProbe.done, null, { timeout: 2000 });
      const samples = await page.evaluate(() => window.__publicDrawerProbe.samples);
      const panelWidth = samples.at(-1).width;
      const openX = report.viewport.width - panelWidth;
      const closedX = report.viewport.width;
      const intermediate = samples.filter((sample) => sample.x > openX + 1 && sample.x < closedX - 1 && sample.visibility === 'visible');
      const distinctPositions = new Set(intermediate.map((sample) => sample.x));
      assert(distinctPositions.size >= 3, `${direction} must expose at least three native intermediate drawer positions.`);
      const expectedFinalX = direction === 'opening' ? openX : closedX;
      assert(Math.abs(samples.at(-1).x - expectedFinalX) <= 1, `${direction} must finish at the native drawer endpoint.`);
      return { direction, openX, closedX, intermediatePositionCount: distinctPositions.size, samples };
    };
    await startSampling();
    await page.getByRole('button', { name: 'Open library', exact: true }).click();
    const opening = await finishSampling('opening');
    const list = page.getByTestId('library-list');
    const scrollBefore = await list.evaluate((element) => ({ scrollTop: element.scrollTop, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight, windowScrollY: window.scrollY }));
    assert.equal(scrollBefore.scrollTop, 0, 'The library list must begin unscrolled.');
    assert(scrollBefore.scrollHeight > scrollBefore.clientHeight, 'The actual inner list must overflow.');
    const listBox = await list.boundingBox();
    assert(listBox, 'The real library list must have a bounding box.');
    await page.mouse.move(listBox.x + listBox.width / 2, listBox.y + listBox.height / 2);
    await page.mouse.wheel(0, 560);
    await page.waitForFunction(() => document.querySelector('[data-testid="library-list"]').scrollTop > 0, null, { timeout: 3000 });
    await page.waitForTimeout(200);
    const scrollAfter = await list.evaluate((element) => ({ scrollTop: element.scrollTop, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight, windowScrollY: window.scrollY }));
    assert(scrollAfter.scrollTop > scrollBefore.scrollTop, 'The actual inner list scrollTop must increase.');
    assert.equal(scrollAfter.windowScrollY, scrollBefore.windowScrollY, 'The window must stay at its original scrollY.');
    await startSampling();
    await page.getByRole('button', { name: 'Close library', exact: true }).click();
    const closing = await finishSampling('closing');
    await page.getByRole('link', { name: 'Propose a task', exact: true }).click();
    await page.getByRole('heading', { name: 'Propose a task', exact: true }).waitFor({ state: 'visible' });
    assert.equal(new URL(page.url()).pathname, '/proposals');
    await page.getByLabel('Task title', { exact: true }).fill('x');
    await page.getByLabel('Contact email', { exact: true }).fill('broken');
    const responsePromise = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/proposals' && response.request().method() === 'POST', { timeout: 5000 });
    await page.getByRole('button', { name: 'Add task', exact: true }).click();
    const invalidResponse = await responsePromise;
    const responseBody = await invalidResponse.json();
    const requestBody = invalidResponse.request().postDataJSON();
    assert.equal(invalidResponse.status(), 422, 'The real invalid form submission must receive HTTP 422.');
    assert.deepEqual(requestBody, { title: 'x', email: 'broken' });
    assert.deepEqual(responseBody.feedback, side.expected);
    assert.deepEqual(responseBody.errors.map((error) => error.field).sort(), ['email', 'title']);
    const feedback = page.getByTestId('proposal-feedback');
    await feedback.waitFor({ state: 'visible' });
    assert.equal(await feedback.getAttribute('role'), 'alert');
    const renderedFeedback = { title: await feedback.locator('h2').innerText(), message: await feedback.locator('p').innerText(), tone: await feedback.getAttribute('data-tone'), errors: await feedback.locator('li').allTextContents(), bounds: await feedback.boundingBox(), titleInvalid: await page.getByLabel('Task title', { exact: true }).getAttribute('aria-invalid'), emailInvalid: await page.getByLabel('Contact email', { exact: true }).getAttribute('aria-invalid'), visible: await feedback.isVisible() };
    assert.deepEqual({ title: renderedFeedback.title, message: renderedFeedback.message, tone: renderedFeedback.tone }, side.expected);
    assert(renderedFeedback.bounds && renderedFeedback.bounds.x >= 0 && renderedFeedback.bounds.y >= 0 && renderedFeedback.bounds.x + renderedFeedback.bounds.width <= report.viewport.width && renderedFeedback.bounds.y + renderedFeedback.bounds.height <= report.viewport.height, 'The actual validation feedback must fit inside the narrow viewport.');
    assert.equal(renderedFeedback.titleInvalid, 'true');
    assert.equal(renderedFeedback.emailInvalid, 'true');
    assert.deepEqual(renderedFeedback.errors, responseBody.errors.map((error) => error.message));
    assert.deepEqual(pageErrors, [], 'The normal fixture flow must have no uncaught page errors.');
    trackOwnedProcesses();
    await context.close();
    await stopServer();
    const preservation = { trackedDiffUnchanged: git(sideRoot, 'diff', '--binary', 'HEAD') === trackedBefore, indexTreeUnchanged: git(sideRoot, 'write-tree') === indexBefore };
    assert(preservation.trackedDiffUnchanged && preservation.indexTreeUnchanged, 'The exact fixture sources and Git index must be preserved.');
    report.observations.push({ side: side.side, commit: side.commit, normalRoutes: ['/board', '/proposals'], setup: { frozenOfflineInstallExit: 0, sharedPackageBuildExit: 0, sharedPackageImport: JSON.parse(sharedImport) }, opening, innerScroll: { observationSource: 'Direct HTMLElement.scrollTop and window.scrollY reads. The app footer was not used for assertions.', input: { kind: 'mouseWheel', deltaY: 560 }, before: scrollBefore, after: scrollAfter }, closing, validation: { method: 'POST', path: '/api/proposals', status: invalidResponse.status(), requestBody, responseBody, renderedFeedback, interceptionUsed: false }, preservation });
  }
} catch (error) {
  failure = error;
  diagnostics.push({ failure: { name: error.name, message: error.message, stack: error.stack } });
  report.failure = { name: error.name, reason: 'The bounded public DOM observation failed. See temporary diagnostics for details.' };
} finally {
  try { await stopServer(); } catch (error) { failure ??= error; report.cleanup.serverError = 'Owned application cleanup failed.'; diagnostics.push({ serverCleanupError: error.message }); }
  try {
    if (browserServer) trackOwnedProcesses();
    if (browser) await bounded(browser.close(), 3000, 'Browser connection close exceeded its bound.');
    if (browserServer) await bounded(browserServer.close(), 3000, 'Owned browser server close exceeded its bound.');
  } catch (error) {
    diagnostics.push({ browserCleanupError: error.message });
    try { if (browserServer) await bounded(browserServer.kill(), 1500, 'Owned browser kill exceeded its bound.'); } catch (killError) { failure ??= killError; }
  }
  for (const worktree of sideWorktrees.reverse()) {
    try { git(fixture.repoRoot, 'worktree', 'remove', '--force', worktree); } catch (error) { failure ??= error; report.cleanup.worktreeError = 'Owned generated worktree cleanup failed.'; diagnostics.push({ worktreeCleanupError: error.message }); }
  }
  if (fixture) report.cleanup.registeredWorktreesBeforeRepositoryRemoval = git(fixture.repoRoot, 'worktree', 'list', '--porcelain').split('\n').filter((line) => line.startsWith('worktree ')).length;
  const deadline = Date.now() + 2000;
  while ([...ownedProcessIds].some(alive) && Date.now() < deadline) await pause(50);
  report.cleanup.ownedProcessCount = ownedProcessIds.size;
  report.cleanup.ownedProcessesRemaining = [...ownedProcessIds].filter(alive).length;
  report.cleanup.sideWorktreesRemoved = sideWorktrees.every((path) => !existsSync(path));
  report.cleanup.browserProfileRemoved = !ownedBrowserProfile || !existsSync(ownedBrowserProfile);
  if (report.cleanup.ownedProcessesRemaining !== 0 || !report.cleanup.sideWorktreesRemoved || !report.cleanup.browserProfileRemoved) failure ??= new Error('Owned runtime resources remain after cleanup.');
  writeFileSync(join(scratchRoot, 'diagnostics.json'), `${JSON.stringify(diagnostics, null, 2)}\n`);
  if (fixture && report.cleanup.ownedProcessesRemaining === 0 && report.cleanup.sideWorktreesRemoved) rmSync(fixture.repoRoot, { recursive: true, force: true });
  report.cleanup.generatedRepositoryRemoved = fixture ? !existsSync(fixture.repoRoot) : true;
  report.passed = !failure;
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  clearTimeout(watchdog);
}
process.stdout.write(`${JSON.stringify({ passed: report.passed, outputPath, diagnosticsPath: join(scratchRoot, 'diagnostics.json'), baseCommit: fixture?.baseCommit, headCommit: fixture?.headCommit, cleanup: report.cleanup })}\n`);
if (failure) process.exitCode = 1;
