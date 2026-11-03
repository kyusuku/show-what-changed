import type { Config, Scenario, ToolError, Warning } from './index.js';
import { digest, sanitizeText } from './io.js';

export function publicRecipeDigest(config: Config): string {
  return digest({
    schemaVersion: config.schemaVersion,
    captureMode: config.capture.mode,
    execution: {
      kind: config.execution.start.kind,
      state: config.execution.state.kind,
      services: config.execution.services.map((service) => ({ id: service.id, kind: service.kind })),
      inputs: config.execution.inputs.map((input) => ({ id: input.id, content: 'REDACTED' })),
      setup: config.execution.setup.map(() => 'REDACTED'),
      bootstrap: config.execution.bootstrap.map(() => 'REDACTED'),
      requires: config.execution.requires.map(() => 'REDACTED'),
      environment: 'REDACTED', auth: 'REDACTED', operands: 'REDACTED',
    },
  });
}
export function publicScenarioDigest(scenarios: readonly Scenario[]): string {
  return digest(scenarios.map((scenario) => ({
    schemaVersion: scenario.schemaVersion, id: scenario.id,
    steps: scenario.steps.map((step) => ({ id: step.id, op: step.op, only: step.only, allowMissing: step.allowMissing, operands: 'REDACTED' })),
  })));
}
export function publicText(text: string, sensitiveValues: readonly string[] = []): string {
  let safe = sanitizeText(text);
  for (const value of [...sensitiveValues].filter(Boolean).sort((a, b) => b.length - a.length)) safe = safe.split(value).join('[redacted]');
  return safe.replace(/\b(?:https?:\/\/)[^\s]+/g, '[url]').replace(/(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)[^\s]+/g, '[private-path]');
}
export function publicRoute(path: string): string {
  const pathname = path.split(/[?#]/, 1)[0] ?? '/';
  return pathname.startsWith('/') && !pathname.startsWith('//') ? pathname : '/';
}
type PublicGuidance = Pick<ToolError, 'message' | 'hint'>;
const ERROR_GUIDANCE: ReadonlyMap<string, PublicGuidance> = new Map(Object.entries({
  RECIPE_REQUIRED: { message: 'An explicit schema 2 execution recipe is required.', hint: 'Create show-what-changed.config.json or pass --config with execution.start and execution.state.' },
  INVALID_INPUT: { message: 'An input path or document is invalid.', hint: 'Check regular-file paths, JSON syntax, and the packaged schema 2 fields and bounds.' },
  INVALID_DOCUMENT: { message: 'A document does not satisfy schema 2.', hint: 'Validate it against the packaged schema. Version 1 inputs require migration before use.' },
  STALE_PLAN: { message: 'The saved plan no longer matches its bound inputs.', hint: 'Regenerate the plan from the intended source, recipe, scenarios, and helper files.' },
  STALE_SOURCE: { message: 'Source changed while the comparison was preparing.', hint: 'Wait for edits to finish, regenerate the plan, and retry without changing source during the run.' },
  SOURCE_MUTATED: { message: 'An application command changed source inputs.', hint: 'Correct setup or bootstrap. Declare only generated directories that contain no eligible source inputs.' },
  SOURCE_LIMIT: { message: 'Source exceeds a configured or supported size limit.', hint: 'Inspect private plan counts and source settings. Increase configured budgets only within the documented bounds.' },
  GENERATED_DIR_CONFLICT: { message: 'A generated directory covers an existing source input.', hint: 'Remove that declaration. Generated directories may cover only new setup or build outputs.' },
  UNSUPPORTED_SOURCE_LAYOUT: { message: 'The source layout is unsupported.', hint: 'Use a full checkout with regular source files and no unsupported filters, symlinks, submodules, or LFS pointers.' },
  GIT_FAILED: { message: 'Git could not inspect the requested repository or refs.', hint: 'Check the repository and exact refs. Fetch missing refs explicitly before retrying; the tool does not fetch them.' },
  EXECUTION_CONSENT_REQUIRED: { message: 'Execution permission is required for the declared recipe.', hint: 'Review the plan and its side effects, then authorize this invocation with --allow-exec or the interactive prompt.' },
  RUN_ACTIVE: { message: 'The repository or run is still owned by another command.', hint: 'Wait for the owner or inspect with doctor. Do not remove a lock or stop a process based only on a saved PID.' },
  CAPTURE_HASH_MISMATCH: { message: 'Saved capture identity or outcomes do not match this run.', hint: 'Restore the original capture and manifest, or create a new comparison.' },
  TIMELINE_HASH_MISMATCH: { message: 'Saved timeline identity does not match this run.', hint: 'Restore the original timeline and manifest, or create a new comparison.' },
  DEADLINE_EXCEEDED: { message: 'The overall command deadline was reached.', hint: 'Inspect cleanup, simplify the recipe or scenario, or choose a longer supported --timeout.' },
  MISSING_ENVIRONMENT: { message: 'A declared environment reference is missing or invalid.', hint: 'Set every named environment reference to a valid bounded value before retrying.' },
  INVALID_RUNTIME_PATH: { message: 'The declared runtime directory is invalid or unavailable.', hint: 'Set the pathPrependFromEnv variable to one existing absolute executable directory.' },
  PREREQUISITE_MISSING: { message: 'A declared application executable is unavailable.', hint: 'Install the selected application runtime or correct its PATH.' },
  PREREQUISITE_VERSION: { message: 'A declared application prerequisite is incompatible.', hint: 'Select an executable matching the declared expectedVersion range.' },
  SETUP_FAILED: { message: 'A declared setup command failed.', hint: 'Inspect its private diagnostic log and correct the setup recipe.' },
  BOOTSTRAP_FAILED: { message: 'A declared bootstrap command failed.', hint: 'Inspect its private diagnostic log and correct the bootstrap recipe.' },
  SERVER_TIMEOUT: { message: 'The server did not become ready on its assigned port.', hint: 'Check the declared readiness path, status codes, timeout, and assigned loopback port.' },
  SERVER_EXITED: { message: 'An owned server exited before readiness.', hint: 'Inspect the private server log and correct its start command or environment.' },
  READINESS_REDIRECT: { message: 'Readiness redirected outside the owned server origin.', hint: 'Use a local readiness path that does not redirect externally.' },
  NON_LOOPBACK_LISTENER: { message: 'The server bound a wildcard or non-loopback address.', hint: 'Configure the server to bind 127.0.0.1 and honor the assigned port.' },
}));
const PHASE_GUIDANCE: ReadonlyMap<string, PublicGuidance> = new Map(Object.entries({
  arguments: { message: 'The command arguments are invalid.', hint: 'Run --help for supported flags, combinations, and bounds.' },
  planning: { message: 'The comparison could not be planned.', hint: 'Check the source refs, schema 2 recipe, and explicit routes or scenarios, then regenerate the plan.' },
  validating: { message: 'An input or saved artifact failed validation.', hint: 'Check the packaged schemas and original bound inputs. Regenerate a stale plan or create a fresh comparison.' },
  recording: { message: 'A required action or capture condition failed.', hint: 'Inspect the sanitized frames and error code. Correct the app, scenario, masks, or host conditions without making required failures optional.' },
  encoding: { message: 'Media encoding or saved-artifact validation failed.', hint: 'Check FFmpeg with doctor and verify the saved artifacts. Use compose only with an intact completed capture.' },
  cleanup: { message: 'Owned resource cleanup is incomplete.', hint: 'Inspect with doctor. After the owner stops, use clean for the exact run; do not prune unrelated resources.' },
  starting: { message: 'The declared application or service could not become ready.', hint: 'Check declared runtimes, environment references, ports, readiness, and private command diagnostics.' },
}));
export function publicError(error: ToolError): ToolError {
  const guidance = ERROR_GUIDANCE.get(error.code) ?? PHASE_GUIDANCE.get(error.phase) ?? {
    message: 'The operation could not satisfy its recorded requirement.',
    hint: 'Check the command inputs and error code. If it persists, report the code and tool version while keeping private plans and logs local.',
  };
  return {
    code: error.code, phase: error.phase,
    ...(error.side === undefined ? {} : { side: error.side }),
    ...(error.stepId === undefined ? {} : { stepId: error.stepId }),
    ...guidance,
  };
}
export function publicWarning(warning: Warning): Warning {
  return { code: warning.code, message: 'A recorded limitation applies. Review this warning code in the support documentation.' };
}
