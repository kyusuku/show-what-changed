import { randomBytes } from 'node:crypto';
import { chmod, lstat, rm } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import type { AuthStorageState, RunContext, Workspace } from '../schema/contracts.js';
import type { Plan, Side } from '../schema/index.js';
import type { ExecutionRecipe, EnvironmentBinding } from '../schema/recipe.js';
import { recipeTokens } from '../schema/recipe.js';
import { checkCancelled, failure } from '../schema/errors.js';
import { sha256 } from '../schema/io.js';
import { atomicPrivateFile, readContainedFile, safeDirectory } from './files.js';

export type BoundEnvironment = Readonly<{ bindings: ReadonlyMap<EnvironmentBinding, string>; path: string; sensitiveValues: readonly string[]; registerSensitiveValues: (values: readonly string[]) => void }>;
export type ServiceEndpoint =
  | Readonly<{ kind: 'process'; id: string; port: number }>
  | Readonly<{ kind: 'container'; id: string; port: number; alias: string; containerPort: number }>;
export type SideInputs = Readonly<{ directory: string; stateDir: string; inputDir: string; files: ReadonlyMap<string, string> }>;
export type Consumer = Readonly<{ side: Side; port: number; origin: string; container: boolean; inputs: SideInputs; services: readonly ServiceEndpoint[]; runId: string }>;

export async function bindEnvironment(recipe: ExecutionRecipe, run: Pick<RunContext, 'redactions'>): Promise<BoundEnvironment> {
  const bindings = new Map<EnvironmentBinding, string>();
  const sensitiveValues: string[] = []; const known = new Set<string>();
  const registerSensitiveValues = (values: readonly string[]): void => { for (const value of values) if (value && !known.has(value)) { known.add(value); sensitiveValues.push(value); } run.redactions.add(values); };
  for (const map of [recipe.env, ...recipe.services.map((service) => service.env)]) for (const binding of Object.values(map)) {
    if ('fromEnv' in binding) {
      const value = process.env[binding.fromEnv];
      if (value === undefined || value.includes('\0') || value.length > 32768) throw failure(6, 'MISSING_ENVIRONMENT', 'starting', 'A declared application environment reference is missing.', 'Set every named environment reference before retrying.');
      bindings.set(binding, value); registerSensitiveValues([value]);
    } else registerSensitiveValues(['literal' in binding ? binding.literal : binding.template]);
  }
  let path = process.env.PATH ?? '';
  if (recipe.pathPrependFromEnv) {
    const directory = process.env[recipe.pathPrependFromEnv];
    if (!directory || !isAbsolute(directory) || directory.includes(':') || directory.includes('\0')) throw failure(6, 'INVALID_RUNTIME_PATH', 'starting', 'The declared runtime path is not one absolute directory.', 'Set the named variable to one executable directory.');
    const stat = await lstat(directory).catch(() => null);
    if (!stat?.isDirectory()) throw failure(6, 'INVALID_RUNTIME_PATH', 'starting', 'The declared runtime directory is unavailable.', 'Select an existing executable directory.');
    path = `${directory}:${path}`; registerSensitiveValues([directory]);
  }
  return { bindings, path, sensitiveValues, registerSensitiveValues };
}
export function resolveToken(token: string, consumer: Consumer): string {
  switch (token) {
    case '{port}': return String(consumer.port);
    case '{origin}': return consumer.origin;
    case '{stateDir}': return consumer.container ? '/swc-state' : consumer.inputs.stateDir;
    case '{side}': return consumer.side;
    case '{runId}': return consumer.runId;
  }
  const input = /^\{input\.(.+)\}$/.exec(token)?.[1];
  if (input) {
    const file = consumer.inputs.files.get(input);
    if (file) return consumer.container ? `/swc-inputs/${file}` : join(consumer.inputs.inputDir, file);
  }
  const service = /^\{service\.(.+)\.(host|port)\}$/.exec(token);
  if (service) {
    const endpoint = consumer.services.find((entry) => entry.id === service[1]);
    if (endpoint && (!consumer.container || endpoint.kind === 'container')) {
      if (service[2] === 'host') return consumer.container && endpoint.kind === 'container' ? endpoint.alias : '127.0.0.1';
      return String(consumer.container && endpoint.kind === 'container' ? endpoint.containerPort : endpoint.port);
    }
  }
  throw failure(6, 'INVALID_RECIPE_TOKEN', 'starting', 'A recipe token has no valid resource in this consumer.', 'Use declared inputs and preceding compatible services.');
}
export function commandArguments(argv: readonly string[], consumer: Consumer): string[] {
  return argv.map((argument) => {
    const tokens = recipeTokens(argument);
    if (!tokens.length && !/[{}]/.test(argument)) return argument;
    if (tokens.length !== 1 || tokens[0] !== argument) throw failure(6, 'INVALID_RECIPE_TOKEN', 'starting', 'Recipe argv tokens must occupy a whole argument.', 'Use environment templates for embedded values.');
    return resolveToken(argument, consumer);
  });
}
export function applicationEnvironment(map: ExecutionRecipe['env'], binding: BoundEnvironment, consumer: Consumer): Record<string, string> {
  const env: Record<string, string> = { PATH: binding.path };
  for (const [name, value] of Object.entries(map)) {
    if ('literal' in value) env[name] = value.literal;
    else if ('fromEnv' in value) {
      const resolved = binding.bindings.get(value);
      if (resolved === undefined) throw failure(6, 'MISSING_ENVIRONMENT', 'starting', 'A declared environment binding was not resolved.', 'Replan and retry with the complete environment.');
      env[name] = resolved;
    } else {
      let resolved = value.template;
      for (const token of recipeTokens(value.template)) resolved = resolved.split(token).join(resolveToken(token, consumer));
      env[name] = resolved;
    }
  }
  binding.registerSensitiveValues(Object.values(env));
  return env;
}
export async function commandCwd(workspace: Workspace, cwd: string | undefined): Promise<string> {
  const path = resolve(workspace.root, cwd ?? '.');
  const offset = relative(workspace.root, path);
  if (offset === '..' || offset.startsWith(`..${sep}`) || isAbsolute(offset)) throw failure(6, 'INVALID_COMMAND_CWD', 'starting', 'The command directory escapes its source snapshot.', 'Use a directory inside the application snapshot.');
  await safeDirectory(path);
  return path;
}
export async function prepareInputs(plan: Pick<Plan, 'inputs'>, run: RunContext, side: Side, bytes: ReadonlyMap<string, Buffer>): Promise<SideInputs> {
  const directory = join(run.paths.privateDir, 'execution', side, randomBytes(8).toString('hex'));
  run.resources.register({ kind: 'private-dir', identity: directory, dispose: async () => { try { await safeDirectory(directory); } catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return; throw error; } await rm(directory, { recursive: true, force: true }); } });
  await safeDirectory(directory, true);
  const stateDir = join(directory, 'state'); const inputDir = join(directory, 'inputs');
  await safeDirectory(stateDir, true); await safeDirectory(inputDir, true);
  await chmod(stateDir, 0o777); await chmod(inputDir, 0o755);
  run.redactions.add([directory, stateDir, inputDir, ...plan.inputs.map((input) => input.path)]);
  const files = new Map<string, string>();
  for (const input of plan.inputs) {
    checkCancelled(run.signal);
    const data = bytes.get(input.id);
    if (!data) throw failure(6, 'INPUT_CHANGED', 'starting', 'A bound helper input is unavailable.', 'Replan with stable helper files.');
    const file = `${input.id}${input.extension}`; run.redactions.add([join(inputDir, file)]);
    await atomicPrivateFile(inputDir, file, data, false);
    await chmod(join(inputDir, file), input.executable ? 0o755 : 0o644);
    files.set(input.id, file);
  }
  return { directory, stateDir, inputDir, files };
}
export async function readBoundInputs(plan: Plan, run: RunContext): Promise<ReadonlyMap<string, Buffer>> {
  const bytes = new Map<string, Buffer>();
  if (plan.config.execution.inputs.length !== plan.inputs.length) throw failure(6, 'INPUT_CHANGED', 'starting', 'The bound helper inputs do not match the recipe.', 'Replan before execution.');
  for (const input of plan.inputs) {
    checkCancelled(run.signal);
    const declared = plan.config.execution.inputs.find((entry) => entry.id === input.id);
    const directory = plan.configSource ? dirname(plan.configSource.path) : plan.repoRoot;
    if (!declared || resolve(directory, declared.path) !== input.path || extname(input.path) !== input.extension) throw failure(6, 'INPUT_CHANGED', 'starting', 'A bound helper identity does not match the recipe.', 'Replan with the current helper declarations.');
    const data = await readContainedFile(dirname(input.path), input.path.slice(dirname(input.path).length + 1), 8 * 1024 * 1024).catch(() => { throw failure(6, 'INPUT_CHANGED', 'starting', 'A bound helper file changed or is unavailable.', 'Replan with stable regular helper files.'); });
    const stat = await lstat(input.path);
    if (data.length !== input.byteLength || sha256(data) !== input.sha256 || Boolean(stat.mode & 0o111) !== input.executable || !plan.config.execution.inputs.some((declared) => declared.id === input.id)) throw failure(6, 'INPUT_CHANGED', 'starting', 'A bound helper file changed after planning.', 'Replan with the current helper file.');
    bytes.set(input.id, data);
  }
  return bytes;
}
const CookieSchema = z.strictObject({ name: z.string().min(1).max(4096).regex(/^[^\x00-\x20\x7f()<>@,;:\"/\[\]?={}]+$/), value: z.string().max(32768).regex(/^[^\x00-\x1f\x7f]*$/), domain: z.string().min(1).max(253), path: z.string().max(4096).regex(/^\/[^\x00-\x1f\x7f]*$/), expires: z.number().finite().min(-1), httpOnly: z.boolean(), secure: z.boolean(), sameSite: z.enum(['Strict', 'Lax', 'None']), partitionKey: z.string().optional() });
const StorageSchema = z.strictObject({ cookies: z.array(CookieSchema).max(1024), origins: z.array(z.strictObject({ origin: z.string(), localStorage: z.array(z.strictObject({ name: z.string(), value: z.string() })).max(4096), indexedDB: z.array(z.unknown()).max(128).optional() })).max(16) });
export async function readAuthState(recipe: ExecutionRecipe, inputs: SideInputs, origin: string, run: RunContext): Promise<AuthStorageState | null> {
  if (!recipe.auth) return null;
  try {
    const data = await readContainedFile(inputs.stateDir, recipe.auth.storageState, 1024 * 1024);
    const state = StorageSchema.parse(JSON.parse(data.toString('utf8')));
    run.redactions.add([...state.cookies.map((cookie) => cookie.value), ...state.origins.flatMap((entry) => entry.localStorage.map((item) => item.value))]);
    const url = new URL(origin);
    if (state.origins.some((entry) => entry.origin !== origin) || state.cookies.some((cookie) => cookie.domain !== url.hostname || cookie.partitionKey !== undefined && cookie.partitionKey !== origin)) throw new Error('Wrong authentication origin');
    if (state.origins.some((entry) => entry.indexedDB !== undefined)) throw new Error('IndexedDB authentication is not supported');
    return { cookies: state.cookies.map((cookie) => ({ ...cookie })), origins: state.origins.map((entry) => ({ origin: entry.origin, localStorage: entry.localStorage.map((item) => ({ ...item })) })) };
  } catch { throw failure(6, 'INVALID_AUTH_STATE', 'starting', 'Application authentication state is invalid or belongs to another origin.', 'Write bounded Playwright storage state for this side after readiness.'); }
}
