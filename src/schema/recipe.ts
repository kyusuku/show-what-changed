import { z } from 'zod';
import semver from 'semver';

export const RecipeIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
export const RelativePathSchema = z.string().min(1).max(4096).regex(/^(?:\.|(?!\/|[A-Za-z]:)(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?!.*\/\/)(?!.*\/$)[^\\\x00-\x1f\x7f]+)$/);
const InputPathSchema = z.string().min(1).max(4096).regex(/^[^\\\x00-\x1f\x7f]+$/);
const EnvNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const EnvValueSchema = z.string().max(32768).regex(/^[^\x00]*$/);
const TokenSchema = z.string().regex(/^\{(?:port|origin|stateDir|side|runId|input\.[a-z0-9][a-z0-9-]{0,63}|service\.[a-z0-9][a-z0-9-]{0,63}\.(?:host|port))\}$/);
export function recipeTokens(value: string): string[] { return value.match(/\{[^{}]*\}/g) ?? []; }
function validTokens(value: string): boolean {
  return !/[{}]/.test(value.replace(/\{[^{}]*\}/g, '')) && recipeTokens(value).every((token) => TokenSchema.safeParse(token).success);
}
export const CommandArgvSchema = z.array(z.string().min(1).max(4096).regex(/^[^\x00]*$/)).min(1).max(64)
  .refine((argv) => argv.every((arg) => validTokens(arg) && (recipeTokens(arg).length === 0 || TokenSchema.safeParse(arg).success)), 'Tokens must be recognized and occupy an entire argument');
const CommandTimeoutSchema = z.number().int().min(100).max(3600000);
export const CommandSchema = z.strictObject({ cwd: RelativePathSchema.optional(), argv: CommandArgvSchema, timeoutMs: CommandTimeoutSchema.default(300000) });
export const EnvBindingSchema = z.union([
  z.strictObject({ literal: EnvValueSchema }),
  z.strictObject({ fromEnv: EnvNameSchema }),
  z.strictObject({ template: EnvValueSchema.refine(validTokens, 'Unknown or malformed recipe token') }),
]);
export const EnvMapSchema = z.record(EnvNameSchema, EnvBindingSchema).refine((env) => Object.keys(env).length <= 128, 'At most 128 environment bindings');
const ReadyFields = {
  path: z.string().max(2048).regex(/^\/(?!\/)[^\x00-\x1f\x7f-\x9f\\]*$/).default('/'),
  statuses: z.array(z.number().int().min(100).max(599)).min(1).max(10).default([200]),
  timeoutMs: CommandTimeoutSchema.default(300000),
};
export const AppReadySchema = z.strictObject(ReadyFields);
export const ServiceReadySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('http'), ...ReadyFields }),
  z.strictObject({ kind: z.literal('tcp'), timeoutMs: CommandTimeoutSchema.default(300000) }),
]);
const PortSchema = z.number().int().min(1).max(65535);
export const ServiceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ id: RecipeIdSchema, kind: z.literal('process'), cwd: RelativePathSchema.optional(), argv: CommandArgvSchema, env: EnvMapSchema.default({}), ready: ServiceReadySchema, setup: z.array(CommandSchema).max(8).default([]) }),
  z.strictObject({ id: RecipeIdSchema, kind: z.literal('container'), image: z.string().max(512).regex(/^[^\s@]+@sha256:[a-f0-9]{64}$/), containerPort: PortSchema, env: EnvMapSchema.default({}), ready: ServiceReadySchema }),
]);
export const StartSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('process'), cwd: RelativePathSchema.optional(), argv: CommandArgvSchema }),
  z.strictObject({ kind: z.literal('container'), build: z.strictObject({ context: RelativePathSchema, dockerfile: RelativePathSchema }), containerPort: PortSchema }),
]);
export const StateSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('stateless') }),
  z.strictObject({ kind: z.literal('isolated'), seedId: RecipeIdSchema }),
  z.strictObject({ kind: z.literal('external-read-only'), description: z.string().min(1).max(1024).regex(/^[^\x00-\x1f\x7f-\x9f]*$/) }),
]);
export const RecipeSchema = z.strictObject({
  env: EnvMapSchema.default({}),
  services: z.array(ServiceSchema).max(4).default([]),
  setup: z.array(CommandSchema).max(8).default([]),
  start: StartSchema,
  ready: AppReadySchema.prefault({}),
  bootstrap: z.array(CommandSchema).max(4).default([]),
  state: StateSchema,
  requires: z.array(z.strictObject({ argv: CommandArgvSchema, expectedVersion: z.string().max(128).refine((value) => semver.validRange(value) !== null, 'A semantic version range is required') })).max(8).default([]),
  pathPrependFromEnv: EnvNameSchema.optional(),
  inputs: z.array(z.strictObject({ id: RecipeIdSchema, path: InputPathSchema })).max(16).default([]),
  auth: z.strictObject({ storageState: RelativePathSchema.refine((path) => path !== '.', 'Authentication state must be a file') }).optional(),
}).superRefine((recipe, context) => {
  const inputs = new Set(recipe.inputs.map((input) => input.id));
  const services = new Map(recipe.services.map((service) => [service.id, service]));
  if (inputs.size !== recipe.inputs.length || services.size !== recipe.services.length) context.addIssue({ code: 'custom', message: 'Input and service IDs must be unique' });
  if (recipe.state.kind === 'isolated' && !inputs.has(recipe.state.seedId)) context.addIssue({ code: 'custom', path: ['state', 'seedId'], message: 'seedId must identify a declared input' });
  const strings = (env: z.infer<typeof EnvMapSchema>, commands: readonly { argv: string[] }[]): string[] => [
    ...Object.values(env).flatMap((binding) => 'template' in binding ? [binding.template] : []),
    ...commands.flatMap((command) => command.argv),
  ];
  const inspect = (values: string[], allowed: Set<string>, container: boolean): void => {
    for (const value of values) for (const token of recipeTokens(value)) {
      const input = /^\{input\.(.+)\}$/.exec(token)?.[1];
      const service = /^\{service\.(.+)\.(?:host|port)\}$/.exec(token)?.[1];
      if (input && !inputs.has(input)) context.addIssue({ code: 'custom', message: 'Unknown input token' });
      if (service && !allowed.has(service)) context.addIssue({ code: 'custom', message: 'Service tokens must refer to declared preceding services' });
      if (service && container && services.get(service)?.kind === 'process') context.addIssue({ code: 'custom', message: 'Containers cannot reference host process services' });
    }
  };
  const preceding = new Set<string>();
  for (const service of recipe.services) {
    inspect(strings(service.env, service.kind === 'process' ? [service, ...service.setup] : []), preceding, service.kind === 'container');
    preceding.add(service.id);
  }
  inspect(strings(recipe.env, [...recipe.setup, ...recipe.bootstrap, ...recipe.requires]), preceding, false);
  inspect(strings(recipe.env, recipe.start.kind === 'process' ? [recipe.start] : []), preceding, recipe.start.kind === 'container');
});
export type ExecutionRecipe = z.infer<typeof RecipeSchema>;
export type RecipeCommand = z.infer<typeof CommandSchema>;
export type EnvironmentBinding = z.infer<typeof EnvBindingSchema>;
export type RecipeService = z.infer<typeof ServiceSchema>;
export const SourceSettingsSchema = z.strictObject({
  maxBytes: z.number().int().min(1).max(2 * 1024 ** 3).default(1024 ** 3),
  maxFiles: z.number().int().min(1).max(200000).default(100000),
  generatedDirs: z.array(RelativePathSchema.refine((path) => path !== '.', 'A generated directory cannot cover the entire source')).max(32).default([]),
});
export type SourceSettings = z.infer<typeof SourceSettingsSchema>;
