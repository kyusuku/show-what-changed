import { basename, dirname, extname, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { PlanSchema, parseConfig, parseScenario } from '../schema/index.js';
import type { Config, Plan, Scenario, Warning } from '../schema/index.js';
import type { PlanRequest, SourceInspection } from '../schema/contracts.js';
import { ToolFailure, failure } from '../schema/errors.js';
import { digest, sha256 } from '../schema/io.js';
import { inspectSources, readSourceFile } from '../workspace/source.js';
import { repositoryRoot, utf8 } from '../workspace/git.js';
import { selectScenarios } from './routes.js';

const NETWORK_NOTICE = 'Both complete isolated snapshots run the declared commands with your account privileges and network access after execution consent. Ignored untracked files are not copied. Declared environment and local configuration may expose credentials. This is not a security sandbox. Use read-only or disposable app data. Host-generated build artifacts are unverified.';
const DOCUMENT_LIMIT = 1024 * 1024;
const PLAN_LIMIT = 128 * 1024 * 1024;
const INPUT_LIMIT = 8 * 1024 * 1024;
type ConfigInput = { config: Config; source: NonNullable<Plan['configSource']> };
function isMissing(error: unknown): boolean { return error instanceof Error && 'code' in error && error.code === 'ENOENT'; }
function inputFailure(error: unknown): ToolFailure {
  if (error instanceof ToolFailure) return error;
  if (error instanceof z.ZodError) return failure(2, 'INVALID_INPUT', 'planning', 'The config, scenario, or plan does not match schema version 2.', 'Check the generated schemas and use only the documented fields and bounds.');
  return failure(2, 'INVALID_INPUT', 'planning', 'An input file could not be read or parsed safely.', 'Use regular UTF-8 JSON files within the documented limits. Check paths, permissions, and required fields.');
}
async function document(path: string, limit = DOCUMENT_LIMIT): Promise<{ value: unknown; rawSha256: string }> {
  const input = await readSourceFile(dirname(path), basename(path), undefined, limit);
  if (!input) { const error = new Error('Missing input file'); Object.assign(error, { code: 'ENOENT' }); throw error; }
  return { value: JSON.parse(utf8(input.bytes)), rawSha256: sha256(input.bytes) };
}
export function normalizeConfig(config: Config): Config {
  const cwd = config.appDir;
  return parseConfig({ ...config, execution: { ...config.execution,
    setup: config.execution.setup.map((command) => ({ ...command, cwd: command.cwd ?? cwd })),
    bootstrap: config.execution.bootstrap.map((command) => ({ ...command, cwd: command.cwd ?? cwd })),
    start: config.execution.start.kind === 'process' ? { ...config.execution.start, cwd: config.execution.start.cwd ?? cwd } : config.execution.start,
    services: config.execution.services.map((service) => service.kind === 'process' ? { ...service, cwd: service.cwd ?? cwd, setup: service.setup.map((command) => ({ ...command, cwd: command.cwd ?? service.cwd ?? cwd })) } : service),
  } });
}
async function loadConfig(repoRoot: string, invocationDir: string, configPath?: string): Promise<ConfigInput> {
  const path = configPath === undefined ? resolve(repoRoot, 'show-what-changed.config.json') : resolve(invocationDir, configPath);
  try { const loaded = await document(path); return { config: normalizeConfig(parseConfig(loaded.value)), source: { path, rawSha256: loaded.rawSha256 } }; }
  catch (error) {
    if (isMissing(error)) throw failure(2, 'RECIPE_REQUIRED', 'planning', 'An explicit schema 2 execution recipe is required.', 'Create show-what-changed.config.json or pass --config with appDir, execution.start, and execution.state.');
    throw inputFailure(error);
  }
}
async function bindInputs(config: Config, configDirectory: string, signal?: AbortSignal): Promise<Plan['inputs']> {
  const bound: Plan['inputs'] = []; let bytes = 0;
  for (const input of config.execution.inputs) {
    const path = resolve(configDirectory, input.path);
    const file = await readSourceFile(dirname(path), basename(path), signal, INPUT_LIMIT);
    if (!file) throw failure(2, 'INVALID_INPUT', 'planning', 'A declared recipe input does not exist.', 'Check every execution.inputs path relative to the configuration directory.');
    bytes += file.bytes.length;
    if (bytes > INPUT_LIMIT) throw failure(2, 'INPUT_LIMIT', 'planning', 'Declared recipe inputs exceed the 8 MiB aggregate limit.', 'Reduce the declared helper inputs.');
    bound.push({ id: input.id, path, sha256: sha256(file.bytes), byteLength: file.bytes.length, executable: file.executable, extension: extname(path) });
  }
  return bound;
}
function localExcludedPaths(repoRoot: string, paths: readonly string[]): string[] {
  return paths.map((path) => relative(repoRoot, path).split(sep).join('/')).filter((path) => path !== '..' && !path.startsWith('../'));
}
export function calculatePlanId(plan: Plan): string {
  const content = Object.fromEntries(Object.entries(plan).filter(([key]) => key !== 'planId' && key !== 'generatedAt'));
  return digest(content);
}
function locatorWarnings(scenarios: readonly Scenario[]): Warning[] {
  return scenarios.some((scenario) => scenario.steps.some((step) => 'target' in step && step.target !== undefined && 'css' in step.target))
    ? [{ code: 'CSS_LOCATOR', message: 'CSS locators are exact selectors and may be sensitive to markup changes.' }] : [];
}
function executionSummary(config: Config, stats: Plan['sourceStats']): Plan['execution'] {
  const envs = [config.execution.env, ...config.execution.services.map((service) => service.env)];
  const references = envs.flatMap((env) => Object.values(env).flatMap((binding) => 'fromEnv' in binding ? [binding.fromEnv] : []));
  if (config.execution.pathPrependFromEnv) references.push(config.execution.pathPrependFromEnv);
  return { sourceFileCounts: { before: stats.before.files, after: stats.after.files }, sourceBytes: { before: stats.before.bytes, after: stats.after.bytes }, estimatedSnapshotBytes: stats.before.bytes + stats.after.bytes, environmentReferences: [...new Set(references)].sort(), notice: NETWORK_NOTICE };
}
function validateAppDir(config: Config, inspection: SourceInspection): void {
  if (config.appDir === '.') return;
  if (['before', 'after'].some((side) => !(side === 'before' ? inspection.inventories.before : inspection.inventories.after).some((entry) => entry.exists && entry.path.startsWith(`${config.appDir}/`)))) throw failure(2, 'INVALID_APP_DIR', 'planning', 'The selected appDir is not a source directory at both endpoints.', 'Select a directory present in both complete source snapshots.');
}
export async function plan(request: PlanRequest, signal?: AbortSignal): Promise<Plan> {
  try {
    const repoRoot = await repositoryRoot(request.invocationDir, signal);
    const loaded = await loadConfig(repoRoot, request.invocationDir, request.configPath);
    const inspection = await inspectSources({ ...request, source: loaded.config.source }, signal);
    validateAppDir(loaded.config, inspection);
    const scenarioPaths = request.scenarioPaths?.map((path) => resolve(request.invocationDir, path));
    if (scenarioPaths && (scenarioPaths.length === 0 || scenarioPaths.length > 3)) throw failure(2, 'TOO_MANY_SCENARIOS', 'planning', 'Select between one and three scenario files.', 'Split this comparison into smaller runs.');
    const scenarioDocuments = scenarioPaths ? await Promise.all(scenarioPaths.map(async (path) => ({ path, ...await document(path) }))) : [];
    const scenarios = scenarioPaths ? scenarioDocuments.map((loaded) => parseScenario(loaded.value)) : undefined;
    const inputs = await bindInputs(loaded.config, dirname(loaded.source.path), signal);
    const excludePaths = localExcludedPaths(inspection.repoRoot, [...(scenarioPaths ?? []), loaded.source.path, ...inputs.map((input) => input.path)]);
    const selected = selectScenarios(inspection, loaded.config, { ...(request.routes === undefined ? {} : { routes: request.routes }), ...(scenarios === undefined ? {} : { scenarios }), excludePaths });
    const candidate = PlanSchema.parse({
      schemaVersion: 2, planId: '0'.repeat(64), generatedAt: new Date().toISOString(), repoRoot: inspection.repoRoot,
      requestedBase: inspection.requestedBase, requestedHead: inspection.requestedHead,
      baseCommit: inspection.baseCommit, headCommit: inspection.headCommit, baseResolution: inspection.baseResolution,
      headKind: inspection.headKind, sourceFingerprint: inspection.sourceFingerprint, inventories: inspection.inventories, sourceStats: inspection.stats,
      config: loaded.config, configDigest: digest(loaded.config), configSource: loaded.source,
      scenarioSources: scenarioDocuments.map(({ path, rawSha256 }) => ({ path, rawSha256 })), scenarioDigest: digest(selected.scenarios), inputs,
      scenarios: selected.scenarios, changedFiles: inspection.changedFiles, coverage: selected.coverage,
      execution: executionSummary(loaded.config, inspection.stats), warnings: [...inspection.warnings, ...selected.warnings, ...locatorWarnings(selected.scenarios)],
    });
    return PlanSchema.parse({ ...candidate, planId: calculatePlanId(candidate) });
  } catch (error) { throw inputFailure(error); }
}
export async function loadSavedPlan(path: string, invocationDir: string, signal?: AbortSignal): Promise<Plan> {
  try { const saved = PlanSchema.parse((await document(resolve(invocationDir, path), PLAN_LIMIT)).value); await validateSavedPlan(saved, invocationDir, signal); return saved; }
  catch (error) { throw inputFailure(error); }
}
export async function validateSavedPlan(saved: Plan, invocationDir: string, signal?: AbortSignal): Promise<SourceInspection> {
  const stale = () => failure(2, 'STALE_PLAN', 'validating', 'The saved plan no longer matches its source, recipe, or bound local inputs.', 'Regenerate the plan from the intended source and configuration.');
  if (calculatePlanId(saved) !== saved.planId || digest(normalizeConfig(saved.config)) !== saved.configDigest || digest(saved.scenarios) !== saved.scenarioDigest || digest(executionSummary(saved.config, saved.sourceStats)) !== digest(saved.execution)) throw stale();
  try {
    if (!saved.configSource) throw stale();
    const loaded = await document(saved.configSource.path);
    if (loaded.rawSha256 !== saved.configSource.rawSha256 || digest(normalizeConfig(parseConfig(loaded.value))) !== saved.configDigest) throw stale();
    const scenarios: Scenario[] = [];
    for (const source of saved.scenarioSources) { const current = await document(source.path); if (current.rawSha256 !== source.rawSha256) throw stale(); scenarios.push(parseScenario(current.value)); }
    if (scenarios.length && digest(scenarios) !== saved.scenarioDigest) throw stale();
    if (digest(await bindInputs(saved.config, dirname(saved.configSource.path), signal)) !== digest(saved.inputs)) throw stale();
  } catch { throw stale(); }
  const current = await inspectSources({ invocationDir, base: saved.baseCommit, head: saved.headKind === 'worktree' ? 'WORKTREE' : saved.headCommit, mergeBase: false, source: saved.config.source }, signal);
  if (current.repoRoot !== saved.repoRoot || current.baseCommit !== saved.baseCommit || current.headCommit !== saved.headCommit || current.sourceFingerprint !== saved.sourceFingerprint || digest(current.stats) !== digest(saved.sourceStats) || digest(current.inventories) !== digest(saved.inventories)) throw stale();
  validateAppDir(saved.config, current); return current;
}
