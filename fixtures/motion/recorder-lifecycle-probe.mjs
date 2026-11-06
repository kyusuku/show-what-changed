import Module, { registerHooks, createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
const repo = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
const root = pathToFileURL(repo + '/src/').href;
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.startsWith(root) && specifier.startsWith('.') && specifier.endsWith('.js')) {
      const target = new URL(specifier, context.parentURL);
      if (target.href.startsWith(root)) return next(target.href.slice(0, -3) + '.ts', context);
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    const result = next(url, context);
    if (url === root + 'recorder/index.ts')
      return { ...result, source: result.source.toString() + '\nexport { execute as probeExecute, settleFailedSide as probeSettleFailedSide };\n' };
    return result;
  },
});
const require = createRequire(repo + '/package.json');
const { PNG } = require('pngjs');
const { MotionRecorder, reserveCheckpoint, reserveCheckpointStorage, reserveArtifact } = await import(
  root + 'recorder/motion.ts'
);
const { CaptureSettingsSchema } = await import(root + 'schema/index.ts');
const { CaptureFault, sanitizeFrame } = await import(root + 'recorder/images.ts');
const settings = CaptureSettingsSchema.parse({ mode: 'motion', viewport: { width: 320, height: 240 }, maskRects: [] });
function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function until(condition) {
  for (let i = 0; i < 100; i++) {
    if (condition()) return;
    await delay(1);
  }
  throw Error('probe condition did not settle');
}
function harness(overrides = {}) {
  let receiver,
    disposer,
    closes = 0,
    starts = 0,
    stops = 0;
  let transportClosed = false, transportClosing, framesStopped = false;
  const stopFrames = () => { framesStopped = true; };
  const faults = [],
    controller = new AbortController();
  const budget = { count: 0, bytes: 0, rawBytes: 0, sanitizedBytes: 0 };
  const run = {
    runId: '20261103T000000000Z-0000000000000000',
    startedMonotonicMs: performance.now() - 1000,
    deadlineMs: performance.now() + 30000,
    signal: controller.signal,
    diagnostics: { event() {} },
    resources: {
      register(resource) {
        disposer = resource.dispose;
      },
    },
  };
  const transport = {
    metrics: overrides.metrics ?? (async () => ({ metrics: [{ name: 'Timestamp', value: performance.now() / 1000 }] })),
    onFrame(listener) {
      assert(!framesStopped, 'Frame subscription is stopped');
      receiver = listener;
    },
    start: async () => {
      starts++;
      await overrides.start?.();
    },
    stop: async () => {
      stops++;
      await overrides.stop?.();
    },
    acknowledge: async () => {
      if (transportClosed) throw new Error('Transport is closed');
    },
    stopFrames,
    close: () => transportClosing ??= Promise.resolve().then(() => { stopFrames(); transportClosed = true; }),
  };
  const sanitizer = {
    ready: Promise.resolve(),
    onFailure: () => () => {},
    sanitize: overrides.sanitize ?? (async (bytes) => sanitizeFrame(bytes, settings.viewport, [])),
    close: async () => {
      closes++;
      await overrides.close?.();
    },
  };
  const starting = MotionRecorder.fromTransport(
    transport,
    settings,
    run,
    'before',
    'probe',
    budget,
    (code) => {
      faults.push(code);
      overrides.onFault?.(code);
    },
    overrides.persist ?? (async () => {}),
    () => sanitizer,
  );
  function send() {
    assert(!transportClosed, 'Transport is closed');
    assert(!framesStopped, 'Frame subscription is stopped');
    assert(receiver);
    const bytes = PNG.sync.write(new PNG(settings.viewport));
    receiver({
      sessionId: 1,
      data: bytes.toString('base64'),
      metadata: {
        monotonicTimestamp: performance.now() / 1000,
        pageScaleFactor: 1,
        offsetTop: 0,
        deviceWidth: 320,
        deviceHeight: 240,
        scrollOffsetX: 0,
        scrollOffsetY: 0,
      },
    });
    return bytes;
  }
  return {
    starting,
    budget,
    run,
    faults,
    send,
    controller,
    dispose: (deadline) => disposer(deadline),
    get starts() {
      return starts;
    },
    get stops() {
      return stops;
    },
    get closes() {
      return closes;
    },
  };
}
const { probeExecute, probeSettleFailedSide } = await import(root + 'recorder/index.ts');
const results = [];
async function bounded(promise, name, timeoutMs = 150) {
  const controller = new AbortController();
  try {
    const result = await Promise.race([
      promise.then((value) => ({ kind: 'done', value })),
      delay(timeoutMs, undefined, { signal: controller.signal }).then(() => ({ kind: 'timeout' })),
    ]);
    assert.equal(result.kind, 'done', name);
    return result.value;
  } finally { controller.abort(); }
}
{
  const gate = deferred();
  let metrics = 0,
    sampling = false;
  const h = harness({
    metrics: async () => {
      if (++metrics > 5) {
        sampling = true;
        await gate.promise;
      }
      return { metrics: [{ name: 'Timestamp', value: performance.now() / 1000 }] };
    },
  });
  const recorder = await h.starting;
  let markerStatus = 'pending',
    queuedStatus = 'pending';
  const marker = recorder.marker().then(
    () => (markerStatus = 'ok'),
    () => (markerStatus = 'failed'),
  );
  await until(() => sampling);
  const queued = recorder.marker().then(
    () => (queuedStatus = 'ok'),
    () => (queuedStatus = 'failed'),
  );
  h.controller.abort();
  await bounded(recorder.stop(performance.now() + 10), 'aborted stop');
  await bounded(Promise.all([marker, queued]), 'active and queued markers');
  const samplesBeforeLate = recorder.result().clock.samples.length;
  gate.resolve();
  await delay(10);
  results.push({
    probe: 'active and queued marker abort',
    markerStatus,
    queuedStatus,
    faults: [...h.faults],
    samplesBeforeLate,
    samplesAfterLate: recorder.result().clock.samples.length,
  });
  assert.equal(markerStatus, 'failed');
  assert.equal(queuedStatus, 'failed');
  assert.equal(recorder.result().clock.samples.length, samplesBeforeLate);
}
{
  const gate = deferred();
  let metrics = 0,
    finalSample = false;
  const h = harness({
    metrics: async () => {
      if (++metrics > 5) {
        finalSample = true;
        await gate.promise;
      }
      return { metrics: [{ name: 'Timestamp', value: performance.now() / 1000 }] };
    },
  });
  const recorder = await h.starting;
  h.send();
  await until(() => recorder.result().frames.length === 1);
  const stopped = recorder.stop(performance.now() + 10).then(
    () => 'ok',
    () => 'failed',
  );
  await until(() => finalSample);
  const cleanup = await bounded(stopped, 'final clock deadline');
  const samplesBeforeLate = recorder.result().clock.samples.length;
  gate.resolve();
  await delay(10);
  results.push({
    probe: 'hung final clock sample',
    cleanup,
    faults: [...h.faults],
    sanitizerCloseCalls: h.closes,
    rawBytes: h.budget.rawBytes,
    samplesBeforeLate,
    samplesAfterLate: recorder.result().clock.samples.length,
  });
  assert.deepEqual(h.faults, ['CAPTURE_DRAIN_TIMEOUT']);
  assert.equal(recorder.result().clock.samples.length, samplesBeforeLate);
}
{
  const gate = deferred();
  const h = harness({ start: () => gate.promise });
  await until(() => h.starts === 1);
  const stopped = h.dispose(performance.now() + 10).then(
    () => 'ok',
    () => 'failed',
  );
  const recorder = await bounded(h.starting, 'hung start construction');
  const cleanup = await bounded(stopped, 'hung start disposal');
  const stoppedCalls = h.stops;
  gate.resolve();
  await delay(10);
  assert.throws(() => h.send(), /Transport is closed/);
  assert.equal(h.stops, stoppedCalls);
  await delay(10);
  results.push({
    probe: 'hung source start',
    factorySettled: true,
    cleanup,
    sourceStarts: h.starts,
    sourceStops: h.stops,
    sanitizerCloseCalls: h.closes,
    faults: [...h.faults],
    lateFrames: recorder.result().frames.length,
    rawBytes: h.budget.rawBytes,
  });
  assert.equal(cleanup, 'failed');
  assert.equal(recorder.result().frames.length, 0);
  assert.equal(h.budget.rawBytes, 0);
}
{
  const startGate = deferred(),
    stopGate = deferred();
  let stopCalls = 0;
  const h = harness({
    start: () => startGate.promise,
    stop: () => {
      stopCalls++;
      return stopCalls === 1 ? Promise.resolve() : stopGate.promise;
    },
  });
  await until(() => h.starts === 1);
  const stopped = h.dispose(performance.now() + 10).then(
    () => 'ok',
    () => 'failed',
  );
  const recorder = await bounded(h.starting, 'late source start construction');
  const cleanup = await bounded(stopped, 'late source start disposal');
  const stoppedCalls = h.stops;
  startGate.resolve();
  await delay(20);
  assert.throws(() => h.send(), /Transport is closed/);
  assert.equal(h.stops, stoppedCalls);
  await delay(10);
  results.push({
    probe: 'late source start followed by hung stop',
    factorySettled: true,
    cleanup,
    sourceStops: h.stops,
    sanitizerCloseCalls: h.closes,
    faults: [...h.faults],
    lateFrames: recorder.result().frames.length,
  });
  assert.equal(cleanup, 'failed');
  assert.equal(recorder.result().frames.length, 0);
  stopGate.resolve();
}
{
  const gate = deferred();
  let metrics = 0,
    sampling = false,
    state;
  const h = harness({
    metrics: async () => {
      if (++metrics > 5) {
        sampling = true;
        await gate.promise;
      }
      return { metrics: [{ name: 'Timestamp', value: performance.now() / 1000 }] };
    },
    onFault: (code) => {
      state.fault ??= new CaptureFault(code);
      state.faultAtMs ??= performance.now() - h.run.startedMonotonicMs;
      state.wakeFault?.();
    },
  });
  const recorder = await h.starting;
  let executeStatus = 'pending',
    closeCalls = 0;
  state = {
    side: 'before',
    page: {},
    server: { origin: 'http://127.0.0.1:4310' },
    close: async () => {
      closeCalls++;
    },
    failedStep: null,
    safe: null,
    successfulDocument: 'http://127.0.0.1:4310/',
    neutral: Buffer.alloc(0),
    motion: recorder,
    fault: null,
    faultAtMs: null,
    faultMarker: null,
    wakeFault: null,
    disposed: false,
  };
  const step = { id: 'deadline-probe', op: 'screenshot', only: 'both', allowMissing: [], timeoutMs: 10 };
  const executed = probeExecute(state, step, settings, h.run, performance.now() + 1000, h.budget).then(
    (value) => {
      executeStatus = value.status;
      return value;
    },
    (e) => {
      executeStatus = 'rejected';
      return { error: e.code };
    },
  );
  await until(() => sampling);
  await delay(60);
  const value = await bounded(executed, 'execute step failure');
  results.push({
    probe: 'actual execute step timeout while dispatch marker metrics hang',
    executeStatus,
    primaryCode: value.code,
    failedStep: state.failedStep,
    closeCalls,
    sourceStops: h.stops,
    faults: [...h.faults],
    runAborted: h.controller.signal.aborted,
  });
  assert.equal(state.failedStep, 'deadline-probe');
  assert.equal(executeStatus, 'failed');
  assert.equal(value.code, 'STEP_TIMEOUT');
  assert(h.stops > 0);
  assert.equal(closeCalls, 1);
  gate.resolve();
}
{
  const h = harness({ metrics: async () => ({ metrics: [] }) });
  const recorder = await h.starting;
  const originalAt = recorder.result().failureAtMs;
  await delay(5);
  const attemptAt = performance.now() - h.run.startedMonotonicMs;
  let closeCalls = 0;
  const state = {
    side: 'before',
    page: {},
    server: { origin: 'http://127.0.0.1:4310' },
    close: async () => {
      closeCalls++;
    },
    failedStep: null,
    safe: null,
    successfulDocument: null,
    neutral: Buffer.alloc(0),
    motion: recorder,
    fault: new CaptureFault('CAPTURE_CLOCK_UNSUPPORTED'),
    faultAtMs: originalAt,
    faultMarker: Promise.resolve({ kind: 'host', runElapsedMs: originalAt, reason: 'source-clock-unavailable' }),
    wakeFault: null,
    disposed: false,
  };
  const step = { id: 'early-fault', op: 'screenshot', only: 'both', allowMissing: [], timeoutMs: 100 };
  const value = await bounded(
    probeExecute(state, step, settings, h.run, performance.now() + 1000, h.budget),
    'early fault step',
  );
  assert.equal(value.status, 'failed');
  assert(value.timing.failure.runElapsedMs >= attemptAt);
  assert.equal(recorder.result().failureAtMs, originalAt);
  assert.equal(state.faultAtMs, originalAt);
  assert.equal(closeCalls, 1);
  results.push({
    probe: 'pre-scenario fault preserves original time and records fresh failed attempt',
    originalAt,
    attemptAt,
    failureAt: value.timing.failure.runElapsedMs,
    trackFailureAt: recorder.result().failureAtMs,
    closeCalls,
  });
}
{
  const closed = deferred();
  const sanitizing = deferred(), stepFailed = deferred();
  const screenshot = PNG.sync.write(new PNG(settings.viewport));
  let retained,
    closeCalls = 0,
    state;
  const h = harness({
    sanitize: (bytes) => {
      retained = bytes;
      sanitizing.resolve();
      return new Promise(() => {});
    },
    close: async () => {
      await closed.promise;
      retained = undefined;
    },
    onFault: (code) => {
      state.fault ??= new CaptureFault(code);
      state.faultAtMs ??= performance.now() - h.run.startedMonotonicMs;
      state.wakeFault?.();
    },
  });
  const recorder = await h.starting;
  state = {
    side: 'before',
    page: {
      evaluate: async () => {},
      locator: () => ({ count: async () => 0 }),
      waitForTimeout: async () => {},
      screenshot: async () => screenshot,
    },
    server: { origin: 'http://127.0.0.1:4310' },
    close: async () => { closeCalls++; stepFailed.resolve(); },
    failedStep: null,
    safe: null,
    successfulDocument: 'http://127.0.0.1:4310/',
    neutral: Buffer.alloc(0),
    motion: recorder,
    fault: null,
    faultAtMs: null,
    faultMarker: null,
    wakeFault: null,
    disposed: false,
  };
  const step = { id: 'checkpoint-deadline', op: 'screenshot', only: 'both', allowMissing: [], timeoutMs: 1000 };
  const executing = probeExecute(state, step, settings, h.run, performance.now() + 5000, h.budget);
  await bounded(sanitizing.promise, 'checkpoint sanitizer admission', 5000);
  const reserved = h.budget.rawBytes;
  await bounded(stepFailed.promise, 'checkpoint step timeout', 5000);
  const cleanup = await h.dispose(performance.now() + 10).then(() => 'ok', () => 'failed');
  const value = await bounded(executing, 'checkpoint caller after unjoined worker deadline');
  assert.equal(value.status, 'failed');
  assert.equal(value.code, 'STEP_TIMEOUT');
  assert.equal(cleanup, 'failed');
  assert.equal(closeCalls, 1);
  assert.equal(h.budget.rawBytes, reserved);
  assert(retained?.length > 0);
  closed.resolve();
  await until(() => h.budget.rawBytes === 0);
  results.push({
    probe: 'actual checkpoint caller returns while failed cleanup retains worker raw ownership',
    primaryCode: value.code,
    cleanup,
    closeCalls,
    rawRetainedUntilJoin: reserved,
    rawBytesAfterJoin: h.budget.rawBytes,
  });
}
// Exercise the pinned client emitter and production adapter without a browser.
const bundlePath = require.resolve('playwright-core/lib/coreBundle');
const bundle = new Module(bundlePath);
bundle.filename = bundlePath;
bundle.paths = Module._nodeModulePaths(dirname(bundlePath));
bundle._compile(readFileSync(bundlePath, 'utf8') + '\ninit_crConnection(); init_cdpSessionDispatcher(); init_connection(); module.exports.__closureProbe = { CRConnection, CDPSession, CDPSessionDispatcher, Connection, DispatcherConnection, RootDispatcher, createRootSdkObject };', bundlePath);
const { CRConnection, CDPSession, CDPSessionDispatcher, Connection, DispatcherConnection, RootDispatcher, createRootSdkObject } = bundle.exports.__closureProbe;
async function adapterProbe(stage) {
  const commands = [], acknowledgements = [], faults = [];
  const secondMask = deferred(), secondAck = deferred();
  let maskingSecond = false, transport, cutoff = false, metrics = 0;
  const wire = {
    send(message) {
      commands.push(message.method);
      setImmediate(async () => {
        if (message.method === 'Page.screencastFrameAck') {
          if (stage === 'admitted' && message.params.sessionId === 2) await secondAck.promise;
          acknowledgements.push(message.params.sessionId);
        }
        if (message.method === 'Target.detachFromTarget')
          wire.onmessage({ method: 'Target.detachedFromTarget', params: { sessionId: 'capture' } });
        const result = message.method === 'Performance.getMetrics'
          ? { metrics: [{ name: 'Timestamp', value: performance.now() / 1000 }] }
          : {};
        if (message.method === 'Performance.getMetrics') metrics++;
        wire.onmessage({ id: message.id, sessionId: message.sessionId, result });
      });
    },
    close() {},
  };
  const connection = new CRConnection(createRootSdkObject(), wire, () => {}, { recentLogs: () => [] });
  const server = new CDPSession(connection.rootSession, 'capture');
  const clientConnection = new Connection();
  const dispatcherConnection = new DispatcherConnection(true);
  dispatcherConnection.onmessage = (message) => clientConnection.dispatch(message);
  clientConnection.onmessage = (message) => dispatcherConnection.dispatch(message);
  const dispatcher = new RootDispatcher(dispatcherConnection);
  new CDPSessionDispatcher(dispatcher, server);
  const client = clientConnection.getObjectWithKnownName(server.guid);
  dispatcherConnection.onmessage = (message) => setImmediate(() => clientConnection.dispatch(message));
  clientConnection.onmessage = (message) => setImmediate(() => dispatcherConnection.dispatch(message));
  const budget = { count: 0, bytes: 0, rawBytes: 0, sanitizedBytes: 0 };
  const run = {
    runId: '20261103T000000000Z-0000000000000000',
    startedMonotonicMs: performance.now() - 1000,
    deadlineMs: performance.now() + 5000,
    signal: new AbortController().signal,
    diagnostics: { event() {} },
    resources: { register() {} },
  };
  const original = MotionRecorder.fromTransport;
  let sanitized = 0;
  MotionRecorder.fromTransport = (session, ...args) => {
    transport = session;
    const stopFrames = session.stopFrames;
    session.stopFrames = () => { stopFrames(); cutoff = true; };
    args[6] = async () => {};
    args[7] = () => ({
      ready: Promise.resolve(),
      onFailure: () => () => {},
      sanitize: async (bytes) => {
        if (++sanitized === 2 && stage === 'admitted') {
          maskingSecond = true;
          await secondMask.promise;
        }
        return sanitizeFrame(bytes, settings.viewport, []);
      },
      close: async () => {},
    });
    return original.call(MotionRecorder, session, ...args);
  };
  let recorder;
  try {
    recorder = await MotionRecorder.start({ context: () => ({ browser: () => null, newCDPSession: async () => client }) }, settings, run, 'before', 'adapter-probe', budget, (code) => faults.push(code));
  } finally {
    MotionRecorder.fromTransport = original;
  }
  let upstreamEvents = 0;
  client.on('Page.screencastFrame', () => upstreamEvents++);
  const bytes = PNG.sync.write(new PNG(settings.viewport));
  const inject = (sessionId) => wire.onmessage({
    sessionId: 'capture', method: 'Page.screencastFrame', params: {
      sessionId, data: bytes.toString('base64'),
      metadata: { monotonicTimestamp: performance.now() / 1000, pageScaleFactor: 1, offsetTop: 0, deviceWidth: 320, deviceHeight: 240, scrollOffsetX: 0, scrollOffsetY: 0 },
    },
  });
  inject(1);
  await until(() => recorder.result().stats.acknowledgedFrames === 1);
  if (stage === 'admitted') {
    inject(2);
    await until(() => maskingSecond);
    const stopping = recorder.stop();
    await until(() => cutoff);
    assert(metrics >= 6, 'final clock sampling precedes cutoff');
    assert(!commands.includes('Target.detachFromTarget'));
    secondMask.resolve();
    await until(() => commands.filter((method) => method === 'Page.screencastFrameAck').length === 2);
    assert.equal(recorder.result().stats.acknowledgedFrames, 1, 'a sent ACK is not a fulfilled response');
    assert(!commands.includes('Target.detachFromTarget'));
    secondAck.resolve();
    await stopping;
  } else {
    if (stage === 'reentrant') client.prependListener('Page.screencastFrame', () => transport.stopFrames());
    inject(2);
    if (stage === 'upstream-queued') transport.stopFrames();
    await until(() => upstreamEvents === 2);
    await recorder.stop();
  }
  const result = recorder.result();
  const expectedFrames = stage === 'admitted' ? 2 : 1;
  assert.equal(result.frames.length, expectedFrames);
  assert.equal(result.stats.receivedFrames, stage === 'upstream-queued' ? 1 : 2);
  assert.equal(result.stats.persistedFrames, expectedFrames);
  assert.equal(result.stats.acknowledgedFrames, stage === 'upstream-queued' ? 1 : 2);
  assert.equal(result.stats.rejectedFrames, stage === 'reentrant' ? 1 : 0);
  assert.equal(result.status, stage === 'reentrant' ? 'failed' : 'ok');
  assert.deepEqual(faults, stage === 'reentrant' ? ['CAPTURE_DELIVERY_AFTER_CUTOFF'] : []);
  assert.equal(result.stats.sourceDroppedFrames, null);
  assert.equal(sanitized, expectedFrames);
  assert.equal(budget.rawBytes, 0);
  assert.equal(budget.sanitizedBytes, 0);
  transport.stopFrames();
  assert.throws(() => transport.onFrame(() => {}, () => {}), { code: 'CAPTURE_TRANSPORT_CLOSED' });
  assert.strictEqual(transport.close(), transport.close());
  await transport.close();
  assert.equal(commands.filter((method) => method === 'Target.detachFromTarget').length, 1);
  await assert.rejects(transport.acknowledge(1));
  results.push({ probe: 'pinned Playwright adapter subscription closure', stage, playwright: require('playwright-core/package.json').version, status: result.status, stats: result.stats, sanitized, acknowledged: acknowledgements, detachCalls: 1 });
}
for (const stage of ['admitted', 'upstream-queued', 'reentrant']) await adapterProbe(stage);
{
  const source = { kind: 'source', sourceSeconds: 0.0998, runElapsedMs: 99.8, hostBeforeMs: 100.2, hostAfterMs: 100.8, uncertaintyMs: 1.1 };
  let closeCalls = 0;
  const state = { faultAtMs: null, faultMarker: Promise.resolve(source), motion: null, close: async () => { closeCalls++; } };
  const options = { state, attemptStartMs: 100, observedAtMs: 105, operation: null };
  assert.deepEqual(await probeSettleFailedSide(options), source);
  state.faultMarker = Promise.resolve({ ...source, hostBeforeMs: 99.9 });
  state.faultAtMs = 102;
  assert.deepEqual(await probeSettleFailedSide(options), { kind: 'host', runElapsedMs: 102, reason: 'source-clock-unavailable' });
  state.faultAtMs = 90;
  assert.deepEqual(await probeSettleFailedSide(options), { kind: 'host', runElapsedMs: 105, reason: 'source-clock-unavailable' });
  assert.equal(closeCalls, 3);
  results.push({ probe: 'failure fallback uses the actual source host bracket', closeCalls });
}
console.log(JSON.stringify(results, null, 2));
