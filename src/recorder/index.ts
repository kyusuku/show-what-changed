import type { Browser, Page } from 'playwright';
import { CaptureBundleSchema, ScenarioSchema, CaptureSettingsSchema, TOOL_VERSION } from '../schema/index.js';
import type {
  CaptureBundle,
  Artifact,
  CapturedStep,
  MotionScenario,
  Scenario,
  Side,
  SideResult,
  Step,
  Warning,
} from '../schema/index.js';
import type { RecorderSettings, RunContext, Server, ServerPair } from '../schema/contracts.js';
import { checkCancelled, cancellation, failure, ToolFailure } from '../schema/errors.js';
import { sha256, sanitizeText } from '../schema/io.js';
import { openBrowser } from '../runtime/browser.js';
import { writeRunFile, readRunFile, hasCode } from '../runtime/files.js';
import { performAction, settle } from './actions.js';
import { CaptureFault, CAPTURE_STYLE, changeRatio, maskedFrame, neutralFrame } from './images.js';
import {
  MotionRecorder,
  reserveArtifact,
  reserveCheckpoint,
  reserveCheckpointStorage,
  releaseCheckpointStorage,
  releaseArtifact,
} from './motion.js';
import type { CaptureBudget } from './motion.js';
import { publicRoute } from '../schema/public.js';

type SafeFrame = { bytes: Buffer; stepId: string };
type SideState = {
  side: Side;
  page: Page;
  server: Server;
  close: () => Promise<void>;
  failedStep: string | null;
  safe: SafeFrame | null;
  successfulDocument: string | null;
  neutral: Buffer;
  motion: MotionRecorder | null;
  fault: CaptureFault | null;
  faultAtMs: number | null;
  faultMarker: Promise<Extract<MotionScenario['steps'][number]['before'], { kind: 'failed' }>['failure']> | null;
  wakeFault: (() => void) | null;
  disposed: boolean;
};

function text(value: string): string {
  return [...sanitizeText(value)].slice(0, 160).join('');
}

function caption(step: Step): string {
  if (step.note !== undefined) return text(step.note);
  const labels: Record<Step['op'], string> = {
    goto: 'Open route',
    click: 'Click control',
    fill: 'Fill input',
    hover: 'Hover control',
    scrollBy: 'Scroll page',
    expectVisible: 'Check visible state',
    screenshot: 'Capture state',
  };
  return labels[step.op];
}

function faultCode(error: unknown): string {
  if (error instanceof CaptureFault) return error.code;
  if (error instanceof Error && error.message.includes('strict mode violation')) return 'LOCATOR_AMBIGUOUS';
  if (error instanceof Error && error.message.includes('Timeout')) return 'STEP_TIMEOUT';
  return 'ACTION_FAILED';
}

async function createSide(
  browser: Browser,
  server: Server,
  settings: RecorderSettings,
  run: RunContext,
  neutral: Buffer,
): Promise<SideState> {
  const context = await browser.newContext({
    viewport: settings.viewport,
    deviceScaleFactor: 1,
    locale: 'en-US',
    timezoneId: 'UTC',
    colorScheme: 'light',
    reducedMotion: settings.mode === 'motion' ? 'no-preference' : 'reduce',
    serviceWorkers: 'block',
    acceptDownloads: false,
    ...(server.storageState ? { storageState: structuredClone(server.storageState) } : {}),
  });
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      if (!browser.isConnected()) return;
      try {
        await context.close();
      } catch (error) {
        if (browser.isConnected()) throw error;
      }
    })();
    return closing;
  };
  run.resources.register({ kind: 'context', identity: `record-${server.side}-${crypto.randomUUID()}`, dispose: close });
  const page = await context.newPage();
  const state: SideState = {
    side: server.side,
    page,
    server,
    close,
    failedStep: null,
    safe: null,
    successfulDocument: null,
    neutral,
    motion: null,
    fault: null,
    faultAtMs: null,
    faultMarker: null,
    wakeFault: null,
    disposed: false,
  };
  const fail = (code: string) => {
    if (state.disposed || state.failedStep !== null) return;
    state.fault ??= new CaptureFault(code);
    state.faultAtMs ??= performance.now() - run.startedMonotonicMs;
    state.faultMarker ??= state.motion
      ? state.motion.marker().catch(() => ({
          kind: 'host' as const,
          runElapsedMs: state.faultAtMs ?? performance.now() - run.startedMonotonicMs,
          reason: 'source-clock-unavailable' as const,
        }))
      : Promise.resolve({
          kind: 'host' as const,
          runElapsedMs: state.faultAtMs,
          reason: 'source-clock-unavailable' as const,
        });
    state.wakeFault?.();
  };
  await context.route('**/*', async (route) => {
    const request = route.request();
    try {
      if (request.isNavigationRequest()) {
        let mainFrame: boolean;
        try {
          mainFrame = request.frame() === page.mainFrame();
        } catch {
          fail('UNSUPPORTED_POPUP');
          await route.abort();
          return;
        }
        if (mainFrame && new URL(request.url()).origin !== server.origin) {
          fail('NAVIGATION_ORIGIN');
          await route.abort();
          return;
        }
      }
      await route.continue();
    } catch {
      if (!state.disposed && !state.failedStep) fail('NAVIGATION_FAILED');
    }
  });
  page.on('response', (response) => {
    const request = response.request();
    if (!request.isNavigationRequest()) return;
    try {
      if (request.frame() !== page.mainFrame()) return;
      const url = new URL(response.url());
      if (url.origin !== server.origin) {
        fail('NAVIGATION_ORIGIN');
        return;
      }
      if (response.status() < 200 || response.status() >= 400) {
        fail('NAVIGATION_STATUS');
        return;
      }
      state.successfulDocument = `${url.origin}${url.pathname}${url.search}`;
    } catch {
      fail('NAVIGATION_FAILED');
    }
  });
  page.on('requestfailed', (request) => {
    if (!request.isNavigationRequest()) return;
    try {
      if (request.frame() === page.mainFrame()) fail('NAVIGATION_FAILED');
    } catch {
      fail('UNSUPPORTED_POPUP');
    }
  });
  page.on('framenavigated', (frame) => {
    if (frame !== page.mainFrame()) return;
    try {
      const url = new URL(frame.url());
      if (url.origin !== server.origin) {
        fail('NAVIGATION_ORIGIN');
        return;
      }
      if (state.successfulDocument !== null && state.fault === null)
        state.successfulDocument = `${url.origin}${url.pathname}${url.search}`;
    } catch {
      fail('NAVIGATION_ORIGIN');
    }
  });
  context.on('page', (extra) => {
    fail('UNSUPPORTED_POPUP');
    void extra.close().catch(() => {});
  });
  page.on('dialog', (dialog) => {
    fail('UNSUPPORTED_DIALOG');
    void dialog.dismiss().catch(() => {});
  });
  page.on('download', (download) => {
    fail('UNSUPPORTED_DOWNLOAD');
    void download.cancel().catch(() => {});
  });
  page.on('filechooser', () => {
    fail('UNSUPPORTED_FILE_CHOOSER');
  });
  page.on('pageerror', () => {
    fail('PAGE_ERROR');
  });
  page.on('crash', () => {
    fail('PAGE_CRASH');
  });
  let warningCount = 0;
  page.on('console', (message) => {
    if (message.type() === 'warning' && warningCount++ < 20)
      run.diagnostics.event(`Browser console warning on ${server.side}.`);
    if (settings.fixedTime !== null && message.type() === 'error') {
      void Promise.all(
        message.args().map(async (argument) => {
          try {
            return await argument.evaluate((value: unknown) => value instanceof Error);
          } catch {
            return false;
          }
        }),
      )
        .then((errors) => {
          if (errors.some(Boolean)) fail('PAGE_ERROR');
        })
        .catch(() => {});
    }
  });
  void server.exited.then(() => {
    fail('SERVER_EXITED');
  });
  if (settings.fixedTime !== null) await page.clock.setFixedTime(new Date(settings.fixedTime));
  if (settings.mode === 'keyframes')
    await page.addInitScript((style) => {
      const apply = () => {
        const element = document.createElement('style');
        element.textContent = style;
        (document.head ?? document.documentElement).append(element);
      };
      if (document.documentElement) apply();
      else document.addEventListener('DOMContentLoaded', apply, { once: true });
    }, CAPTURE_STYLE);
  return state;
}

type Timing = MotionScenario['steps'][number]['before'];
type Execution = {
  status: SideResult['status'];
  code: string | null;
  bytes: Buffer;
  held: string | null;
  elapsedMs: number;
  timing: Timing;
};
const elapsed = (run: RunContext): number => performance.now() - run.startedMonotonicMs;
async function settleFailedSide(options: {
  state: SideState;
  attemptStartMs: number;
  observedAtMs: number;
  operation: Promise<never> | null;
}): Promise<Extract<Timing, { kind: 'failed' }>['failure']> {
  const { state } = options;
  const original = state.faultAtMs ?? options.observedAtMs;
  const fallback = {
    kind: 'host' as const,
    runElapsedMs: original >= options.attemptStartMs ? original : options.observedAtMs,
    reason: 'source-clock-unavailable' as const,
  };
  const candidate = state.faultMarker ?? (state.motion ? state.motion.marker() : Promise.resolve(fallback));
  const stopping = state.motion?.stop();
  if (stopping) void stopping.catch(() => {});
  const closing = (state.motion ? state.motion.contextMayClose() : Promise.resolve())
    .then(() => state.close())
    .catch(() => {});
  let marker: Extract<Timing, { kind: 'failed' }>['failure'];
  try {
    marker = options.operation ? await Promise.race([candidate, options.operation]) : await candidate;
    if (marker.runElapsedMs < options.attemptStartMs) marker = fallback;
  } catch {
    marker = fallback;
  }
  await closing;
  return marker;
}

async function execute(
  state: SideState,
  step: Step,
  settings: RecorderSettings,
  run: RunContext,
  scenarioDeadline: number,
  budget: CaptureBudget,
): Promise<Execution> {
  const started = performance.now();
  const held = () => ({
    bytes: state.safe?.bytes ?? state.neutral,
    held: state.safe?.stepId ?? null,
    elapsedMs: performance.now() - started,
  });
  if (state.failedStep !== null)
    return {
      status: 'blocked',
      code: 'PREVIOUS_STEP_FAILED',
      ...held(),
      timing: { kind: 'blocked', atMs: elapsed(run) },
    };
  if (step.only !== 'both' && step.only !== state.side)
    return {
      status: 'skipped_by_side',
      code: 'SIDE_EXCLUDED',
      ...held(),
      timing: { kind: 'excluded', atMs: elapsed(run) },
    };
  checkCancelled(run.signal);
  const actionDeadline = Math.min(scenarioDeadline, started + (step.timeoutMs ?? settings.stepTimeoutMs));
  const deadline = Math.min(run.deadlineMs, actionDeadline);
  let dispatch: Extract<Timing, { kind: 'executed' }>['dispatch'] | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectInterrupt: ((error: unknown) => void) | undefined;
  const abort = () =>
    rejectInterrupt?.(
      cancellation(run.signal) ??
        failure(
          10,
          'DEADLINE_EXCEEDED',
          'execution',
          'The overall run deadline was reached.',
          'Increase the bounded timeout or simplify the scenario.',
        ),
    );
  const interrupted = new Promise<never>((_resolve, reject) => {
    rejectInterrupt = reject;
    state.wakeFault = () => reject(state.fault ?? new CaptureFault('ACTION_FAILED'));
    timer = setTimeout(
      () =>
        reject(
          run.deadlineMs <= actionDeadline
            ? (cancellation(run.signal) ??
                failure(
                  10,
                  'DEADLINE_EXCEEDED',
                  'execution',
                  'The overall run deadline was reached.',
                  'Increase the bounded timeout or simplify the scenario.',
                ))
            : new CaptureFault(performance.now() >= scenarioDeadline ? 'SCENARIO_TIMEOUT' : 'STEP_TIMEOUT'),
        ),
      Math.max(1, deadline - performance.now()),
    );
    run.signal.addEventListener('abort', abort, { once: true });
  });
  const action = (async (): Promise<Execution> => {
    if (state.fault) throw state.fault;
    if (step.op !== 'goto' && state.successfulDocument === null) throw new CaptureFault('DOCUMENT_UNAVAILABLE');
    if (state.motion) dispatch = await state.motion.marker();
    const result = await performAction({
      page: state.page,
      step,
      origin: state.server.origin,
      deadline,
      successfulDocument: state.successfulDocument,
    });
    if (result.kind === 'missing') {
      if (!step.allowMissing.includes(state.side)) throw new CaptureFault('LOCATOR_MISSING');
      const completion = state.motion ? await state.motion.marker() : null;
      return {
        status: 'expected_absent',
        code: 'EXPECTED_ABSENT',
        ...held(),
        timing:
          dispatch && completion
            ? { kind: 'executed', dispatch, completion, observationEnd: completion }
            : { kind: 'excluded', atMs: elapsed(run) },
      };
    }
    if (step.op === 'goto') state.successfulDocument = result.successfulDocument;
    const completion = state.motion ? await state.motion.marker() : null;
    await settle(state.page);
    await state.page.waitForTimeout(step.observeMs ?? settings.observeMs);
    const observationEnd = state.motion ? await state.motion.marker() : null;
    if (state.fault) throw state.fault;
    let bytes: Buffer;
    if (settings.mode === 'keyframes')
      bytes = await maskedFrame(state.page, settings.maskSelectors, deadline - performance.now(), settings.viewport);
    else {
      const releaseRaw = await reserveCheckpoint(budget, settings, run, deadline);
      let sanitizerOwnsRaw = false;
      try {
        let raw = await state.page.screenshot({
          type: 'png',
          fullPage: false,
          animations: 'allow',
          scale: 'css',
          timeout: Math.max(1, deadline - performance.now()),
        });
        if (raw.length > 16 * 1024 ** 2) throw new CaptureFault('CAPTURE_PNG_INVALID');
        if (!state.motion) throw new CaptureFault('CAPTURE_WORKER_UNAVAILABLE');
        sanitizerOwnsRaw = true;
        const sanitized = state.motion.sanitizeCheckpoint(raw, releaseRaw);
        raw = Buffer.alloc(0);
        bytes = await sanitized;
      } finally {
        if (!sanitizerOwnsRaw) releaseRaw();
      }
    }
    if (state.fault) throw state.fault;
    if (performance.now() >= deadline) throw new CaptureFault('STEP_TIMEOUT');
    state.safe = { bytes, stepId: step.id };
    return {
      status: 'ok',
      code: null,
      bytes,
      held: null,
      elapsedMs: performance.now() - started,
      timing:
        dispatch && completion && observationEnd
          ? { kind: 'executed', dispatch, completion, observationEnd }
          : { kind: 'excluded', atMs: elapsed(run) },
    };
  })();
  try {
    return await Promise.race([action, interrupted]);
  } catch (error) {
    const primaryCode = faultCode(state.fault ?? error);
    state.failedStep = step.id;
    const failureMarker = await settleFailedSide({
      state,
      attemptStartMs: started - run.startedMonotonicMs,
      observedAtMs: elapsed(run),
      operation: interrupted,
    });
    await action.catch(() => {});
    if (error instanceof ToolFailure) throw error;
    checkCancelled(run.signal);
    return {
      status: 'failed',
      code: primaryCode,
      ...held(),
      timing: { kind: 'failed', dispatch, failure: failureMarker },
    };
  } finally {
    if (timer) clearTimeout(timer);
    run.signal.removeEventListener('abort', abort);
    state.wakeFault = null;
  }
}

export async function capture(
  servers: ServerPair,
  scenarios: readonly Scenario[],
  input: RecorderSettings,
  run: RunContext,
): Promise<CaptureBundle> {
  const normalized = scenarios.map((scenario) => ScenarioSchema.parse(scenario));
  if (
    normalized.length < 1 ||
    normalized.length > 3 ||
    new Set(normalized.map((scenario) => scenario.id)).size !== normalized.length
  )
    throw failure(
      2,
      'INVALID_SCENARIOS',
      'recording',
      'Capture requires one to three unique scenarios.',
      'Regenerate the plan with valid inputs.',
    );
  const settings = CaptureSettingsSchema.parse(input);
  const budget: CaptureBudget = { count: 0, bytes: 0, rawBytes: 0, sanitizedBytes: 0 };
  const warnings: Warning[] = [];
  if (
    normalized.some((scenario) =>
      scenario.steps.some((step) => 'target' in step && step.target && 'css' in step.target),
    )
  )
    warnings.push({
      code: 'CSS_LOCATOR',
      message: 'CSS locators are used. Prefer exact accessible locators when available.',
    });
  const neutral = neutralFrame(settings.viewport);
  const browser = await openBrowser(run);
  const captured: CaptureBundle['scenarios'] = [];
  const motion: MotionScenario[] = [];
  let frameIndex = 0;
  try {
    reserveCheckpointStorage(
      budget,
      normalized.reduce((count, scenario) => count + scenario.steps.length * 2, 0),
    );
    for (const scenario of normalized) {
      checkCancelled(run.signal);
      const states = await Promise.all([
        createSide(browser, servers.before, settings, run, neutral),
        createSide(browser, servers.after, settings, run, neutral),
      ]);
      const [before, after] = states;
      if (!before || !after) throw new Error('Incomplete side pair');
      if (settings.mode === 'motion')
        await Promise.all(
          states.map(async (state) => {
            state.motion = await MotionRecorder.start(
              state.page,
              settings,
              run,
              state.side,
              scenario.id,
              budget,
              (code) => {
                state.fault ??= new CaptureFault(code);
                state.faultAtMs ??= elapsed(run);
                state.wakeFault?.();
              },
            );
          }),
        );
      const startMs = elapsed(run);
      const scenarioDeadline = performance.now() + settings.maxScenarioMs;
      const steps: CapturedStep[] = [];
      const timingSteps: MotionScenario['steps'] = [];
      const comparisons: CapturedStep[] = [];
      let endMs = startMs;
      try {
        for (const step of scenario.steps) {
          const barrierMs = Math.max(startMs, elapsed(run) - 2);
          const [left, right] = await Promise.all([
            execute(before, step, settings, run, scenarioDeadline, budget),
            execute(after, step, settings, run, scenarioDeadline, budget),
          ]);
          checkCancelled(run.signal);
          for (const [state, result] of [
            [before, left],
            [after, right],
          ] as const)
            if (state.fault && !state.failedStep) {
              state.failedStep = step.id;
              result.status = 'failed';
              result.code = state.fault.code;
              result.held = state.safe?.stepId ?? null;
              result.timing = {
                kind: 'failed',
                dispatch: result.timing.kind === 'executed' ? result.timing.dispatch : null,
                failure: await settleFailedSide({
                  state,
                  attemptStartMs: barrierMs,
                  observedAtMs: elapsed(run),
                  operation: null,
                }),
              };
              await state.motion?.stop();
              await state.close().catch(() => {});
            }
          const prefix = String(frameIndex++).padStart(3, '0');
          const persist = async (side: Side, result: Execution): Promise<SideResult> => {
            const path = `frames/${prefix}-${side}.png`;
            reserveArtifact(budget, result.bytes.length, 'checkpoint');
            try {
              await writeRunFile(run, path, result.bytes);
            } catch (error) {
              try {
                await readRunFile(run.paths.runDir, path, 16 * 1024 ** 2);
              } catch (inspect) {
                if (hasCode(inspect, 'ENOENT')) releaseArtifact(budget, result.bytes.length);
              }
              throw error;
            }
            const image: Artifact = { path, sha256: sha256(result.bytes), bytes: result.bytes.length };
            const imageKind = result.status === 'ok' ? 'checkpoint' : result.held ? 'held' : 'neutral';
            return {
              status: result.status,
              reasonCode: result.code,
              image,
              imageKind,
              heldFromStepId: result.held,
              elapsedMs: result.elapsedMs,
              sanitization:
                imageKind === 'neutral'
                  ? { kind: 'neutral' }
                  : settings.mode === 'motion'
                    ? { kind: 'rectangles', maskDigest: sha256(JSON.stringify(settings.maskRects)) }
                    : { kind: 'selectors', selectorCount: settings.maskSelectors.length },
            };
          };
          const pair = await Promise.all([persist('before', left), persist('after', right)]);
          if (!pair[0] || !pair[1]) throw new Error('Incomplete checkpoints');
          const capturedStep: CapturedStep = {
            id: step.id,
            op: step.op,
            caption: text(run.redactions.text(caption(step))),
            observeMs: step.observeMs ?? settings.observeMs,
            before: pair[0],
            after: pair[1],
            changeRatio: null,
          };
          steps.push(capturedStep);
          if (left.status === 'ok' && right.status === 'ok') comparisons.push(capturedStep);
          const firstTime = (value: Timing): number =>
            value.kind === 'executed'
              ? value.dispatch.runElapsedMs
              : value.kind === 'failed'
                ? (value.dispatch?.runElapsedMs ?? value.failure.runElapsedMs)
                : value.atMs;
          timingSteps.push({
            id: step.id,
            barrierMs: Math.min(barrierMs, firstTime(left.timing), firstTime(right.timing)),
            before: left.timing,
            after: right.timing,
          });
        }
      } finally {
        const actionsEndMs = elapsed(run);
        await Promise.all(states.map((state) => state.motion?.stop().catch(() => {})));
        endMs =
          settings.mode === 'motion'
            ? Math.max(actionsEndMs, ...states.map((state) => state.motion?.captureEndMs() ?? elapsed(run)))
            : elapsed(run);
        for (const state of states) state.disposed = true;
        await Promise.all(states.map((state) => state.close().catch(() => {})));
      }
      for (const step of comparisons) {
        const before = await readRunFile(run.paths.runDir, step.before.image.path, 16 * 1024 ** 2);
        const after = await readRunFile(run.paths.runDir, step.after.image.path, 16 * 1024 ** 2);
        if (sha256(before) !== step.before.image.sha256 || sha256(after) !== step.after.image.sha256)
          throw new CaptureFault('CAPTURE_CHECKPOINT_CHANGED');
        step.changeRatio = changeRatio(before, after);
      }
      const errors = states.flatMap((state) => {
        const track = state.motion?.result();
        return track?.status === 'failed' ? [track.error] : [];
      });
      const initial = scenario.steps[0];
      if (!initial || initial.op !== 'goto') throw new Error('Missing initial route');
      captured.push({
        id: scenario.id,
        title: text(run.redactions.text(scenario.title)),
        initialRoute: publicRoute(initial.path),
        outcome:
          errors.length ||
          steps.some((step) =>
            [step.before, step.after].some((side) => side.status === 'failed' || side.status === 'blocked'),
          )
            ? 'partial'
            : 'ok',
        errors,
        steps,
      });
      if (before.motion && after.motion) {
        const annotations: MotionScenario['annotations'] = [];
        for (let i = 0; i < steps.length; i++) {
          const step = steps[i];
          const timing = timingSteps[i];
          if (!step || !timing) continue;
          const next = timingSteps[i + 1]?.barrierMs ?? endMs;
          for (const side of ['before', 'after'] as const) {
            const value = timing[side];
            const status = step[side].status;
            const at =
              value.kind === 'executed'
                ? value.observationEnd.runElapsedMs
                : value.kind === 'failed'
                  ? value.failure.runElapsedMs
                  : value.atMs;
            if (status !== 'ok')
              annotations.push({
                side,
                stepId: step.id,
                kind: status,
                startMs: Math.max(startMs, Math.min(at, endMs)),
                endMs: Math.max(startMs, Math.min(next, endMs)),
              });
            else if (at < next)
              annotations.push({ side, stepId: step.id, kind: 'waiting', startMs: Math.max(startMs, at), endMs: next });
          }
        }
        motion.push({
          id: scenario.id,
          startMs,
          endMs,
          tracks: { before: before.motion.result(), after: after.motion.result() },
          steps: timingSteps,
          annotations,
        });
      }
    }
    const common = {
      schemaVersion: 2,
      runId: run.runId,
      toolVersion: TOOL_VERSION,
      browserVersion: browser.version(),
      viewport: { ...settings.viewport, deviceScaleFactor: 1 },
      sources: { before: servers.before.source, after: servers.after.source },
      labels: {
        before: text(run.redactions.text(servers.before.sourceLabel)),
        after: text(run.redactions.text(servers.after.sourceLabel)),
      },
      scenarios: captured,
      warnings,
    };
    const bundle = CaptureBundleSchema.parse(
      settings.mode === 'motion'
        ? {
            ...common,
            captureMode: 'motion',
            settings: { fixedTime: settings.fixedTime, maskRects: settings.maskRects },
            motion,
          }
        : { ...common, captureMode: 'keyframes', settings: { fixedTime: settings.fixedTime } },
    );
    await writeRunFile(run, 'capture.json', `${JSON.stringify(bundle, null, 2)}\n`);
    return bundle;
  } finally {
    await browser.close().catch(() => {});
    releaseCheckpointStorage(budget);
  }
}
