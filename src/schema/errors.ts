import type { ToolError } from './index.js';
import { sanitizeText } from './io.js';

export type FailureExit = 1 | 2 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 130 | 143;
export class ToolFailure extends Error {
  readonly detail: ToolError;
  constructor(readonly exitCode: FailureExit, detail: ToolError, options?: ErrorOptions) {
    super(sanitizeText(detail.message), options);
    this.name = 'ToolFailure';
    this.detail = { ...detail, message: sanitizeText(detail.message), hint: sanitizeText(detail.hint) };
  }
}
export function failure(exitCode: FailureExit, code: string, phase: string, message: string, hint: string): ToolFailure {
  return new ToolFailure(exitCode, { code, phase, message, hint });
}
export function cancellation(signal: AbortSignal): ToolFailure | null {
  if (!signal.aborted) return null;
  if (signal.reason instanceof ToolFailure) return signal.reason;
  return failure(10, 'CANCELLED', 'execution', 'The run was cancelled.', 'Run the command again when ready.');
}
export function checkCancelled(signal: AbortSignal): void {
  const error = cancellation(signal);
  if (error) throw error;
}
