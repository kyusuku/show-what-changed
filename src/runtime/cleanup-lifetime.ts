import { performance } from 'node:perf_hooks';
import type { RunContext } from '../schema/contracts.js';
import { failure } from '../schema/errors.js';

export class CleanupLifetime {
  private deadlineMs = Infinity;
  get deadline(): number { return this.deadlineMs; }
  private timer: NodeJS.Timeout | undefined;
  private readonly timeout = failure(5, 'CLEANUP_TIMEOUT', 'cleanup', 'Resource cleanup exceeded its deadline.', 'Inspect the remaining owned resources manually.');
  private expire!: (error: Error) => void;
  private readonly expired = new Promise<never>((_, reject) => { this.expire = reject; });
  constructor() { void this.expired.catch(() => {}); }
  begin(deadline: number): number {
    if (deadline < this.deadline) {
      this.deadlineMs = deadline;
      this.finish();
      if (deadline <= performance.now()) this.expire(this.timeout);
      else { this.timer = setTimeout(() => this.expire(this.timeout), deadline - performance.now()); this.timer.unref(); }
    }
    return this.deadline;
  }
  assertRemaining(): void { if (performance.now() >= this.deadline) throw this.timeout; }
  async wait<T>(task: Promise<T>): Promise<T> {
    void task.catch(() => {});
    this.assertRemaining();
    const value = await Promise.race([task, this.expired]);
    this.assertRemaining();
    return value;
  }
  finish(): void { if (this.timer) clearTimeout(this.timer); }
}

const lifetimes = new WeakMap<RunContext, CleanupLifetime>();
export function runCleanupLifetime(run: RunContext): CleanupLifetime {
  let lifetime = lifetimes.get(run);
  if (!lifetime) { lifetime = new CleanupLifetime(); lifetimes.set(run, lifetime); }
  return lifetime;
}
