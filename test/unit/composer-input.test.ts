import { getEventListeners } from 'node:events';
import { performance } from 'node:perf_hooks';
import { Writable } from 'node:stream';
import { setImmediate as turn } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeEncoderFrames } from '../../src/composer/process.js';
import type { OwnedProcess, ProcessExit, RunContext } from '../../src/schema/contracts.js';
import { failure } from '../../src/schema/errors.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose();
  vi.restoreAllMocks();
});

function harness(automatic = false) {
  const controller = new AbortController();
  const terminal = deferred<ProcessExit>();
  const subscriptions = vi.spyOn(terminal.promise, 'then');
  let alive = true;
  let acknowledge: ((error?: Error | null) => void) | null = null;
  const writes: number[] = [];
  const stdin = new Writable({
    highWaterMark: 1,
    autoDestroy: false,
    write(chunk: Buffer, _encoding, callback) {
      writes.push(chunk[0] ?? -1);
      acknowledge = callback;
      if (automatic) setImmediate(() => release());
    },
  });
  const supervisorError = vi.fn();
  stdin.on('error', supervisorError);
  const child: OwnedProcess = {
    id: 'encoder', pid: 123, groupId: 123, stdin, exited: terminal.promise,
    isAlive: () => alive,
    output: () => ({ stdout: '', stderr: '', truncated: false }),
  };
  const run: RunContext = {
    runId: 'encoder-input-test',
    paths: { repoRoot: '', runDir: '', privateDir: '', tempDir: '', framesDir: '', composedDir: '' },
    startedAt: '', startedMonotonicMs: performance.now(), deadlineMs: performance.now() + 60_000,
    signal: controller.signal,
    diagnostics: { event() {} },
    resources: { register() {}, async disposeAll() { throw new Error('Unused'); } },
    supervisor: {
      async spawn() { throw new Error('Unused'); }, async adopt() { throw new Error('Unused'); },
      async stop() { throw new Error('Unused'); }, async stopAll() { throw new Error('Unused'); },
    },
    redactions: { add() {}, text: (value) => value },
  };
  function release(error?: Error) {
    const callback = acknowledge;
    acknowledge = null;
    callback?.(error);
  }
  function exit(result: ProcessExit = { code: 0, signal: null, spawnError: null }) {
    alive = false;
    terminal.resolve(result);
  }
  function start(frames: Iterable<Buffer> | AsyncIterable<Buffer>, context = run) {
    const operation = writeEncoderFrames(child, frames, context);
    void operation.catch(() => {});
    return operation;
  }
  function disposed() {
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    expect(stdin.listeners('error')).toEqual([supervisorError]);
    expect(stdin.listenerCount('close')).toBe(0);
  }
  cleanup.push(() => { controller.abort(); release(); exit(); stdin.destroy(); });
  return { controller, terminal, subscriptions, stdin, child, run, writes, release, exit, start, disposed };
}

describe('encoder input lifetime', () => {
  it('keeps one process observer across completed writes while the encoder stays alive', async () => {
    const h = harness(true);
    const produced = deferred<void>();
    async function* frames() {
      for (let index = 0; index < 16; index++) yield Buffer.alloc(4, index);
      produced.resolve();
    }
    const operation = h.start(frames());
    await produced.promise;
    await turn();
    try {
      expect(h.writes).toHaveLength(16);
      expect(h.stdin.writableLength).toBe(0);
      expect(h.subscriptions).toHaveBeenCalledTimes(1);
    } finally {
      h.exit();
      await operation;
    }
    h.disposed();
  });

  it('preserves the run cancellation reason during a pending write', async () => {
    const h = harness();
    const operation = h.start([Buffer.alloc(4)]);
    await turn();
    const reason = failure(143, 'SIGTERM', 'execution', 'The run received SIGTERM.', 'Retry.');
    h.controller.abort(reason);
    await expect(operation).rejects.toBe(reason);
    h.disposed();
  });

  it('waits for each real callback before requesting another frame or sending EOF', async () => {
    const h = harness();
    let requested = 0;
    async function* frames() {
      for (let value = 1; value <= 2; value++) {
        requested++;
        yield Buffer.alloc(4, value);
      }
    }
    const operation = h.start(frames());
    let completed = false;
    void operation.then(() => { completed = true; });
    await turn();
    expect(requested).toBe(1);
    expect(h.writes).toEqual([1]);
    expect(h.stdin.writableLength).toBe(4);
    expect(h.stdin.writableNeedDrain).toBe(true);
    await turn();
    expect(requested).toBe(1);
    expect(h.stdin.writableEnded).toBe(false);
    h.release();
    await turn();
    expect(requested).toBe(2);
    expect(h.writes).toEqual([1, 2]);
    expect(h.stdin.writableEnded).toBe(false);
    h.release();
    await turn();
    expect(h.stdin.writableEnded).toBe(true);
    expect(completed).toBe(false);
    h.exit();
    await operation;
    expect(completed).toBe(true);
    h.disposed();
  });

  it.each([
    failure(130, 'SIGINT', 'execution', 'The run received SIGINT.', 'Retry.'),
    failure(10, 'DEADLINE_EXCEEDED', 'execution', 'The run deadline was reached.', 'Retry.'),
  ])('preserves cancellation before production and while waiting for exit', async (reason) => {
    const before = harness();
    before.controller.abort(reason);
    const produce = vi.fn(function* () { yield Buffer.alloc(4); });
    await expect(before.start({ [Symbol.iterator]: produce })).rejects.toBe(reason);
    expect(produce).not.toHaveBeenCalled();
    expect(before.writes).toHaveLength(0);
    before.disposed();

    const ending = harness(true);
    const operation = ending.start([Buffer.alloc(4)]);
    await turn();
    await turn();
    expect(ending.stdin.writableEnded).toBe(true);
    ending.controller.abort(reason);
    await expect(operation).rejects.toBe(reason);
    ending.disposed();
  });

  it('rejects an elapsed deadline before producing a frame', async () => {
    const h = harness();
    const produce = vi.fn(function* () { yield Buffer.alloc(4); });
    await expect(h.start({ [Symbol.iterator]: produce }, { ...h.run, deadlineMs: performance.now() - 1 }))
      .rejects.toMatchObject({ detail: { code: 'DEADLINE_EXCEEDED' } });
    expect(produce).not.toHaveBeenCalled();
    h.disposed();
  });

  it.each(['write', 'end'] as const)('handles a synchronous %s throw and removes its listeners', async (method) => {
    const h = harness(true);
    const error = new Error(`synchronous ${method} failure`);
    vi.spyOn(h.stdin, method).mockImplementation(() => { throw error; });
    await expect(h.start([Buffer.alloc(4)])).rejects.toBe(error);
    h.disposed();
  });

  it('preserves a callback failure and closes the producer', async () => {
    const h = harness();
    let closed = false;
    async function* frames() {
      try {
        yield Buffer.alloc(4, 1);
        yield Buffer.alloc(4, 2);
      } finally { closed = true; }
    }
    const operation = h.start(frames());
    await turn();
    const error = new Error('write callback failure');
    h.release(error);
    await expect(operation).rejects.toBe(error);
    expect(h.writes).toEqual([1]);
    expect(closed).toBe(true);
    h.exit();
    await turn();
    h.disposed();
  });

  it.each(['error', 'close'] as const)('rejects a stream %s during a pending write', async (event) => {
    const h = harness();
    const operation = h.start([Buffer.alloc(4), Buffer.alloc(4)]);
    await turn();
    const error = new Error('stream input failure');
    if (event === 'error') h.stdin.emit('error', error);
    else h.stdin.destroy();
    if (event === 'error') await expect(operation).rejects.toBe(error);
    else await expect(operation).rejects.toThrow('Encoder input closed early');
    expect(h.writes).toHaveLength(1);
    h.disposed();
  });

  it.each([
    { code: 0, signal: null, spawnError: null },
    { code: 2, signal: null, spawnError: null },
    { code: null, signal: 'SIGTERM', spawnError: null },
    { code: null, signal: null, spawnError: 'spawn failed' },
  ] satisfies ProcessExit[])('rejects a target exit during a write while the anchor pipe stays open %j', async (exit) => {
    const h = harness();
    const operation = h.start([Buffer.alloc(4), Buffer.alloc(4)]);
    await turn();
    h.exit(exit);
    await expect(operation).rejects.toThrow(/Encoder/);
    expect(h.stdin.destroyed).toBe(false);
    expect(h.stdin.writableEnded).toBe(false);
    h.release();
    await turn();
    expect(h.writes).toHaveLength(1);
    h.disposed();
  });

  it('rejects process observation failure during a write without waiting for stream close', async () => {
    const h = harness();
    const operation = h.start([Buffer.alloc(4)]);
    await turn();
    const error = new Error('process observation failed');
    h.terminal.reject(error);
    await expect(operation).rejects.toBe(error);
    expect(h.stdin.destroyed).toBe(false);
    h.disposed();
  });

  it.each([
    { code: 1, signal: null, spawnError: null },
    { code: null, signal: 'SIGKILL', spawnError: null },
    { code: 0, signal: null, spawnError: 'spawn failed' },
  ] satisfies ProcessExit[])('rejects an unsuccessful final process result %j', async (result) => {
    const h = harness(true);
    const operation = h.start([Buffer.alloc(4)]);
    await turn();
    await turn();
    expect(h.stdin.writableEnded).toBe(true);
    h.exit(result);
    await expect(operation).rejects.toThrow('Encoder did not complete successfully');
    h.disposed();
  });

  it('accepts stream close after the final callback when process success follows', async () => {
    const h = harness(true);
    const operation = h.start([Buffer.alloc(4)]);
    await turn();
    await turn();
    h.stdin.destroy();
    await turn();
    h.exit();
    await operation;
    h.disposed();
  });

  it.each([false, true])('accepts successful final exit before EOF with closed input %s', async (closedInput) => {
    const h = harness();
    const resume = deferred<void>();
    let exhausted = false;
    async function* frames() {
      yield Buffer.alloc(4);
      await resume.promise;
      exhausted = true;
    }
    const operation = h.start(frames());
    await turn();
    h.release();
    await turn();
    expect(h.stdin.writableEnded).toBe(false);
    expect(exhausted).toBe(false);
    if (closedInput) h.stdin.destroy();
    h.exit();
    await turn();
    resume.resolve();
    await operation;
    expect(exhausted).toBe(true);
    if (!closedInput) expect(h.stdin.writableEnded).toBe(true);
    h.disposed();
  });

  it.each(['abort', 'error', 'close', 'exit', 'rejection'] as const)('remembers %s between writes and refuses the next frame', async (event) => {
    const h = harness();
    const resume = deferred<void>();
    let closed = false;
    async function* frames() {
      try {
        yield Buffer.alloc(4, 1);
        await resume.promise;
        yield Buffer.alloc(4, 2);
      } finally { closed = true; }
    }
    const operation = h.start(frames());
    await turn();
    h.release();
    await turn();
    const error = failure(130, 'SIGINT', 'execution', 'The run received SIGINT.', 'Retry.');
    if (event === 'abort') h.controller.abort(error);
    if (event === 'error') h.stdin.emit('error', error);
    if (event === 'close') h.stdin.destroy();
    if (event === 'exit') h.exit();
    if (event === 'rejection') h.terminal.reject(error);
    await turn();
    resume.resolve();
    if (event === 'close' || event === 'exit') await expect(operation).rejects.toThrow('Encoder input closed early');
    else await expect(operation).rejects.toBe(error);
    expect(h.writes).toEqual([1]);
    expect(closed).toBe(true);
    h.disposed();
  });

  it('keeps the first failure through late callbacks, cancellation, process success, and iterator return failure', async () => {
    const h = harness();
    const returned = vi.fn(async () => { throw new Error('iterator close failure'); });
    const iterator = {
      async next(): Promise<IteratorResult<Buffer>> { return { done: false, value: Buffer.alloc(4) }; },
      return: returned,
      [Symbol.asyncIterator]() { return this; },
    };
    const operation = h.start(iterator);
    await turn();
    const error = new Error('first stream failure');
    h.stdin.emit('error', error);
    h.controller.abort();
    h.exit();
    h.release();
    await expect(operation).rejects.toBe(error);
    expect(returned).toHaveBeenCalledTimes(1);
    h.disposed();
  });

  it('propagates producer failure after disposing listeners without sending EOF', async () => {
    const h = harness(true);
    const error = new Error('frame production failure');
    let closed = false;
    async function* frames() {
      try {
        yield Buffer.alloc(4);
        throw error;
      } finally { closed = true; }
    }
    await expect(h.start(frames())).rejects.toBe(error);
    expect(closed).toBe(true);
    expect(h.stdin.writableEnded).toBe(false);
    h.disposed();
    h.terminal.reject(new Error('late process rejection'));
    await turn();
    h.disposed();
  });

  it('keeps a failure seen while awaiting production even if the producer also fails', async () => {
    const h = harness();
    const resume = deferred<void>();
    async function* frames() {
      yield Buffer.alloc(4);
      await resume.promise;
      throw new Error('later producer failure');
    }
    const operation = h.start(frames());
    await turn();
    h.release();
    await turn();
    const error = new Error('first stream failure');
    h.stdin.emit('error', error);
    resume.resolve();
    await expect(operation).rejects.toBe(error);
    h.disposed();
  });

  it('fails before writing when stdin is missing, destroyed, ended, or the process is no longer alive', async () => {
    const missing = harness();
    await expect(writeEncoderFrames({ ...missing.child, stdin: null }, [Buffer.alloc(4)], missing.run))
      .rejects.toThrow('Encoder input unavailable');
    missing.disposed();
    for (const state of ['destroyed', 'ended', 'exited'] as const) {
      const h = harness();
      if (state === 'destroyed') h.stdin.destroy();
      if (state === 'ended') h.stdin.end();
      if (state === 'exited') h.exit();
      await expect(h.start([Buffer.alloc(4)])).rejects.toThrow('Encoder input closed early');
      expect(h.writes).toHaveLength(0);
      h.disposed();
    }
  });

});
