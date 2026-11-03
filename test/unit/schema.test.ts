import { describe, expect, it } from 'vitest';
import { ConfigSchema, ScenarioSchema, TimelineSchema, parseConfig, parseScenario } from '../../src/schema/index.js';
import { canonicalJson, digest, readJsonInput } from '../../src/schema/io.js';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const execution = { start: { kind: 'process', argv: ['python3', '-m', 'http.server', '{port}'] }, state: { kind: 'stateless' } };
const example = {
  schemaVersion: 2,
  id: 'pricing-toggle',
  title: 'Switch yearly pricing',
  steps: [
    { id: 'open', op: 'goto', path: '/pricing' },
    { id: 'ready', op: 'expectVisible', target: { role: 'heading', name: 'Pricing' } },
    { id: 'toggle', op: 'click', target: { role: 'switch', name: 'Yearly' }, allowMissing: ['before'] },
    { id: 'saving', op: 'expectVisible', target: { text: 'Save 20%' }, only: 'after' },
    { id: 'hover', op: 'hover', target: { role: 'button', name: 'Get Pro' } },
    { id: 'poster', op: 'screenshot', note: 'Hover on the plan button' },
  ],
};

describe('T01 versioned input boundaries', () => {
  it('normalizes the documented scenario without exposing fill values as prose', () => {
    const parsed = parseScenario(example);
    expect(parsed.steps).toHaveLength(6);
    expect(parsed.steps[0]?.only).toBe('both');
    expect(parsed.steps[0]?.allowMissing).toEqual([]);
    expect(parseScenario({ ...example, title: 'hello\u001b[31m world' }).title).toBe('hello world');
  });

  it('applies nested defaults once and preserves overrides', () => {
    const config = parseConfig({ schemaVersion: 2, execution, capture: { mode: 'motion', observeMs: 801 } });
    expect(config.capture.observeMs).toBe(801);
    expect(config.capture.fixedTime).toBe(null);
    expect(config.execution.ready.statuses).toEqual([200]);
    expect(config.execution.start.kind).toBe('process');
  });

  it.each([
    { ...example, schemaVersion: 1 },
    { ...example, unknown: true },
    { ...example, id: '../bad' },
    { ...example, steps: [{ id: 'open', op: 'click', target: { text: 'Start' } }] },
    { ...example, steps: [{ id: 'open', op: 'goto', path: '//external.example' }] },
    { ...example, steps: [{ id: 'open', op: 'goto', path: '/\\external.example' }] },
    { ...example, steps: [{ id: 'open', op: 'goto', path: '/route\u0085' }] },
    { ...example, steps: [{ id: 'open', op: 'goto', path: '/route\u009b' }] },
    { ...example, steps: [{ id: 'open', op: 'goto', path: '/test', allowMissing: ['before'] }] },
    { ...example, steps: [example.steps[0], { id: 'click', op: 'click', target: { text: 'a', css: 'button' } }] },
    { ...example, steps: [example.steps[0], { id: 'click', op: 'click', target: { role: 'imaginary' } }] },
    { ...example, steps: [example.steps[0], { id: 'click', op: 'click', target: { text: 'a' }, only: 'after', allowMissing: ['before'] }] },
    { ...example, steps: [example.steps[0], example.steps[0]] },
    { ...example, steps: Array.from({ length: 13 }, (_, n) => ({ id: `step-${n}`, op: 'goto', path: '/' })) },
  ])('rejects invalid scenarios', (value) => expect(ScenarioSchema.safeParse(value).success).toBe(false));

  it.each([
    { schemaVersion: 2, execution, env: { TOKEN: 'secret' } },
    { schemaVersion: 2, execution, capture: { mode: 'motion', observeMs: -1 } },
    { schemaVersion: 2, execution, capture: { mode: 'motion', fixedTime: 'yesterday' } },
    { schemaVersion: 2, execution: { ...execution, start: { kind: 'process', argv: [] } } },
    { schemaVersion: 2, execution: { ...execution, start: { kind: 'process', argv: ['server', '--port={port}'] } } },
    { schemaVersion: 2, execution: { ...execution, ready: { path: 'https://external.example' } } },
    { schemaVersion: 2, execution: { ...execution, ready: { statuses: [] } } },
  ])('rejects unsupported config', (value) => expect(ConfigSchema.safeParse(value).success).toBe(false));

  it('uses Unicode code points for human text limits', () => {
    expect(parseScenario({ ...example, title: '😀'.repeat(160) }).title).toHaveLength(320);
    expect(() => parseScenario({ ...example, title: '😀'.repeat(161) })).toThrow();
  });

  it('rejects oversized and malformed UTF-8 JSON files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'swc-schema-'));
    try {
      const path = join(dir, 'input.json');
      await writeFile(path, Buffer.alloc(1024 * 1024 + 1, 32));
      await expect(readJsonInput(path)).rejects.toThrow();
      await writeFile(path, Buffer.from([0x7b, 0xff, 0x7d]));
      await expect(readJsonInput(path)).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('T01 canonical identities and T11 integer timeline', () => {
  it('sorts object keys recursively and preserves array order', () => {
    expect(canonicalJson({ z: 1, a: [{ b: 2, a: 1 }, 3] })).toBe('{"a":[{"a":1,"b":2},3],"z":1}');
    expect(digest({ a: 1, b: 2 })).toBe(digest({ b: 2, a: 1 }));
    expect(digest([1, 2])).not.toBe(digest([2, 1]));
  });

  it('rejects discontinuous, fractional and unsafe timelines', () => {
    const base = {
      schemaVersion: 2, runId: '20261102T010203004Z-0123456789abcdef', fps: 30,
      captureMode: 'keyframes', captureSha256: 'b'.repeat(64), viewport: { width: 1280, height: 800, deviceScaleFactor: 1 }, selections: [], stepBoundaries: [{ scenarioId: 'test', stepId: 'open', startFrame: 30, endFrame: 54 }], annotations: [], posterSelection: { kind: 'checkpoint', scenarioId: 'test', stepId: 'open', changeRatio: 0 }, templateVersion: 2, width: 1920, height: 686, totalFrames: 54,
      segments: [{ kind: 'title', scenarioId: 'test', stepId: null, image: 'composed/000-title.png', startFrame: 0, durationFrames: 30 }, { kind: 'step', scenarioId: 'test', stepId: 'open', image: 'composed/000-title.png', startFrame: 30, durationFrames: 24 }],
      poster: 'composed/000-title.png', images: [{ path: 'composed/000-title.png', sha256: 'a'.repeat(64), bytes: 100 }],
    };
    expect(TimelineSchema.safeParse(base).success).toBe(true);
    expect(TimelineSchema.safeParse({ ...base, totalFrames: 55 }).success).toBe(false);
    expect(TimelineSchema.safeParse({ ...base, poster: '../outside.png' }).success).toBe(false);
    expect(TimelineSchema.safeParse({ ...base, segments: [{ ...base.segments[0], startFrame: 1 }] }).success).toBe(false);
    expect(TimelineSchema.safeParse({ ...base, segments: [{ ...base.segments[0], durationFrames: 29.5 }] }).success).toBe(false);
  });
});
