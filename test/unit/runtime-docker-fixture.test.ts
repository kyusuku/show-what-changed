import { readFile } from 'node:fs/promises';
import { expect, test } from 'vitest';
import { ConfigSchema } from '../../src/schema/index.js';
test('the redistributable Docker fixture has explicit synthetic bindings, a backing service, and one reviewed source change', async () => {
  const root = new URL('../../fixtures/general-app/docker/', import.meta.url);
  const config = ConfigSchema.parse(JSON.parse(await readFile(new URL('show-what-changed.config.json', root), 'utf8')));
  expect(config.execution.start).toMatchObject({ kind: 'container', containerPort: 8080, build: { context: '.', dockerfile: 'Dockerfile' } });
  expect(config.execution.services).toMatchObject([{ id: 'db', kind: 'container', containerPort: 5432 }]);
  expect(config.execution.env).not.toHaveProperty('POSTGRES_PASSWORD');
  const references = [config.execution.env, ...config.execution.services.map((service) => service.env)].flatMap((env) => Object.values(env).flatMap((binding) => 'fromEnv' in binding ? [binding.fromEnv] : []));
  expect(references.sort()).toEqual(['SWC_FIXTURE_DB_PASSWORD', 'SWC_FIXTURE_LOG_CANARY']);
  const html = await readFile(new URL('index.html', root), 'utf8');
  expect(html.split('<h1>Container source</h1>')).toHaveLength(2); expect(html.replace('<h1>Container source</h1>', '<h1>Updated container source</h1>')).not.toBe(html);
  expect(await readFile(new URL('Dockerfile', root), 'utf8')).toMatch(/^FROM busybox@sha256:[a-f0-9]{64}\n/);
  for (const path of ['setup.mjs', 'bootstrap.mjs', 'run-container.sh']) expect((await readFile(new URL(path, root))).length).toBeGreaterThan(0);
});
