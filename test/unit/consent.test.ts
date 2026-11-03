import { describe, expect, it } from 'vitest';
import { formatConsentRecipe } from '../../src/cli/consent.js';
import { ConfigSchema, ScenarioSchema } from '../../src/schema/index.js';

describe('execution consent display', () => {
  it('shows command order and environment references without private values or helper paths', () => {
    const config = ConfigSchema.parse({ schemaVersion: 2, execution: {
      env: { PUBLIC_OPTION: { literal: '1' }, SECRET: { fromEnv: 'APP_SECRET' }, PRIVATE_SETTING: { literal: 'fixture-private-value' } },
      inputs: [{ id: 'seed', path: '/private/fixture-seed.json' }],
      auth: { storageState: 'private/auth.json' },
      services: [{ id: 'helper', kind: 'process', argv: ['node', 'helper.mjs', '{port}'], ready: { kind: 'tcp' }, env: { TOKEN: { template: 'private-token-{side}' } } }],
      setup: [{ cwd: '.', argv: ['pnpm', 'install', '--frozen-lockfile'] }],
      start: { kind: 'process', argv: ['node', 'v1-server.mjs', '{port}', 'fixture-private-value'] },
      state: { kind: 'external-read-only', description: 'private dependency description' },
    } });
    const scenarios = [ScenarioSchema.parse({ schemaVersion: 2, id: 'form', title: 'Form', steps: [{ id: 'open', op: 'goto', path: '/' }, { id: 'fill', op: 'fill', target: { label: 'Code' }, value: 'private-fill-value' }] })];
    const preview = formatConsentRecipe({ config, scenarios, inputs: [{ id: 'seed', path: '/private/fixture-seed.json', sha256: 'a'.repeat(64), byteLength: 17, executable: false, extension: '.json' }] });
    for (const privateValue of ['fixture-private-value', 'private-token-', 'private-fill-value', '/private/fixture-seed', 'private/auth.json', 'private dependency description']) expect(preview).not.toContain(privateValue);
    const value = JSON.parse(preview);
    expect(value.setup[0].argv).toEqual(['pnpm', 'install', '--frozen-lockfile']);
    expect(value.start.argv).toEqual(['node', 'v[private value]-server.mjs', '{port}', '[private value]']);
    expect(value.env.SECRET).toEqual({ fromEnv: 'APP_SECRET' });
    expect(value.services[0].argv).toEqual(['node', 'helper.mjs', '{port}']);
    expect(value.inputs).toEqual([{ id: 'seed', sha256: 'a'.repeat(64), bytes: 17 }]);
  });
  it('masks private operands in readiness, commands, working directories, and container declarations', () => {
    const config = ConfigSchema.parse({ schemaVersion: 2, execution: {
      env: { TOKEN: { literal: 'q+' }, TEMPLATE: { template: 'private-prefix-{side}' }, EMPTY: { literal: '' } },
      ready: { path: '/health?token=q+' },
      requires: [{ argv: ['runtime', '--q+-version'], expectedVersion: '^24' }],
      setup: [{ cwd: 'q+-dir', argv: ['runtime', 'private-prefix-before'] }],
      start: { kind: 'container', build: { context: 'q+-app', dockerfile: 'q+-Dockerfile' }, containerPort: 8080 },
      services: [{ id: 'helper', kind: 'container', image: `q+-image@sha256:${'a'.repeat(64)}`, containerPort: 8081, ready: { kind: 'http', path: '/health?token=q+' } }],
      state: { kind: 'stateless' },
    } });
    const preview = formatConsentRecipe({ config, scenarios: [], inputs: [] });
    expect(preview).not.toContain('q+');
    expect(preview).not.toContain('private-prefix-');
    const value = JSON.parse(preview);
    expect(value.requires[0]).toEqual({ argv: ['runtime', '--[private value]-version'], expectedVersion: '^24' });
    expect(value.ready.path).toBe('/health?token=[private value]');
    expect(value.services[0].ready.path).toBe('/health?token=[private value]');
    expect(value.services[0].id).toBe('helper');
    expect(value.start.containerPort).toBe(8080);
    expect(value.setup[0].argv).toEqual(['runtime', '[private value]before']);
  });
  it('masks one-character fill values once without modifying metadata or token placeholders', () => {
    const config = ConfigSchema.parse({ schemaVersion: 2, execution: { start: { kind: 'process', argv: ['node', 'page.mjs', '{stateDir}', '--value=a'] }, state: { kind: 'stateless' } } });
    const scenarios = [ScenarioSchema.parse({ schemaVersion: 2, id: 'form', title: 'Form', steps: [{ id: 'open', op: 'goto', path: '/' }, { id: 'fill', op: 'fill', target: { label: 'Code' }, value: 'a' }] })];
    const value = JSON.parse(formatConsentRecipe({ config, scenarios, inputs: [] }));
    expect(value.start.argv).toEqual(['node', 'p[private value]ge.mjs', '{stateDir}', '--v[private value]lue=[private value]']);
    expect(value.state.kind).toBe('stateless');
  });
  it('uses only explicitly named current environment values for transient preview redaction', () => {
    const config = ConfigSchema.parse({ schemaVersion: 2, appDir: 'apps/private-reference-canary', execution: {
      env: { TOKEN: { fromEnv: 'APP_TOKEN' }, MISSING: { fromEnv: 'UNSET_TOKEN' } },
      start: { kind: 'process', argv: ['node', 'server.mjs', '--token=private-reference-canary', 'ordinary-value'] },
      ready: { path: '/health?token=private-reference-canary' },
      services: [{ id: 'helper', kind: 'process', argv: ['node', 'helper.mjs'], env: { TOKEN: { fromEnv: 'SERVICE_TOKEN' } }, ready: { kind: 'http', path: '/health?token=service-private-canary' } }],
      state: { kind: 'stateless' },
    } });
    const plan = { config, scenarios: [], inputs: [] };
    const original = JSON.stringify(plan);
    const preview = formatConsentRecipe(plan, { APP_TOKEN: 'private-reference-canary', SERVICE_TOKEN: 'service-private-canary', UNRELATED: 'ordinary-value' });
    expect(preview).not.toContain('private-reference-canary');
    expect(preview).not.toContain('service-private-canary');
    expect(preview).toContain('ordinary-value');
    expect(JSON.parse(preview).env.MISSING).toEqual({ fromEnv: 'UNSET_TOKEN' });
    expect(JSON.stringify(plan)).toBe(original);
  });
});
