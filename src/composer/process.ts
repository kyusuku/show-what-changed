import { performance } from 'node:perf_hooks';
import type { Writable } from 'node:stream';
import type { OwnedProcess, ProcessExit, RunContext } from '../schema/contracts.js';
import { cancellation, checkCancelled, failure } from '../schema/errors.js';

export function remainingMs(run: RunContext, maximum = 30_000): number {
  checkCancelled(run.signal);
  const remaining = run.deadlineMs - performance.now();
  if (remaining <= 0) throw failure(10, 'DEADLINE_EXCEEDED', 'execution', 'The run deadline was reached.', 'Increase the bounded timeout or simplify the scenario.');
  return Math.max(1, Math.min(maximum, remaining));
}

export async function command(run: RunContext, argv: readonly string[]): Promise<string> {
  const child = await run.supervisor.spawn({ argv, cwd: run.paths.runDir, purpose: 'probe', captureStdout: true, timeoutMs: remainingMs(run) });
  const exit = await child.exited;
  checkCancelled(run.signal);
  if (exit.code !== 0 || exit.signal || exit.spawnError) throw new Error('Media command failed');
  const output = child.output();
  if (output.truncated) throw new Error('Media command output exceeded the diagnostic limit');
  return output.stdout;
}

type EncoderTerminal =
  | { kind: 'running' }
  | { kind: 'exited'; exit: ProcessExit }
  | { kind: 'failed'; error: unknown };

type EncoderOperation =
  | { kind: 'idle' | 'disposed' }
  | { kind: 'writing' | 'ending'; resolve: () => void; reject: (error: unknown) => void };

export async function writeEncoderFrames(
  child: OwnedProcess,
  frames: Iterable<Buffer> | AsyncIterable<Buffer>,
  run: RunContext,
): Promise<void> {
  if (!child.stdin) throw new Error('Encoder input unavailable');
  const session = new EncoderInputSession(child, child.stdin, run);
  try {
    session.check();
    await consumeEncoderFrames(session, frames);
    await session.complete();
  } catch (error) {
    throw session.fail(error);
  } finally {
    session.dispose();
  }
}

async function consumeEncoderFrames(
  session: EncoderInputSession,
  frames: Iterable<Buffer> | AsyncIterable<Buffer>,
): Promise<void> {
  for await (const bytes of frames) await session.write(bytes);
}

class EncoderInputSession {
  #terminal: EncoderTerminal = { kind: 'running' };
  #operation: EncoderOperation = { kind: 'idle' };
  #source: { child: OwnedProcess; stdin: Writable; run: RunContext } | null;

  constructor(child: OwnedProcess, stdin: Writable, run: RunContext) {
    this.#source = { child, stdin, run };
    stdin.on('error', this.#onError);
    stdin.on('close', this.#onClose);
    run.signal.addEventListener('abort', this.#onAbort);
    void child.exited.then(
      (exit) => this.#onExit(exit),
      (error: unknown) => { this.fail(error); },
    );
    this.#onAbort();
  }

  check(): void {
    if (this.#terminal.kind === 'failed') throw this.#terminal.error;
    if (!this.#source) throw new Error('Encoder input disposed');
    remainingMs(this.#source.run);
  }

  write(bytes: Buffer): Promise<void> {
    this.check();
    const source = this.#source;
    if (!source || this.#terminal.kind === 'exited' || source.stdin.destroyed || source.stdin.writableEnded || !source.child.isAlive())
      throw this.fail(new Error('Encoder input closed early'));
    return new Promise<void>((resolve, reject) => {
      const operation: EncoderOperation = { kind: 'writing', resolve, reject };
      this.#operation = operation;
      try {
        source.stdin.write(bytes, (error) => {
          if (this.#operation !== operation) return;
          if (error) this.fail(error);
          else this.#resolve();
        });
      } catch (error) {
        this.fail(error);
      }
    });
  }

  async complete(): Promise<void> {
    this.check();
    const source = this.#source;
    if (!source) throw new Error('Encoder input disposed');
    await new Promise<void>((resolve, reject) => {
      this.#operation = { kind: 'ending', resolve, reject };
      try {
        if (!source.stdin.destroyed && !source.stdin.writableEnded) source.stdin.end();
        if (this.#terminal.kind === 'exited') this.#resolve();
      } catch (error) {
        this.fail(error);
      }
    });
    this.check();
  }

  fail(error: unknown): unknown {
    if (this.#operation.kind === 'disposed') return error;
    if (this.#terminal.kind !== 'failed') this.#terminal = { kind: 'failed', error };
    const operation = this.#operation;
    this.#operation = { kind: 'idle' };
    if (operation.kind === 'writing' || operation.kind === 'ending') operation.reject(this.#terminal.error);
    return this.#terminal.error;
  }

  dispose(): void {
    const source = this.#source;
    if (!source) return;
    source.stdin.off('error', this.#onError);
    source.stdin.off('close', this.#onClose);
    source.run.signal.removeEventListener('abort', this.#onAbort);
    this.#source = null;
    this.#operation = { kind: 'disposed' };
    this.#terminal = { kind: 'running' };
  }

  #resolve(): void {
    const operation = this.#operation;
    this.#operation = { kind: 'idle' };
    if (operation.kind === 'writing' || operation.kind === 'ending') operation.resolve();
  }

  #onAbort = (): void => {
    if (!this.#source) return;
    const error = cancellation(this.#source.run.signal);
    if (error) this.fail(error);
  };

  #onError = (error: Error): void => { this.fail(error); };

  #onClose = (): void => {
    if (this.#operation.kind === 'writing') this.fail(new Error('Encoder input closed early'));
  };

  #onExit(exit: ProcessExit): void {
    if (this.#operation.kind === 'disposed' || this.#terminal.kind === 'failed') return;
    if (exit.code !== 0 || exit.signal || exit.spawnError) {
      this.fail(new Error('Encoder did not complete successfully'));
    } else if (this.#operation.kind === 'writing') {
      this.fail(new Error('Encoder exited before input completed'));
    } else {
      this.#terminal = { kind: 'exited', exit };
      if (this.#operation.kind === 'ending') this.#resolve();
    }
  }
}
