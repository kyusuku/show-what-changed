const commandIds = ['tar-list', 'install', 'help', 'setup', 'doctor', 'invalid-flag', 'missing-compose', 'plan', 'consent-required', 'compare-success', 'compose-success-without-browser', 'compare-merge-base', 'compare-partial', 'compose-unavailable-encoder', 'compose-recovered-partial', 'compare-worktree', 'readme-plan', 'readme-compare', 'plan-worktree', 'stale-worktree-plan', 'compare-automatic-incomplete'];
const stages = ['install', 'fixture', 'acceptance', 'demo-copy', 'report'];
const validationStages = ['process', 'evidence', 'json', 'schema', 'envelope-exit', 'complete'];
const codes = ['INTERNAL_ERROR', 'INVALID_DOCUMENT', 'INVALID_INPUT', 'INCOMPLETE_RUN', 'BROWSER_UNAVAILABLE', 'BROWSER_INSTALL_FAILED', 'BROWSER_INSTALL_UNAVAILABLE', 'CAPTURE_CAPABILITY_UNAVAILABLE', 'CAPTURE_CLOCK_UNSUPPORTED', 'CAPTURE_CANCELLED', 'CAPTURE_DRAIN_TIMEOUT', 'CAPTURE_FRAME_FAILED', 'CAPTURE_NO_FRAMES', 'CAPTURE_QUEUE_OVERFLOW', 'STEP_TIMEOUT', 'ACTION_FAILED', 'SERVER_EXITED', 'DEADLINE_EXCEEDED', 'CLEANUP_FAILED', 'PROCESS_CLEANUP_FAILED', 'OWNERSHIP_UNCERTAIN', 'OUTPUT_WRITE_FAILED', 'SOURCE_MUTATED', 'WORKSPACE_FAILED'];
const phases = ['validating', 'preparing', 'starting', 'recording', 'rendering', 'encoding', 'cleaning', 'terminal', 'cleanup', 'browser', 'capabilities', 'execution', 'provenance'];
const known = (value, allowed) => allowed.includes(value) ? value : null;
const integer = (value, maximum = 255) => Number.isInteger(value) && value >= 0 && value <= maximum ? value : null;
const identifiers = (detail) => ({ code: known(detail?.code, codes), phase: known(detail?.phase, phases) });

function diagnosis(result, schemas) {
  try {
    if (typeof result?.stdout !== 'string' || result.stdout.length > 16 * 1024 * 1024 || Buffer.byteLength(result.stdout) > 16 * 1024 * 1024) return null;
    const envelope = schemas.ResultSchema.parse(JSON.parse(result.stdout));
    if (envelope.exitCode !== result.code) return null;
    return {
      status: known(envelope.status, ['ok', 'partial', 'failed', 'nothing', 'cancelled']), exitCode: integer(envelope.exitCode),
      runId: typeof envelope.data?.runId === 'string' && /^\d{8}T\d{9}Z-[a-f0-9]{16}$/.test(envelope.data.runId) ? envelope.data.runId : null,
      ...identifiers(envelope.error), errors: (envelope.data?.errors ?? []).slice(0, 8).map(identifiers),
    };
  } catch { return null; }
}

function assertionSite(error) {
  if (error?.code !== 'ERR_ASSERTION' || typeof error.stack !== 'string') return null;
  for (const file of ['release-smoke.mjs', 'release-harness.mjs']) {
    const url = new URL(file, import.meta.url).href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const frame = new RegExp(`^\\s+at (?:[^()\\n]* \\()?${url}:(\\d{1,6}):(\\d{1,6})\\)?$`);
    for (const line of error.stack.split('\n').slice(1, 30)) {
      const match = frame.exec(line);
      if (match && Number(match[1]) > 0 && Number(match[2]) > 0) return { file: `scripts/${file}`, line: Number(match[1]), column: Number(match[2]) };
    }
  }
  return null;
}

export function releaseFailureSummary(report, schemas) {
  const last = report.commands?.at(-1);
  const failure = report.error;
  const name = failure?.commandName ?? last?.name;
  const result = failure?.commandName === undefined ? undefined : failure.command;
  const command = name === undefined ? null : {
    id: known(name, commandIds), context: failure?.commandName === undefined ? 'last-command' : 'failed-command',
    validationStage: known(failure?.validationStage ?? last?.validationStage, validationStages),
    expectedExit: integer(last?.name === name ? last.code : ['tar-list', 'install'].includes(name) ? 0 : null),
    actualExit: integer(result ? result.code : last?.actualExit),
    signal: known(result ? result.signal : last?.signal, ['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGABRT', 'SIGSEGV', 'SIGHUP', 'SIGPIPE', 'SIGQUIT']),
    timedOut: (result ? result.timedOut : last?.timedOut) === true, overflow: (result ? result.overflow : last?.overflow) === true,
  };
  return { status: 'failed', code: 'RELEASE_SMOKE_FAILED', stage: known(report.stage, stages), command, diagnosis: diagnosis(result, schemas), assertionSite: assertionSite(failure) };
}
