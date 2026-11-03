import { describe, expect, it } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { z } from 'zod';
import { ArtifactPathSchema, CapturedScenarioSchema, ConfigSchema, HumanTextSchema, MotionScenarioTimingSchema, motionPlaybackWindow, ScenarioSchema, SideResultSchema, TimelineSchema, WarningSchema } from '../../src/schema/index.js';

const ajv = new Ajv2020({ strict: false, validateFormats: false });
const validateConfig = ajv.compile(z.toJSONSchema(ConfigSchema, { io: 'input' }));
const validateScenario = ajv.compile(z.toJSONSchema(ScenarioSchema, { io: 'input' }));

const execution = { start: { kind: 'process', argv: ['python3', '-m', 'http.server', '{port}'] }, state: { kind: 'stateless' } };
describe('T01 published structural schemas', () => {
  it.each([
    { schemaVersion: 2, execution },
    { schemaVersion: 2, execution, capture: { mode: 'motion', observeMs: 801 } },
    { schemaVersion: 2, execution, capture: { mode: 'keyframes', maskSelectors: ['#secret'] } },
  ])('accepts normalized documented configuration inputs', (config) => {
    expect(ConfigSchema.safeParse(config).success).toBe(true);
    expect(validateConfig(config)).toBe(true);
  });
  it.each([
    { schemaVersion: 1, execution },
    { schemaVersion: 2 },
    { schemaVersion: 2, execution, unknown: true },
    { schemaVersion: 2, execution: { ...execution, start: { kind: 'process', argv: [] } } },
    { schemaVersion: 2, execution, capture: { mode: 'motion', maskSelectors: ['input'] } },
  ])('rejects invalid structural config identically', (config) => {
    expect(ConfigSchema.safeParse(config).success).toBe(false);
    expect(validateConfig(config)).toBe(false);
  });
  it('requires initial navigation in both validators', () => {
    const scenario = { schemaVersion: 2, id: 'demo', title: 'Demo', steps: [{ id: 'first', op: 'screenshot' }] };
    expect(ScenarioSchema.safeParse(scenario).success).toBe(false);
    expect(validateScenario(scenario)).toBe(false);
  });
  it.each(['/route\u0085', '/route\u009b'])('rejects C1 controls in app paths in both validators', (path) => {
    const scenario = { schemaVersion: 2, id: 'demo', title: 'Demo', steps: [{ id: 'first', op: 'goto', path }] };
    expect(ScenarioSchema.safeParse(scenario).success).toBe(false);
    expect(validateScenario(scenario)).toBe(false);
  });
  it.each(['../outside.png', '/absolute.png', 'a//b.png', 'a/../b.png', 'a/./b.png', 'a\\b.png', 'C:drive.png'])('rejects unsafe artifact paths structurally', (path) => {
    expect(ArtifactPathSchema.safeParse(path).success).toBe(false);
    expect(ajv.validate(z.toJSONSchema(ArtifactPathSchema), path)).toBe(false);
  });
  it('preserves Unicode while rejecting raw control characters', () => {
    expect(HumanTextSchema.safeParse('😀'.repeat(160)).success).toBe(true);
    expect(ajv.validate(z.toJSONSchema(HumanTextSchema), '😀'.repeat(160))).toBe(true);
    expect(ajv.validate(z.toJSONSchema(HumanTextSchema), '😀'.repeat(161))).toBe(false);
    expect(HumanTextSchema.safeParse('\x1b[31mred').success).toBe(false);
    expect(WarningSchema.safeParse({ code: 'TEST', message: '\x1b[31mred' }).success).toBe(false);
  });
});

describe('reviewed capture and timeline invariants', () => {
  const side = { status: 'ok', reasonCode: null, image: { path: 'frames/000-before.png', sha256: 'a'.repeat(64), bytes: 10 }, imageKind: 'checkpoint', sanitization: { kind: 'selectors', selectorCount: 0 }, heldFromStepId: null, elapsedMs: 1 };
  const step = { id: 'open', op: 'goto', caption: 'Open', observeMs: 800, before: side, after: side, changeRatio: 0 };
  it('cannot report a held frame as verified', () => {
    const held = { ...side, heldFromStepId: 'previous' };
    expect(SideResultSchema.safeParse(held).success).toBe(false);
    expect(ajv.validate(z.toJSONSchema(SideResultSchema), held)).toBe(false);
  });
  it('rejects duplicate captured step IDs and wrong scenario outcome', () => {
    expect(CapturedScenarioSchema.safeParse({ id: 'scenario', title: 'Demo', initialRoute: '/', outcome: 'ok', steps: [step, step] }).success).toBe(false);
    expect(CapturedScenarioSchema.safeParse({ id: 'scenario', title: 'Demo', initialRoute: '/', outcome: 'partial', steps: [step] }).success).toBe(false);
  });
  it('bounds configured playback while preserving a longer observed interval', () => {
    const timing = { startMs: 1000, limitMs: 60000, observedEndMs: 61100 };
    expect(MotionScenarioTimingSchema.parse(timing)).toEqual(timing);
    expect(motionPlaybackWindow(timing)).toEqual({ startMs: 1000, endMs: 61000, durationFrames: 1800 });
    for (const limitMs of [0, 99, 60001, 100.5]) {
      const invalid = { ...timing, limitMs };
      expect(MotionScenarioTimingSchema.safeParse(invalid).success).toBe(false);
      expect(ajv.validate(z.toJSONSchema(MotionScenarioTimingSchema), invalid)).toBe(false);
    }
    for (const observedEndMs of [999, 1000])
      expect(MotionScenarioTimingSchema.safeParse({ ...timing, observedEndMs }).success).toBe(false);
    expect(MotionScenarioTimingSchema.safeParse({ startMs: 2 ** 70, observedEndMs: 2 ** 70 + 2 ** 18, limitMs: 60000 }).success).toBe(false);
    expect(motionPlaybackWindow({ ...timing, observedEndMs: 1333 })).toEqual({ startMs: 1000, endMs: 1333, durationFrames: 10 });
  });
  it.each([
    { startMs: 5536.1, limitMs: 60000, observedEndMs: 21936.100000000002, durationFrames: 493 },
    { startMs: 2 ** 53, limitMs: 100, observedEndMs: 2 ** 53 + 100, durationFrames: 3 },
    { startMs: 2 ** 60, limitMs: 60000, observedEndMs: 2 ** 60 + 60000, durationFrames: 1794 },
    { startMs: 2 ** 66, limitMs: 60000, observedEndMs: 2 ** 66 + 60000, durationFrames: 1721 },
    { startMs: 2 ** 68, limitMs: 60000, observedEndMs: 2 ** 68 + 60000, durationFrames: 984 },
  ])('counts actual scheduled ticks for finite start $startMs and end $observedEndMs', ({ durationFrames, ...input }) => {
    const timing = MotionScenarioTimingSchema.parse(input);
    const window = motionPlaybackWindow(timing);
    expect(window).toEqual({ startMs: timing.startMs, endMs: timing.observedEndMs, durationFrames });
    expect(window.startMs + (window.durationFrames - 1) * 1000 / 30).toBeLessThan(window.endMs);
    expect(window.startMs + window.durationFrames * 1000 / 30).toBeGreaterThanOrEqual(window.endMs);
    expect(window.durationFrames).toBeGreaterThan(0);
    expect(window.durationFrames).toBeLessThanOrEqual(Math.ceil(timing.limitMs * 30 / 1000));
    expect(window.durationFrames).toBeLessThanOrEqual(1800);
  });
  it('rejects a one-frame step without a title', () => {
    expect(TimelineSchema.safeParse({ schemaVersion: 1, runId: '20261102T010203004Z-0123456789abcdef', fps: 30, templateVersion: 1, width: 1920, height: 686, totalFrames: 1, segments: [{ kind: 'step', scenarioId: 'scenario', stepId: 'first', image: 'composed/frame.png', startFrame: 0, durationFrames: 1 }], poster: 'composed/frame.png', images: [{ path: 'composed/frame.png', sha256: 'a'.repeat(64), bytes: 1 }] }).success).toBe(false);
  });
});
