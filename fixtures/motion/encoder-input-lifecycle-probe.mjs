import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { getEventListeners, once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { performance } from 'node:perf_hooks';
import { Writable } from 'node:stream';
import { setImmediate as immediate } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const sourceRoot = new URL('../../src/', import.meta.url);
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.startsWith(sourceRoot.href) && specifier.startsWith('.') && specifier.endsWith('.js'))
      return next(new URL(specifier.slice(0, -3) + '.ts', context.parentURL).href, context);
    return next(specifier, context);
  },
});
const mode = process.argv[2] ?? 'reachability';
assert.ok(['reachability', 'anchor'].includes(mode));
const entry = process.argv[3] ? pathToFileURL(process.argv[3]) : new URL('composer/process.ts', sourceRoot);
const { writeEncoderFrames } = await import(entry.href);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const identity = {
  node: process.version, platform: process.platform, arch: process.arch, entry: entry.href,
  entrySha256: hash(await readFile(entry)), probeSha256: hash(await readFile(new URL(import.meta.url))),
};
const controller = new AbortController();
const run = { signal: controller.signal, deadlineMs: performance.now() + 10_000 };
const deadline = setTimeout(() => controller.abort(new Error('Probe deadline reached')), 10_000);
try {
  if (mode === 'reachability') await reachability();
  else await anchorExit();
} finally {
  clearTimeout(deadline);
}

async function reachability() {
  assert.equal(typeof global.gc, 'function', 'Run this probe with --expose-gc');
  const count = 16;
  const bytesPerFrame = 4 * 1024 * 1024;
  const refs = [];
  const finalized = new Set();
  const registry = new FinalizationRegistry((id) => finalized.add(id));
  let callbacks = 0;
  const stdin = new Writable({
    highWaterMark: 1,
    autoDestroy: false,
    write(_chunk, _encoding, callback) {
      setImmediate(() => { callbacks++; callback(); });
    },
  });
  const finished = once(stdin, 'finish');
  let resolveExit;
  const exited = new Promise((resolve) => { resolveExit = resolve; });
  let subscriptions = 0;
  const nativeThen = exited.then.bind(exited);
  exited.then = (...args) => { subscriptions++; return nativeThen(...args); };
  let alive = true;
  const child = { stdin, exited, isAlive: () => alive };
  function frame(index) {
    const bytes = Buffer.alloc(bytesPerFrame, index + 1);
    refs.push({ buffer: new WeakRef(bytes), backing: new WeakRef(bytes.buffer) });
    registry.register(bytes, `buffer-${index}`);
    registry.register(bytes.buffer, `backing-${index}`);
    return bytes;
  }
  async function* frames() {
    for (let index = 0; index < count; index++) yield frame(index);
  }
  async function collect() {
    for (let round = 0; round < 12; round++) {
      await immediate();
      global.gc();
      await immediate();
    }
  }
  function observed() {
    return {
      buffers: refs.filter((ref) => ref.buffer.deref() !== undefined).length,
      backingStores: refs.filter((ref) => ref.backing.deref() !== undefined).length,
      finalized: finalized.size,
      completedWriteCallbacks: callbacks,
      pendingStreamBytes: stdin.writableLength,
      errorListeners: stdin.listenerCount('error'), closeListeners: stdin.listenerCount('close'),
      abortListeners: getEventListeners(controller.signal, 'abort').length,
      exitSubscriptions: subscriptions,
      memory: process.memoryUsage(),
    };
  }
  await collect();
  const baseline = process.memoryUsage();
  const operation = writeEncoderFrames(child, frames(), run);
  void operation.catch(() => {});
  try {
    await finished;
    await collect();
    const beforeExit = observed();
    assert.equal(callbacks, count);
    assert.equal(beforeExit.pendingStreamBytes, 0);
    assert.equal(beforeExit.exitSubscriptions, 1);
    assert.equal(beforeExit.buffers, 0);
    assert.equal(beforeExit.backingStores, 0);
    alive = false;
    resolveExit({ code: 0, signal: null, spawnError: null });
    await operation;
    await collect();
    const afterExit = observed();
    assert.equal(afterExit.errorListeners, 0);
    assert.equal(afterExit.closeListeners, 0);
    assert.equal(afterExit.abortListeners, 0);
    console.log(JSON.stringify({ mode, ...identity, count, bytesPerFrame, totalFrameBytes: count * bytesPerFrame, baseline, beforeExit, afterExit }, null, 2));
  } finally {
    controller.abort();
    resolveExit({ code: 0, signal: null, spawnError: null });
    stdin.destroy();
    await operation.catch(() => {});
  }
}

async function anchorExit() {
  const anchorSource = new URL('runtime/process-anchor.ts', sourceRoot);
  const { PROCESS_ANCHOR } = await import(anchorSource.href);
  const anchor = spawn(process.execPath, ['-e', PROCESS_ANCHOR, 'pipe', process.execPath, '-e', 'process.exit(0)'], {
    detached: true, stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  });
  anchor.stdout.resume();
  anchor.stderr.resume();
  anchor.stdin.on('error', () => {});
  const hardStop = setTimeout(() => anchor.kill('SIGKILL'), 5000);
  const closed = new Promise((resolve, reject) => {
    anchor.on('message', (message) => { if (message?.kind === 'closed') resolve(message); });
    anchor.on('error', reject);
  });
  let releaseCallback;
  let writes = 0;
  anchor.stdin.write = (_bytes, callback) => { writes++; releaseCallback = callback; return false; };
  const child = { stdin: anchor.stdin, exited: closed, isAlive: () => anchor.exitCode === null };
  try {
    const operation = writeEncoderFrames(child, [Buffer.alloc(1)], run);
    await assert.rejects(operation, /Encoder exited before input completed/);
    const targetClosed = await closed;
    const result = {
      mode, ...identity, anchorSourceSha256: hash(await readFile(anchorSource)), targetClosed, writes,
      anchorExitCode: anchor.exitCode, anchorSignalCode: anchor.signalCode,
      inputDestroyed: anchor.stdin.destroyed, inputEnded: anchor.stdin.writableEnded,
      callbackWasPending: typeof releaseCallback === 'function',
      abortListeners: getEventListeners(controller.signal, 'abort').length,
    };
    assert.equal(writes, 1);
    assert.equal(result.anchorExitCode, null);
    assert.equal(result.inputDestroyed, false);
    assert.equal(result.inputEnded, false);
    assert.equal(result.abortListeners, 0);
    releaseCallback();
    const exited = once(anchor, 'exit');
    anchor.send({ kind: 'release' });
    await exited;
    console.log(JSON.stringify(result, null, 2));
  } finally {
    clearTimeout(hardStop);
    if (anchor.exitCode === null && anchor.signalCode === null) {
      const exited = once(anchor, 'exit');
      anchor.kill('SIGKILL');
      await exited;
    }
  }
}
