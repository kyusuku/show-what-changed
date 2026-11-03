import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const [project, output] = process.argv.slice(2);
const require = createRequire(join(project, 'package.json'));
const { chromium } = require('playwright');
const browserMetadata = JSON.parse(readFileSync(join(dirname(require.resolve('playwright-core/package.json')), 'browsers.json'), 'utf8')).browsers;
assert.equal(require('playwright/package.json').version, '1.64.1');
assert.equal(browserMetadata.find((browser) => browser.name === 'chromium').revision, '1248');
assert.notEqual(process.getuid(), 0);
const server = await chromium.launchServer({ headless: true, chromiumSandbox: true });
try {
  const launchArguments = server.process().spawnargs;
  assert(!launchArguments.includes('--no-sandbox'));
  const browser = await chromium.connect(server.wsEndpoint());
  assert.equal(browser.version(), '156.0.8078.4');
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  await page.setContent('<!doctype html><h1>Sandboxed Linux Chromium gate</h1>');
  assert.equal(await page.locator('h1').textContent(), 'Sandboxed Linux Chromium gate');
  const processLines = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' }).trim().split('\n');
  const renderers = processLines.filter((line) => /\/chrome[^ ]* .*--type=renderer\b/.test(line)).map((line) => {
    const pid = Number(line.trim().split(/\s+/)[0]);
    const status = readFileSync(`/proc/${pid}/status`, 'utf8');
    return { pid, userNamespace: readlinkSync(`/proc/${pid}/ns/user`), seccomp: Number(/^Seccomp:\s*(\d+)/m.exec(status)?.[1]), noNewPrivileges: Number(/^NoNewPrivs:\s*(\d+)/m.exec(status)?.[1]) };
  });
  assert(renderers.length > 0, 'A real renderer process must be running.');
  assert(renderers.every((renderer) => renderer.seccomp === 2 && renderer.noNewPrivileges === 1));
  const proof = { platform: `${process.platform}-${process.arch}`, uid: process.getuid(), playwright: '1.64.1', chromium: browser.version(), revision: '1248', chromiumSandbox: true, noSandboxArgument: false, callerUserNamespace: readlinkSync('/proc/self/ns/user'), renderers, launchArguments };
  writeFileSync(output, JSON.stringify(proof, null, 2) + '\n');
  console.log(JSON.stringify(proof));
  await context.close();
  await browser.close();
} finally {
  await server.close();
}
