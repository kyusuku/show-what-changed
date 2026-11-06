import { spawnSync } from 'node:child_process';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { cpus, freemem, loadavg, tmpdir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CaptureBundleSchema, ResultSchema, ScenarioSchema } from '../dist/schema/index.js';

const candidateHash = '54fdbe6d2b7425b3d1aab34f749e412127adf3b4a18db26835eb0629729ee67b';
const commandIds = ['tar-list', 'install', 'help', 'setup', 'doctor', 'invalid-flag', 'missing-compose', 'plan', 'consent-required', 'compare-success', 'compose-success-without-browser', 'compare-merge-base', 'compare-partial', 'compose-unavailable-encoder', 'compose-recovered-partial', 'compare-worktree', 'readme-plan', 'readme-compare', 'plan-worktree', 'stale-worktree-plan', 'compare-automatic-incomplete'];
const codes = ['INTERNAL_ERROR', 'INVALID_DOCUMENT', 'INVALID_INPUT', 'INCOMPLETE_RUN', 'BROWSER_UNAVAILABLE', 'BROWSER_INSTALL_FAILED', 'BROWSER_INSTALL_UNAVAILABLE', 'CAPTURE_CAPABILITY_UNAVAILABLE', 'CAPTURE_CLOCK_UNSUPPORTED', 'CAPTURE_CANCELLED', 'CAPTURE_DRAIN_TIMEOUT', 'CAPTURE_FRAME_FAILED', 'CAPTURE_NO_FRAMES', 'CAPTURE_QUEUE_OVERFLOW', 'CAPTURE_MEDIA_UNAVAILABLE', 'CAPTURE_INPUT_INVALID', 'CAPTURE_HASH_MISMATCH', 'RENDER_FAILED', 'IMAGE_INVALID', 'MEDIA_VALIDATION_FAILED', 'TIMELINE_HASH_MISMATCH', 'CAPTURE_PNG_INVALID', 'MASK_INVALID', 'MASK_VERIFICATION_FAILED', 'STEP_TIMEOUT', 'SCENARIO_TIMEOUT', 'ACTION_FAILED', 'DOCUMENT_UNAVAILABLE', 'LOCATOR_MISSING', 'LOCATOR_AMBIGUOUS', 'INVALID_LOCATOR_SELECTOR', 'NAVIGATION_ORIGIN', 'NAVIGATION_NO_RESPONSE', 'NAVIGATION_STATUS', 'APPLICATION_ERROR_OVERLAY', 'SCROLL_TIMEOUT', 'EXPECTED_ABSENT', 'SIDE_EXCLUDED', 'PREVIOUS_STEP_FAILED', 'SERVER_EXITED', 'DEADLINE_EXCEEDED', 'CLEANUP_FAILED', 'PROCESS_CLEANUP_FAILED', 'OWNERSHIP_UNCERTAIN', 'OUTPUT_WRITE_FAILED', 'SOURCE_MUTATED', 'WORKSPACE_FAILED'];
const phases = ['validating', 'preparing', 'starting', 'recording', 'rendering', 'encoding', 'cleaning', 'terminal', 'cleanup', 'browser', 'capabilities', 'execution', 'provenance'];
const known = (value, values) => values.includes(value) ? value : null;
const number = (value, max = 1e12) => Number.isFinite(value) && value >= 0 && value <= max ? value : null;
const integer = (value, max = 255) => Number.isInteger(value) ? number(value, max) : null;
const emit = (value) => console.log(JSON.stringify(value));
const fail = () => { throw new Error('DIAGNOSTIC_INPUT_INVALID'); };

async function json(root, relative, maxBytes = 16 * 1024 * 1024) {
  const file = resolve(root, relative);
  if (!file.startsWith(root + '/') || await realpath(file) !== file) fail();
  const info = await lstat(file);
  if (!info.isFile() || info.size > maxBytes) fail();
  const bytes = await readFile(file);
  if (bytes.length > maxBytes) fail();
  return JSON.parse(bytes.toString('utf8'));
}

const errorProjection = (error) => ({ code: known(error?.code, codes), phase: known(error?.phase, phases) });

export async function reportProjection(output) {
  output = await realpath(output);
  const report = await json(output, 'report.json');
  if (report.candidate?.sha256 !== candidateHash || report.candidate?.bytes !== 399133) fail();
  emit({ diagnostic: 'installed-report', status: known(report.status, ['passed', 'failed']), stage: known(report.stage, ['install', 'fixture', 'acceptance', 'demo-copy', 'report']) });
  for (const id of commandIds) {
    let command;
    try { command = await json(output, id + '.json'); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    emit({ diagnostic: 'installed-command', id, exitCode: integer(command.code), signal: known(command.signal, ['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGABRT', 'SIGSEGV', 'SIGHUP', 'SIGPIPE', 'SIGQUIT']), timedOut: command.timedOut === true, overflow: command.overflow === true, elapsedMs: number(command.elapsedMs) });
  }
  const id = known(report.error?.commandName ?? 'compare-success', commandIds);
  if (!id) return;
  const command = await json(output, id + '.json');
  if (typeof command.stdout !== 'string' || Buffer.byteLength(command.stdout) > 16 * 1024 * 1024) fail();
  const envelope = ResultSchema.parse(JSON.parse(command.stdout));
  if (envelope.exitCode !== command.code) fail();
  emit({ diagnostic: 'installed-envelope', id, status: envelope.status, exitCode: envelope.exitCode, error: errorProjection(envelope.error), errors: (envelope.data?.errors ?? []).slice(0, 12).map(errorProjection) });
  if (!['compare-success', 'compare-partial', 'compare-worktree'].includes(id) || !envelope.data?.runId) return;
  const temp = await realpath(tmpdir());
  const root = report.root;
  if (typeof root !== 'string' || !isAbsolute(root) || resolve(root, '..') !== temp || !/^swc-package-[A-Za-z0-9]{6}$/.test(basename(root)) || await realpath(root) !== root || report.fixture?.repoRoot !== join(root, 'app') || report.fixture?.baseRef !== 'fixture-base' || report.fixture?.headRef !== 'fixture-head') fail();
  const fixtureName = id === 'compare-partial' ? 'required-before-failure' : 'pricing';
  const fixture = ScenarioSchema.parse(JSON.parse(await readFile(new URL(`../test/fixtures/scenarios/${fixtureName}.scenario.json`, import.meta.url), 'utf8')));
  const capture = CaptureBundleSchema.parse(await json(root, join('app/.show-what-changed/runs', envelope.data.runId, 'capture.json')));
  if (capture.runId !== envelope.data.runId || capture.captureMode !== 'keyframes' || capture.scenarios.length !== 1) fail();
  const scenario = capture.scenarios[0];
  if (scenario.id !== fixture.id || scenario.steps.length !== fixture.steps.length || scenario.steps.some((step, index) => step.id !== fixture.steps[index].id || step.op !== fixture.steps[index].op)) fail();
  for (const [stepIndex, step] of scenario.steps.entries()) {
    for (const side of ['before', 'after']) {
      const result = step[side];
      emit({ diagnostic: 'installed-capture-step', id, scenarioIndex: 0, stepIndex, side, op: step.op, status: result.status, imageKind: result.imageKind, reasonCode: known(result.reasonCode, codes), elapsedMs: number(result.elapsedMs) });
    }
  }
}

export function resourceProjection(stage) {
  if (!['before-source', 'after-source', 'before-installed', 'after-installed'].includes(stage)) fail();
  const result = spawnSync('ps', ['-axo', 'pid='], { encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 });
  const rows = result.status === 0 ? result.stdout.trim().split('\n').filter((row) => /^\s*\d+\s*$/.test(row)) : [];
  emit({ diagnostic: 'runner-resources', stage, logicalCpus: cpus().length, freeMemoryBytes: freemem(), loadAverage: loadavg().map((value) => number(value)), processCount: result.status === 0 ? rows.length : null });
}

export async function traceProjection(directory) {
  directory = await realpath(directory);
  const names = (await readdir(directory)).filter((name) => /^\d{1,10}\.ndjson$/.test(name)).sort();
  if (names.length > 21) fail();
  const operations = ['goto', 'evaluate', 'waitForTimeout', 'screenshot', 'setContent', 'evaluate-template', 'evaluate-settle', 'evaluate-mask-selectors'];
  const traces = [];
  for (const name of names) {
    const file = join(directory, name);
    if (await realpath(file) !== file || !(await lstat(file)).isFile() || (await lstat(file)).size > 8 * 1024 * 1024) fail();
    const bytes = await readFile(file);
    if (bytes.length > 8 * 1024 * 1024) fail();
    const rows = bytes.toString('utf8').trim().split('\n').map((line) => JSON.parse(line));
    if (rows.length > 12000) fail();
    const start = rows.find((row) => row.event === 'trace-start');
    const timeOrigin = number(start?.timeOrigin, 1e15);
    if (timeOrigin === null) fail();
    traces.push({ rows, timeOrigin });
  }
  traces.sort((left, right) => left.timeOrigin - right.timeOrigin);
  for (const [traceIndex, { rows }] of traces.entries()) {
    const selected = rows.filter((row) => ['operation-start', 'operation-end'].includes(row.event));
    if (!selected.length) continue;
    const resources = rows.filter((row) => row.event === 'resources');
    emit({ diagnostic: 'installed-operation-trace', traceIndex, operationEventCount: selected.length, resourceSampleCount: resources.length, minimumFreeMemoryBytes: resources.length ? Math.min(...resources.map((row) => number(row.freeMemoryBytes) ?? 0)) : null, maximumLoadAverage: [0, 1, 2].map((index) => resources.length ? Math.max(...resources.map((row) => number(row.loadAverage?.[index]) ?? 0)) : null), exitCode: integer(rows.findLast((row) => row.event === 'trace-exit')?.exitCode) });
    for (const row of [...new Set([...selected.slice(0, 60), ...selected.slice(-20)])]) {
      emit({ diagnostic: 'installed-operation', traceIndex, event: row.event, elapsedMs: number(row.elapsedMs), browserIndex: integer(row.browserIndex, 100), contextIndex: integer(row.contextIndex, 100), pageIndex: integer(row.pageIndex, 100), operationIndex: integer(row.operationIndex, 12000), operation: known(row.operation, operations), durationMs: number(row.durationMs), outcome: known(row.outcome, ['ok', 'error']) });
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [mode, value] = process.argv.slice(2);
    if (process.argv.length !== 4) fail();
    if (mode === 'resources') resourceProjection(value);
    else if (mode === 'report') await reportProjection(value);
    else if (mode === 'trace') await traceProjection(value);
    else fail();
  } catch {
    emit({ diagnostic: 'installed-sequence-unavailable', code: 'DIAGNOSTIC_INPUT_INVALID' });
    process.exitCode = 1;
  }
}
