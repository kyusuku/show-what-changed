import { AppPathSchema, ScenarioSchema } from '../schema/index.js';
import type { Config, Coverage, Scenario, Warning } from '../schema/index.js';
import type { SourceInspection } from '../schema/contracts.js';
import { failure } from '../schema/errors.js';
import { sanitizeText, sha256 } from '../schema/io.js';

type RouteCandidate = Coverage['selected'][number];
type Page = { file: string; root: string; route: string; kind: 'static' | 'dynamic' | 'unsupported' };
export type Selection = Readonly<{ routes?: readonly string[]; scenarios?: readonly Scenario[]; excludePaths?: readonly string[] }>;
export type PlannedScenarios = { scenarios: Scenario[]; coverage: Coverage; warnings: Warning[] };
const PAGE = /(?:^|\/)page\.(?:js|jsx|ts|tsx|mdx)$/;
const SCOPED = /(?:^|\/)(?:layout|template|loading|error|not-found)\.(?:js|jsx|ts|tsx|mdx)$/;
const byText = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

function appRoot(paths: readonly string[], appDir: string): string | null {
  const prefix = appDir === '.' ? '' : `${appDir}/`;
  const app = paths.some((path) => path.startsWith(`${prefix}app/`));
  const src = paths.some((path) => path.startsWith(`${prefix}src/app/`));
  if (app && src) throw failure(2, 'AMBIGUOUS_APP_ROOT', 'planning', 'Both app/ and src/app/ are present.', 'Use one supported App Router root.');
  return app ? `${prefix}app/` : src ? `${prefix}src/app/` : null;
}
function pageInfo(file: string, root: string): Page | null {
  if (!file.startsWith(root) || !PAGE.test(file)) return null;
  const segments = file.slice(root.length).split('/').slice(0, -1);
  if (segments.some((part) => part.startsWith('_'))) return null;
  if (segments.some((part) => part.startsWith('@') || /^\(\.{1,3}\)/.test(part))) return { file, root, route: file, kind: 'unsupported' };
  const route = '/' + segments.filter((part) => !/^\([^)]*\)$/.test(part)).join('/');
  if (!AppPathSchema.safeParse(route).success) return { file, root, route: file, kind: 'unsupported' };
  return { file, root, route, kind: segments.some((part) => part.includes('[') || part.includes(']')) ? 'dynamic' : 'static' };
}
function automaticScenario(path: string, ordinal: number): Scenario {
  return ScenarioSchema.parse({
    schemaVersion: 2, id: `route-${ordinal}-${sha256(path).slice(0, 10)}`, title: [...`Review ${sanitizeText(path)}`].slice(0, 160).join(''),
    steps: [{ id: 'open', op: 'goto', path }, { id: 'scroll-1', op: 'scrollBy', y: 640 }, { id: 'scroll-2', op: 'scrollBy', y: 640 }],
  });
}
function docsOnly(path: string): boolean {
  return /(?:^|\/)(?:README|CHANGELOG|CONTRIBUTING|SECURITY|CODE_OF_CONDUCT)(?:\.[^/]+)?$/i.test(path)
    || /^(?:test|tests)\//.test(path) || /\.(?:test|spec)\.[^/]+$/.test(path);
}
function mergeCandidate(bucket: RouteCandidate[], candidate: RouteCandidate): void {
  const found = bucket.find((item) => item.path === candidate.path && item.reason === candidate.reason);
  if (found) found.via = [...new Set([...found.via, ...candidate.via])].sort(byText);
  else bucket.push(candidate);
}
function explicitScenarios(routes: readonly string[], supplied?: readonly Scenario[]): PlannedScenarios {
  if (routes.length === 0 || routes.length > 3 || (supplied?.length ?? 0) > 3) {
    throw failure(2, 'TOO_MANY_SCENARIOS', 'planning', 'Select between one and three routes or scenarios.', 'Split this comparison into smaller runs.');
  }
  const parsed = routes.map((route) => AppPathSchema.parse(route));
  const scenarios = supplied ? [...supplied] : [...new Set(parsed)].map((route, index) => automaticScenario(route, index));
  if (new Set(scenarios.map((scenario) => scenario.id)).size !== scenarios.length) throw failure(2, 'DUPLICATE_SCENARIO', 'planning', 'Scenario IDs must be unique.', 'Give each supplied scenario a distinct ID.');
  return {
    scenarios,
    coverage: { selected: [...new Set(parsed)].map((path) => ({ path, reason: 'EXPLICIT_SELECTION', via: [] })), unresolved: [], omitted: [], unsupported: [], complete: false },
    warnings: [{ code: 'EXPLICIT_SELECTION', message: 'Only the selected routes are compared. Changed-route coverage is not exhaustive.' }],
  };
}

export function selectScenarios(inspection: SourceInspection, config: Config, selection: Selection = {}): PlannedScenarios {
  if (selection.routes !== undefined && selection.scenarios !== undefined) throw failure(2, 'CONFLICTING_SELECTION', 'planning', 'Routes and scenarios cannot be selected together.', 'Use either --route or --scenario.');
  const paths = {
    before: inspection.inventories.before.filter((entry) => entry.exists).map((entry) => entry.path),
    after: inspection.inventories.after.filter((entry) => entry.exists).map((entry) => entry.path),
  };
  if (selection.scenarios !== undefined) {
    const scenarios = selection.scenarios.map((scenario) => ScenarioSchema.parse(scenario));
    const routes = scenarios.map((scenario) => {
      const first = scenario.steps[0];
      if (first?.op !== 'goto') throw failure(2, 'INVALID_SCENARIO', 'planning', 'Each scenario must start with goto.', 'Start each scenario with an app-relative navigation.');
      return first.path;
    });
    return explicitScenarios(routes, scenarios);
  }
  if (selection.routes !== undefined) return explicitScenarios(selection.routes);
  if (config.routes.include.length > 0) return explicitScenarios(config.routes.include);
  const roots = { before: appRoot(paths.before, config.appDir), after: appRoot(paths.after, config.appDir) };
  const excluded = new Set(['show-what-changed.config.json', ...(selection.excludePaths ?? [])]);
  const changedPaths = [...new Set(inspection.changedFiles.flatMap((entry) => [entry.oldPath, entry.newPath].filter((path): path is string => path !== null)))].filter((path) => !excluded.has(path) && !path.startsWith('.show-what-changed/'));
  if (changedPaths.length === 0) throw failure(4, 'NOTHING_CHANGED', 'planning', 'No changed source files or explicit routes were selected.', 'Make a UI change or pass --route for an explicit comparison.');
  const ignored = docsOnly;
  if (changedPaths.every(ignored)) throw failure(4, 'NO_UI_CANDIDATES', 'planning', 'Only conventional documentation or test files changed.', 'Pass --route to compare a specific page anyway.');
  const coverage: Coverage = { selected: [], unresolved: [], omitted: [], unsupported: [], complete: false };
  if (!roots.before || !roots.after) throw failure(2, 'ROUTE_REQUIRED', 'planning', 'Applications without discoverable App Router pages require an explicit route or scenario.', 'Pass --route, --scenario, or configure routes.include.');
  const pages: Page[] = [];
  for (const side of ['before', 'after'] as const) {
    const root = roots[side];
    if (root === null) continue;
    for (const file of paths[side]) {
      const page = pageInfo(file, root);
      if (page && !pages.some((existing) => existing.file === page.file)) pages.push(page);
    }
  }
  const candidates = new Map<string, { candidate: RouteCandidate; rank: number }>();
  const addPage = (page: Page, via: string, rank: number): void => {
    const reason = rank === 0 ? 'DIRECT_PAGE_CHANGE' : 'SCOPED_ROUTE_CHANGE';
    if (page.kind === 'unsupported') {
      mergeCandidate(coverage.unsupported, { path: page.file, reason: 'UNSUPPORTED_ROUTE_STRUCTURE', via: [via], nonselectionReason: 'Use an explicit route and scenario.' });
      return;
    }
    const concrete = page.kind === 'dynamic' ? config.routes.params[page.route] : [page.route];
    if (!concrete?.length) {
      mergeCandidate(coverage.unresolved, { path: page.route, reason: 'DYNAMIC_SAMPLE_REQUIRED', via: [via], nonselectionReason: 'Configure routes.params or pass --route.' });
      return;
    }
    for (const route of concrete) {
      const existing = candidates.get(route);
      const files = [...new Set([...(existing?.candidate.via ?? []), via])].sort(byText);
      if (!existing || rank < existing.rank) candidates.set(route, { candidate: { path: route, reason, via: files }, rank });
      else existing.candidate.via = files;
    }
  };
  for (const path of changedPaths) {
    if (ignored(path)) continue;
    const direct = pages.filter((page) => page.file === path);
    if (direct.length) { for (const page of direct) addPage(page, path, 0); continue; }
    const root = [roots.before, roots.after].find((root) => root !== null && path.startsWith(root));
    if (root && SCOPED.test(path)) {
      const directory = path.slice(0, path.lastIndexOf('/') + 1);
      const descendants = pages.filter((page) => page.file.startsWith(directory));
      if (descendants.length) { for (const page of descendants) addPage(page, path, 1); continue; }
    }
    mergeCandidate(coverage.unresolved, { path, reason: 'UNRESOLVED_CHANGE', via: [path], nonselectionReason: 'Pass --route or a scenario that exercises this change.' });
  }
  const ranked = [...candidates.values()].sort((a, b) => a.rank - b.rank || byText(a.candidate.path, b.candidate.path));
  coverage.selected = ranked.slice(0, 3).map((item) => item.candidate);
  coverage.omitted = ranked.slice(3).map((item) => ({ ...item.candidate, nonselectionReason: 'AUTO_SCENARIO_LIMIT' }));
  coverage.unresolved.sort((a, b) => byText(a.path, b.path));
  coverage.unsupported.sort((a, b) => byText(a.path, b.path));
  coverage.complete = coverage.unresolved.length === 0 && coverage.unsupported.length === 0 && coverage.omitted.length === 0;
  if (coverage.selected.length === 0) throw failure(2, 'ROUTE_REQUIRED', 'planning', 'Changed files could affect the UI, but no concrete route was resolved.', 'Pass --route or --scenario; dynamic pages need explicit samples.');
  return {
    scenarios: coverage.selected.map((route, index) => automaticScenario(route.path, index)), coverage,
    warnings: coverage.complete ? [] : [{ code: 'INCOMPLETE_COVERAGE', message: 'Some possible UI changes are unresolved, unsupported, or omitted. Automatic comparison will be partial.' }],
  };
}
