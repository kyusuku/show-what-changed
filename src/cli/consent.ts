import type { Plan } from '../schema/index.js';
import type { EnvironmentBinding, ExecutionRecipe, RecipeCommand } from '../schema/recipe.js';

export function formatConsentRecipe(plan: Pick<Plan, 'config' | 'inputs' | 'scenarios'>, environmentValues: Readonly<Record<string, string | undefined>> = {}): string {
  const recipe = plan.config.execution;
  const environment = (bindings: Record<string, EnvironmentBinding>) => Object.fromEntries(Object.entries(bindings).map(([name, binding]) => [name,
    'fromEnv' in binding ? { fromEnv: binding.fromEnv } : 'literal' in binding ? { literal: '[private value]' } : { template: '[private value]' },
  ]));
  const privateValues = [recipe.env, ...recipe.services.map((service) => service.env)].flatMap((bindings) => Object.values(bindings).flatMap((binding) => 'literal' in binding ? [binding.literal] : 'template' in binding ? [binding.template, ...binding.template.split(/\{[^{}]*\}/g)] : [environmentValues[binding.fromEnv] ?? '']));
  if (recipe.pathPrependFromEnv) privateValues.push(environmentValues[recipe.pathPrependFromEnv] ?? '');
  for (const scenario of plan.scenarios) for (const step of scenario.steps) if (step.op === 'fill') privateValues.push(step.value);
  const patterns = [...new Set(privateValues.filter(Boolean))].sort((a, b) => b.length - a.length).map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const privatePattern = patterns.length ? new RegExp(patterns.join('|'), 'g') : null;
  const mask = (value: string): string => privatePattern ? value.replace(privatePattern, '[private value]') : value;
  const argv = (values: readonly string[]) => values.map((value) => /^\{[^{}]*\}$/.test(value) ? value : mask(value));
  const cwd = (value: Pick<RecipeCommand, 'cwd'>) => value.cwd === undefined ? {} : { cwd: mask(value.cwd) };
  const command = (value: RecipeCommand) => ({ ...cwd(value), argv: argv(value.argv), timeoutMs: value.timeoutMs });
  const ready = (value: ExecutionRecipe['ready']) => ({ path: mask(value.path), statuses: value.statuses, timeoutMs: value.timeoutMs });
  return JSON.stringify({
    appDir: mask(plan.config.appDir),
    env: environment(recipe.env),
    requires: recipe.requires.map((value) => ({ argv: argv(value.argv), expectedVersion: value.expectedVersion })),
    setup: recipe.setup.map(command),
    bootstrap: recipe.bootstrap.map(command),
    start: recipe.start.kind === 'process'
      ? { kind: recipe.start.kind, ...cwd(recipe.start), argv: argv(recipe.start.argv) }
      : { kind: recipe.start.kind, containerPort: recipe.start.containerPort, build: { context: mask(recipe.start.build.context), dockerfile: mask(recipe.start.build.dockerfile) } },
    ready: ready(recipe.ready),
    services: recipe.services.map((service) => ({
      id: service.id, kind: service.kind, env: environment(service.env),
      ready: service.ready.kind === 'http' ? { kind: service.ready.kind, ...ready(service.ready) } : { kind: service.ready.kind, timeoutMs: service.ready.timeoutMs },
      ...(service.kind === 'process'
        ? { ...cwd(service), argv: argv(service.argv), setup: service.setup.map(command) }
        : { image: mask(service.image), containerPort: service.containerPort }),
    })),
    ...(recipe.pathPrependFromEnv ? { pathPrependFromEnv: recipe.pathPrependFromEnv } : {}),
    inputs: plan.inputs.map((input) => ({ id: input.id, sha256: input.sha256, bytes: input.byteLength })),
    ...(recipe.auth ? { auth: { storageState: '[private generated state file]' } } : {}),
    state: recipe.state.kind === 'external-read-only' ? { kind: recipe.state.kind, description: '[private description]' } : recipe.state,
  });
}
