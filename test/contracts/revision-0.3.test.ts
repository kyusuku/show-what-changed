import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { publicRecipeDigest, publicScenarioDigest, publicError, publicRoute } from '../../src/schema/public.js';
import { digest } from '../../src/schema/io.js';
import { CaptureSettingsSchema, ClockMappingSchema, CommandArgvSchema, ConfigSchema, DOCUMENT_SCHEMAS, RecipeSchema, ScenarioSchema, SourceSettingsSchema, SourcePathSchema } from '../../src/schema/index.js';

const processStart = { kind: 'process', argv: ['python3', '-m', 'http.server', '{port}'] };
const stateless = { kind: 'stateless' };
const recipe = { start: processStart, state: stateless };

describe('revision 0.3 public contracts', () => {
  it('accepts every public spec and acceptance JSON example with normalized defaults', async () => {
    for (const path of ['spec.md', 'docs/web-app-acceptance.md']) {
      const text = await readFile(path, 'utf8');
      for (const match of text.matchAll(/~~~json\s*\n([\s\S]*?)\n~~~/g)) {
        const value: unknown = JSON.parse(match[1] ?? '');
        const schema = typeof value === 'object' && value !== null && 'steps' in value ? ScenarioSchema : ConfigSchema;
        expect(schema.safeParse(value).success, path).toBe(true);
        const ajv = new Ajv2020({ strict: false, validateFormats: false });
        expect(ajv.validate(z.toJSONSchema(schema, { io: 'input' }), value), path).toBe(true);
      }
    }
  });
  it('makes the app recipe mandatory and defaults to actual motion', () => {
    expect(ConfigSchema.safeParse({ schemaVersion: 2 }).success).toBe(false);
    const config = ConfigSchema.parse({ schemaVersion: 2, execution: recipe });
    expect(config.appDir).toBe('.');
    expect(config.capture.mode).toBe('motion');
    expect(config.execution.setup).toEqual([]);
    expect(config.source.maxBytes).toBe(1024 ** 3);
    expect(ConfigSchema.safeParse({ schemaVersion: 1, execution: recipe }).success).toBe(false);
    expect(ConfigSchema.safeParse({ schemaVersion: 2, execution: recipe, framework: 'custom' }).success).toBe(false);
  });
  it('keeps runtime and helper commands explicit without shell substitution', () => {
    expect(CommandArgvSchema.safeParse(['python3', '{port}']).success).toBe(true);
    for (const argv of [['python3', '--port={port}'], ['node', '{secret}'], ['node', '{port']]) {
      expect(CommandArgvSchema.safeParse(argv).success).toBe(false);
    }
    expect(RecipeSchema.safeParse({ ...recipe, env: { TOKEN: { literal: 'x', fromEnv: 'TOKEN' } } }).success).toBe(false);
    expect(RecipeSchema.safeParse({ ...recipe, setup: [{ argv: ['node'], cwd: '../caller' }] }).success).toBe(false);
  });
  it('rejects unbound seeds, unknown services, and forward dependencies', () => {
    expect(RecipeSchema.safeParse({ ...recipe, state: { kind: 'isolated', seedId: 'seed' } }).success).toBe(false);
    expect(RecipeSchema.safeParse({ ...recipe, state: { kind: 'isolated', seedId: 'seed' }, inputs: [{ id: 'seed', path: './seed.json' }] }).success).toBe(true);
    expect(RecipeSchema.safeParse({ ...recipe, env: { URL: { template: 'http://{service.db.host}:{service.db.port}' } } }).success).toBe(false);
    const service = { id: 'db', kind: 'process', argv: ['node', '{port}'], ready: { kind: 'tcp' } };
    expect(RecipeSchema.safeParse({ ...recipe, services: [{ ...service, env: { SELF: { template: '{service.db.host}' } } }] }).success).toBe(false);
    expect(RecipeSchema.safeParse({ ...recipe, services: [service], env: { DB: { template: '{service.db.port}' } } }).success).toBe(true);
    expect(RecipeSchema.safeParse({ ...recipe, services: [service], start: { kind: 'container', build: { context: '.', dockerfile: 'Dockerfile' }, containerPort: 80 }, env: { DB: { template: '{service.db.host}' } } }).success).toBe(false);
  });
  it('rejects mutable container services and unsupported container options', () => {
    const service = { id: 'db', kind: 'container', containerPort: 5432, ready: { kind: 'tcp' } };
    expect(RecipeSchema.safeParse({ ...recipe, services: [{ ...service, image: 'postgres:latest' }] }).success).toBe(false);
    expect(RecipeSchema.safeParse({ ...recipe, services: [{ ...service, image: `postgres@sha256:${'a'.repeat(64)}` }] }).success).toBe(true);
    expect(RecipeSchema.safeParse({ ...recipe, services: [{ ...service, image: `postgres@sha256:${'a'.repeat(64)}`, privileged: true }] }).success).toBe(false);
  });
  it('keeps masks mode-specific and bounded to the viewport', () => {
    expect(CaptureSettingsSchema.safeParse({ mode: 'motion', maskSelectors: ['input'] }).success).toBe(false);
    expect(CaptureSettingsSchema.safeParse({ mode: 'keyframes', maskRects: [] }).success).toBe(false);
    expect(CaptureSettingsSchema.safeParse({ mode: 'motion', viewport: { width: 390, height: 844 }, maskRects: [{ x: 389, y: 0, width: 2, height: 4 }] }).success).toBe(false);
    expect(CaptureSettingsSchema.safeParse({ mode: 'motion', viewport: { width: 390, height: 844 } }).success).toBe(true);
    expect(SourceSettingsSchema.safeParse({ generatedDirs: ['.'] }).success).toBe(false);
  });
  it('supports inner scroll targets and a plain navigation scenario without inventing a UI assertion', () => {
    expect(ScenarioSchema.safeParse({ schemaVersion: 2, id: 'simple', title: 'Simple', steps: [{ id: 'open', op: 'goto', path: '/' }] }).success).toBe(true);
    expect(ScenarioSchema.safeParse({ schemaVersion: 2, id: 'scroll', title: 'Scroll', steps: [{ id: 'open', op: 'goto', path: '/' }, { id: 'scroll', op: 'scrollBy', target: { css: '.scroll' }, y: 500, observeMs: 1200 }] }).success).toBe(true);
  });
  it('rejects samples that would change a fixed session clock mapping', () => {
    const mapping = { rate: 1, offsetMs: -1000, uncertaintyMs: 2, maxDriftMs: 1, errorBoundMs: 3, samples: [{ sourceSeconds: 2, hostBeforeMs: 999, hostAfterMs: 1001 }] };
    expect(ClockMappingSchema.safeParse(mapping).success).toBe(true);
    expect(ClockMappingSchema.safeParse({ ...mapping, samples: [...mapping.samples, { sourceSeconds: 3, hostBeforeMs: 1000, hostAfterMs: 1001 }] }).success).toBe(false);
    expect(ClockMappingSchema.safeParse({ ...mapping, errorBoundMs: 41 }).success).toBe(false);
  });
  it('public digests cannot reveal short fill or environment values', () => {
    const publicDigests = new Set<string>();
    const privateDigests = new Set<string>();
    const recipeDigests = new Set<string>();
    for (const value of ['1234', '4321', '0000', '9999']) {
      const scenario = ScenarioSchema.parse({ schemaVersion: 2, id: 'form', title: value, steps: [{ id: 'open', op: 'goto', path: '/' }, { id: 'fill', op: 'fill', target: { label: value }, value }] });
      publicDigests.add(publicScenarioDigest([scenario])); privateDigests.add(digest(scenario));
      recipeDigests.add(publicRecipeDigest(ConfigSchema.parse({ schemaVersion: 2, execution: { ...recipe, env: { TOKEN: { literal: value } } } })));
    }
    expect(publicDigests.size).toBe(1); expect(privateDigests.size).toBe(4); expect(recipeDigests.size).toBe(1);
    expect(publicRoute('/login?token=1234#secret')).toBe('/login');
    const error = publicError({ code: 'START_FAILED', phase: 'starting', message: 'token=1234 /Users/private/a', hint: 'cookie=secret' });
    expect(JSON.stringify(error)).not.toMatch(/1234|Users|cookie=secret/);
  });
  it('provides useful fixed next actions without copying private failure operands', () => {
    const recipe = publicError({ code: 'RECIPE_REQUIRED', phase: 'planning', message: 'private canary', hint: 'private canary' });
    expect(recipe.hint).toContain('--config');
    const stale = publicError({ code: 'STALE_PLAN', phase: 'validating', message: 'private canary', hint: 'private canary' });
    expect(stale.hint).toContain('Regenerate');
    const git = publicError({ code: 'GIT_FAILED', phase: 'source', message: 'private canary', hint: 'private canary' });
    expect(git.hint).toContain('Fetch missing refs explicitly');
    const input = publicError({ code: 'INVALID_DOCUMENT', phase: 'validating', message: 'private canary', hint: 'private canary' });
    expect(input.hint).toContain('Version 1 inputs require migration');
    expect(JSON.stringify([recipe, stale, git, input])).not.toContain('private canary');
    for (const [code, expected] of [['MISSING_ENVIRONMENT', 'Set every named environment reference'], ['PREREQUISITE_MISSING', 'PATH'], ['PREREQUISITE_VERSION', 'expectedVersion'], ['SETUP_FAILED', 'setup recipe'], ['BOOTSTRAP_FAILED', 'bootstrap recipe'], ['SERVER_TIMEOUT', 'readiness path'], ['UNKNOWN_RUNTIME_FAILURE', 'declared runtimes']] as const) {
      const error = publicError({ code, phase: 'starting', message: 'private canary', hint: 'private canary' });
      expect(error.hint).toContain(expected);
      expect(JSON.stringify(error)).not.toContain('private canary');
    }
    for (const code of ['constructor', '__proto__', 'toString']) {
      const unknown = publicError({ code, phase: 'constructor', message: 'private canary', hint: 'private canary' });
      expect(unknown.message).toBeTypeOf('string'); expect(unknown.hint).toBeTypeOf('string');
      expect(JSON.stringify(unknown)).not.toContain('private canary');
    }
  });
  it('preserves contained POSIX filenames without permitting traversal across newlines', () => {
    expect(SourcePathSchema.safeParse('a file\nwith newline.txt').success).toBe(true);
    expect(SourcePathSchema.safeParse('C:fixture.txt').success).toBe(true);
    for (const path of ['../outside', 'a\n/../outside', '/absolute', 'a//b', 'a/./b', 'bad\0name']) {
      expect(SourcePathSchema.safeParse(path).success).toBe(false);
    }
  });
  it('generates JSON schemas for every active document', () => {
    for (const [name, schema] of Object.entries(DOCUMENT_SCHEMAS)) {
      const generated = z.toJSONSchema(schema, { io: name === 'config' || name === 'scenario' ? 'input' : 'output' });
      expect(generated).toHaveProperty('$schema');
    }
  });
});
