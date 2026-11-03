import { expect, test } from 'vitest';
import type { RunContext } from '../../src/schema/contracts.js';
import { RecipeSchema } from '../../src/schema/recipe.js';
import { applicationEnvironment, bindEnvironment } from '../../src/runtime/recipe.js';
import type { Consumer } from '../../src/runtime/recipe.js';
function redactor(): RunContext['redactions'] {
  const values = new Set<string>();
  return { add(items) { for (const item of items) if (item) values.add(item); }, text(input) { let text = input; for (const value of [...values].sort((a, b) => b.length - a.length)) text = text.split(value).join('[redacted]'); return text; } };
}
const recipe = RecipeSchema.parse({ env: { LITERAL: { literal: 'literal-env-canary-123' }, TEMPLATE: { template: 'token-free-template-canary-456' }, PRIVATE_PATH: { template: '{stateDir}/generated-canary-789' } }, services: [{ id: 'store', kind: 'process', argv: ['node', 'service.cjs', '{port}'], env: { SERVICE_LITERAL: { literal: 'service-literal-canary-abc' }, SERVICE_TEMPLATE: { template: '{origin}/service-template-canary-def' } }, ready: { kind: 'tcp' } }], start: { kind: 'process', argv: ['node', 'server.cjs', '{port}'] }, state: { kind: 'stateless' } });
const consumer: Consumer = { side: 'before', port: 4310, origin: 'http://127.0.0.1:4310', container: false, inputs: { directory: '/private/synthetic', stateDir: '/private/synthetic/state', inputDir: '/private/synthetic/inputs', files: new Map() }, services: [], runId: 'synthetic-run' };
test('literal and token-free template application and service values are private before consumer execution', async () => {
  const registry = redactor(); const binding = await bindEnvironment(recipe, { redactions: registry });
  for (const value of ['literal-env-canary-123', 'token-free-template-canary-456', 'service-literal-canary-abc']) {
    expect(binding.sensitiveValues).toContain(value); expect(registry.text(`public-title ${value}`)).toBe('public-title [redacted]');
  }
});
test('every resolved app and service template enters public-text and child-log redaction before use', async () => {
  const registry = redactor(); const binding = await bindEnvironment(recipe, { redactions: registry });
  const app = applicationEnvironment(recipe.env, binding, consumer);
  const service = applicationEnvironment(recipe.services[0]?.env ?? {}, binding, { ...consumer, port: 4311 });
  for (const value of [app.LITERAL, app.TEMPLATE, app.PRIVATE_PATH, service.SERVICE_LITERAL, service.SERVICE_TEMPLATE]) {
    if (!value) throw new Error('Missing synthetic environment value');
    expect(binding.sensitiveValues).toContain(value); expect(registry.text(`caption ${value}`)).toBe('caption [redacted]');
    const log = binding.sensitiveValues.reduce((text, secret) => secret ? text.split(secret).join('[redacted]') : text, `bare output ${value}`);
    expect(log).toBe('bare output [redacted]');
  }
});
