import { describe, expect, it } from 'vitest';
import { parseConfig, parseScenario } from '../../src/schema/index.js';
import type { SourceInspection } from '../../src/schema/contracts.js';
import { selectScenarios } from '../../src/planner/routes.js';

function inspection(before: string[], after: string[], changed: string[]): SourceInspection {
  const entries = (paths: string[]) => paths.map((path) => ({ path, exists: true as const, executable: false, byteLength: 1, sha256: 'a'.repeat(64) }));
  return { repoRoot: '/repo', requestedBase: 'HEAD', requestedHead: 'WORKTREE', baseCommit: 'a'.repeat(40), headCommit: 'b'.repeat(40), baseResolution: 'exact', headKind: 'worktree', inventories: { before: entries(before), after: entries(after) }, sourceFingerprint: 'c'.repeat(64), changedFiles: changed.map((path) => ({ status: before.includes(path) && !after.includes(path) ? 'D' : !before.includes(path) && after.includes(path) ? 'A' : 'M', oldPath: before.includes(path) ? path : null, newPath: after.includes(path) ? path : null })), stats: { before: { files: before.length, bytes: before.length, fingerprint: 'a'.repeat(64) }, after: { files: after.length, bytes: after.length, fingerprint: 'b'.repeat(64) } }, warnings: [] };
}
const execution = { start: { kind: 'process', argv: ['node', 'server.mjs', '{port}'] }, state: { kind: 'stateless' } };
const config = parseConfig({ schemaVersion: 2, execution });
function failed(call: () => unknown): unknown { try { call(); return null; } catch (error) { return error; } }

describe('T05 conservative route selection', () => {
  it('maps grouped pages and creates exactly three aligned actions', () => {
    const paths = ['app/(marketing)/pricing/page.tsx', 'app/page.tsx'];
    const result = selectScenarios(inspection(paths, paths, [paths[0]!]), config);
    expect(result.coverage.selected.map((route) => route.path)).toEqual(['/pricing']);
    expect(result.scenarios[0]?.steps.map((step) => step.op)).toEqual(['goto', 'scrollBy', 'scrollBy']);
    expect(result.coverage.complete).toBe(true);
  });
  it('includes descendants of a scoped layout from both endpoints', () => {
    const before = ['app/page.tsx', 'app/shop/layout.tsx', 'app/shop/old/page.tsx', 'app/blog/page.tsx'];
    const after = ['app/page.tsx', 'app/shop/layout.tsx', 'app/shop/new/page.tsx', 'app/blog/page.tsx'];
    const result = selectScenarios(inspection(before, after, ['app/shop/layout.tsx']), config);
    expect(result.coverage.selected.map((route) => route.path)).toEqual(['/shop/new', '/shop/old']);
  });
  it('ranks direct pages ahead of scoped descendants and reports the cap', () => {
    const paths = ['app/page.tsx', 'app/a/page.tsx', 'app/b/page.tsx', 'app/z/page.tsx', 'app/layout.tsx'];
    const result = selectScenarios(inspection(paths, paths, ['app/layout.tsx', 'app/z/page.tsx']), config);
    expect(result.coverage.selected.map((route) => route.path)).toEqual(['/z', '/', '/a']);
    expect(result.coverage.omitted.map((route) => route.path)).toEqual(['/b']);
    expect(result.coverage.complete).toBe(false);
  });
  it('requires dynamic samples and respects an explicit sample', () => {
    const paths = ['src/app/page.tsx', 'src/app/blog/[slug]/page.tsx'];
    const source = inspection(paths, paths, ['src/app/blog/[slug]/page.tsx']);
    expect(failed(() => selectScenarios(source, config))).toMatchObject({ exitCode: 2, detail: { code: 'ROUTE_REQUIRED' } });
    const sampled = parseConfig({ schemaVersion: 2, execution, routes: { params: { '/blog/[slug]': ['/blog/example'] } } });
    expect(selectScenarios(source, sampled).coverage.selected[0]?.path).toBe('/blog/example');
  });
  it('reports mixed known and unknown changes as incomplete', () => {
    const paths = ['app/page.tsx', 'components/button.tsx'];
    const result = selectScenarios(inspection(paths, paths, paths), config);
    expect(result.coverage.selected[0]?.path).toBe('/');
    expect(result.coverage.unresolved).toHaveLength(1);
    expect(result.coverage.complete).toBe(false);
  });
  it('reports slots and intercepting routes without inventing a concrete path', () => {
    const paths = ['app/page.tsx', 'app/@modal/(.)photo/page.tsx'];
    const result = selectScenarios(inspection(paths, paths, paths), config);
    expect(result.coverage.selected.map((route) => route.path)).toEqual(['/']);
    expect(result.coverage.unsupported).toHaveLength(1);
    expect(result.coverage.complete).toBe(false);
  });
  it('keeps explicit route overrides bounded without claiming exhaustive coverage', () => {
    const paths = ['app/page.tsx', 'components/button.tsx'];
    const configured = parseConfig({ schemaVersion: 2, execution, routes: { include: ['/configured'] } });
    const result = selectScenarios(inspection(paths, paths, ['components/button.tsx']), configured, { routes: ['/chosen'] });
    expect(result.coverage.selected.map((route) => route.path)).toEqual(['/chosen']);
    expect(result.coverage.selected[0]?.reason).toBe('EXPLICIT_SELECTION');
    expect(result.coverage.complete).toBe(false);
    expect(result.coverage.unresolved).toEqual([]);
  });
  it('accepts explicit scenarios for added pages without inventing missing-side permission', () => {
    const before = ['app/page.tsx'];
    const after = [...before, 'app/new/page.tsx'];
    const scenario = parseScenario({ schemaVersion: 2, id: 'new', title: 'New route', steps: [{ id: 'open', op: 'goto', path: '/new', only: 'after' }] });
    const result = selectScenarios(inspection(before, after, ['app/new/page.tsx']), config, { scenarios: [scenario] });
    expect(result.scenarios).toEqual([scenario]);
    const auto = selectScenarios(inspection(before, after, ['app/new/page.tsx']), config);
    expect(auto.scenarios[0]?.steps[0]?.only).toBe('both');
  });
  it('differentiates unchanged, proven docs-only and unresolved work', () => {
    const paths = ['app/page.tsx', 'README.md', 'package.json'];
    expect(failed(() => selectScenarios(inspection(paths, paths, []), config))).toMatchObject({ exitCode: 4, detail: { code: 'NOTHING_CHANGED' } });
    expect(failed(() => selectScenarios(inspection(paths, paths, ['README.md']), config))).toMatchObject({ exitCode: 4, detail: { code: 'NO_UI_CANDIDATES' } });
    expect(failed(() => selectScenarios(inspection(paths, paths, ['package.json']), config))).toMatchObject({ exitCode: 2, detail: { code: 'ROUTE_REQUIRED' } });
    expect(selectScenarios(inspection(paths, paths, []), config, { routes: ['/'] }).scenarios).toHaveLength(1);
  });
  it('rejects ambiguous app roots and too many explicit routes', () => {
    const paths = ['app/page.tsx', 'src/app/page.tsx'];
    expect(failed(() => selectScenarios(inspection(paths, paths, paths), config))).toMatchObject({ exitCode: 2, detail: { code: 'AMBIGUOUS_APP_ROOT' } });
    const single = inspection(['app/page.tsx'], ['app/page.tsx'], ['app/page.tsx']);
    expect(failed(() => selectScenarios(single, config, { routes: ['/a', '/b', '/c', '/d'] }))).toMatchObject({ exitCode: 2, detail: { code: 'TOO_MANY_SCENARIOS' } });
  });
});


it('scopes Next discovery to appDir and keeps shared package changes unresolved', () => {
  const paths = ['app/unrelated/page.tsx', 'apps/web/src/app/page.tsx', 'apps/web/src/app/shop/page.tsx', 'packages/shared/button.tsx'];
  const scoped = parseConfig({ schemaVersion: 2, appDir: 'apps/web', execution });
  const result = selectScenarios(inspection(paths, paths, ['apps/web/src/app/page.tsx', 'packages/shared/button.tsx']), scoped);
  expect(result.coverage.selected.map((candidate) => candidate.path)).toEqual(['/']);
  expect(result.coverage.unresolved.map((candidate) => candidate.path)).toEqual(['packages/shared/button.tsx']);
});
it('explicit selection bypasses missing or ambiguous automatic discovery', () => {
  for (const paths of [['index.html'], ['server.py'], ['app/page.tsx', 'src/app/page.tsx']]) {
    const result = selectScenarios(inspection(paths, paths, paths), config, { routes: ['/chosen'] });
    expect(result.coverage).toMatchObject({ complete: false, selected: [{ path: '/chosen', reason: 'EXPLICIT_SELECTION' }], unresolved: [] });
  }
});


it.each(['content/article.md', 'docs/landing.md', 'app/api/data/route.ts', 'app/_components/button.tsx'])('keeps ambiguous UI inputs unresolved at %s', (path) => {
  const paths = ['app/page.tsx', path];
  const result = selectScenarios(inspection(paths, paths, paths), config);
  expect(result.coverage.selected.map((candidate) => candidate.path)).toEqual(['/']);
  expect(result.coverage.unresolved.map((candidate) => candidate.path)).toEqual([path]);
  expect(result.coverage.complete).toBe(false);
  expect(failed(() => selectScenarios(inspection(paths, paths, [path]), config))).toMatchObject({ exitCode: 2, detail: { code: 'ROUTE_REQUIRED' } });
});
