import { Worker } from 'node:worker_threads';
import { z } from 'zod';
import type { RecorderSettings } from '../schema/index.js';
import { CaptureFault } from './images.js';
import { MAX_PNG_BYTES } from '../composer/images.js';
export const SanitizerErrorCode = z.enum(['CAPTURE_PNG_INVALID', 'MASK_INVALID', 'MASK_VERIFICATION_FAILED']);
const WorkerFailureCode = z.enum([
  'CAPTURE_WORKER_PROTOCOL',
  'CAPTURE_WORKER_FAILED',
  'CAPTURE_WORKER_EXIT',
  'CAPTURE_WORKER_STOPPED',
]);
export type WorkerFailure = z.infer<typeof WorkerFailureCode>;
export interface FrameSanitizer {
  ready: Promise<void>;
  onFailure(listener: (code: WorkerFailure) => void): () => void;
  /** Consumes owned raw contents, including when the request fails. */
  sanitize(bytes: Buffer): Promise<Buffer>;
  close(): Promise<void>;
}
const Response = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('ok'),
    id: z.number().int().nonnegative(),
    bytes: z
      .instanceof(Uint8Array)
      .refine(
        (bytes) =>
          bytes.byteLength > 0 &&
          bytes.byteLength <= MAX_PNG_BYTES &&
          bytes.byteOffset === 0 &&
          bytes.buffer.byteLength === bytes.byteLength,
      ),
  }),
  z.strictObject({ kind: z.literal('error'), id: z.number().int().nonnegative(), code: SanitizerErrorCode }),
  z.strictObject({ kind: z.literal('fault'), code: z.literal('CAPTURE_WORKER_PROTOCOL') }),
  z.strictObject({ kind: z.literal('ready') }),
]);
export class MaskWorker implements FrameSanitizer {
  readonly ready: Promise<void>;
  private resolveReady: () => void = () => {};
  private rejectReady: (error: CaptureFault) => void = () => {};
  private readonly worker: Worker;
  private readonly abort: () => void;
  private readonly pending = new Map<
    number,
    { resolve: (bytes: Buffer) => void; reject: (error: CaptureFault) => void }
  >();
  private readonly failures = new Set<(code: WorkerFailure) => void>();
  private state: 'starting' | 'ready' | 'closing' | 'closed' = 'starting';
  private terminalFailure: WorkerFailure | null = null;
  private nextId = 0;
  private termination: Promise<void> | undefined;
  constructor(
    settings: Extract<RecorderSettings, { mode: 'motion' }>,
    private readonly signal: AbortSignal,
  ) {
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    void this.ready.catch(() => {});
    this.abort = () => {
      void this.terminate('CAPTURE_WORKER_STOPPED');
    };
    const source = import.meta.url.endsWith('.ts');
    this.worker = new Worker(new URL(source ? './mask-worker.ts' : './mask-worker.js', import.meta.url), {
      workerData: { viewport: settings.viewport, maskRects: settings.maskRects },
      env: {},
      execArgv: source
        ? ['--experimental-transform-types', '--import', new URL('./source-loader.ts', import.meta.url).href]
        : [],
    });
    this.worker.on('message', (value: unknown) => this.receive(value));
    this.worker.on('error', () => {
      void this.terminate('CAPTURE_WORKER_FAILED');
    });
    this.worker.on('exit', () => {
      if (this.state !== 'closing' && this.state !== 'closed') void this.terminate('CAPTURE_WORKER_EXIT');
    });
    signal.addEventListener('abort', this.abort, { once: true });
    if (signal.aborted) this.abort();
  }
  onFailure(listener: (code: WorkerFailure) => void): () => void {
    this.failures.add(listener);
    if (this.terminalFailure) listener(this.terminalFailure);
    return () => this.failures.delete(listener);
  }
  private receive(value: unknown): void {
    if (this.state === 'closing' || this.state === 'closed') return;
    const parsed = Response.safeParse(value);
    if (!parsed.success) {
      void this.terminate('CAPTURE_WORKER_PROTOCOL');
      return;
    }
    const response = parsed.data;
    if (response.kind === 'ready') {
      if (this.state !== 'starting') {
        void this.terminate('CAPTURE_WORKER_PROTOCOL');
        return;
      }
      this.state = 'ready';
      this.resolveReady();
      return;
    }
    if (this.state !== 'ready') {
      void this.terminate('CAPTURE_WORKER_PROTOCOL');
      return;
    }
    if (response.kind === 'fault') {
      void this.terminate(response.code);
      return;
    }
    const pending = this.pending.get(response.id);
    if (!pending) {
      void this.terminate('CAPTURE_WORKER_PROTOCOL');
      return;
    }
    this.pending.delete(response.id);
    if (response.kind === 'error') pending.reject(new CaptureFault(response.code));
    else pending.resolve(Buffer.from(response.bytes.buffer, response.bytes.byteOffset, response.bytes.byteLength));
  }
  sanitize(bytes: Buffer): Promise<Buffer> {
    if (this.state !== 'ready') return Promise.reject(new CaptureFault('CAPTURE_WORKER_STOPPED'));
    if (bytes.length > MAX_PNG_BYTES) return Promise.reject(new CaptureFault('CAPTURE_PNG_INVALID'));
    if (this.pending.size >= 3) return Promise.reject(new CaptureFault('CAPTURE_WORKER_QUEUE_LIMIT'));
    const id = this.nextId++;
    const input = Uint8Array.from(bytes);
    return new Promise<Buffer>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.worker.postMessage({ id, bytes: input }, [input.buffer]);
      } catch {
        void this.terminate('CAPTURE_WORKER_FAILED');
      }
    });
  }
  private terminate(code?: WorkerFailure): Promise<void> {
    if (code && !this.terminalFailure && this.state !== 'closing' && this.state !== 'closed') {
      this.terminalFailure = code;
      for (const listener of this.failures) listener(code);
    }
    if (this.termination) return this.termination;
    this.state = 'closing';
    this.signal.removeEventListener('abort', this.abort);
    const error = new CaptureFault(code ?? 'CAPTURE_WORKER_STOPPED');
    this.rejectReady(error);
    this.termination = this.worker.terminate().then(() => {
      this.state = 'closed';
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    });
    return this.termination;
  }
  close(): Promise<void> {
    return this.terminate();
  }
}
