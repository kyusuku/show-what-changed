import { z } from 'zod';
import { failure } from '../schema/errors.js';
export const DockerCreationIntentsSchema = z.array(z.string().min(1).max(512)).max(32).refine((names) => new Set(names).size === names.length, 'Creation intents must be unique');
export function creationIssued(names: readonly string[], name: string): string[] { return names.includes(name) ? [...names] : [...names, name]; }
export function creationObserved(names: readonly string[], name: string): string[] { return names.filter((entry) => entry !== name); }
export function assertSettledAbsence(names: readonly string[], name: string): void {
  if (names.includes(name)) throw failure(5, 'DOCKER_CREATION_UNCERTAIN', 'cleanup', 'A Docker creation request has no confirmed outcome.', 'Retain this run and retry exact cleanup after the pending request is resolved.');
}
