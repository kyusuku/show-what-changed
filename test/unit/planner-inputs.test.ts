import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, test } from 'vitest';
import { calculatePlanId, loadSavedPlan, plan, validateSavedPlan } from '../../src/planner/index.js';
import { writePlan } from '../../src/planner/persist.js';
import { PlanSchema } from '../../src/schema/index.js';

const execute = promisify(execFile); const roots: string[] = [];
async function git(root: string, ...args: string[]): Promise<string> { return (await execute('git', args, { cwd: root })).stdout.trim(); }
const recipe = { start: { kind: 'process', argv: ['node', 'sentinel.mjs', '{port}'] }, state: { kind: 'stateless' } };
async function fixture(): Promise<{ root: string; repo: string; config: string; scenario: string; helper: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'swc-planner-inputs-'))); roots.push(root); const repo = join(root, 'repo'); await mkdir(repo);
  await git(repo, 'init', '-q'); await git(repo, 'config', 'user.name', 'Planner fixture'); await git(repo, 'config', 'user.email', 'fixture@example.invalid');
  await mkdir(join(repo, 'apps/web'), { recursive: true }); await mkdir(join(repo, 'packages/shared'), { recursive: true });
  await writeFile(join(repo, 'apps/web/index.html'), '<h1>General web app</h1>'); await writeFile(join(repo, 'packages/shared/module.js'), 'export const shared = 1;');
  await writeFile(join(repo, 'apps/web/sentinel.mjs'), "import fs from 'node:fs';fs.writeFileSync('PLANNER-EXECUTED','bad');");
  await writeFile(join(repo, '.gitignore'), '.show-what-changed/\n'); await git(repo, 'add', '.'); await git(repo, 'commit', '-qm', 'manifest-free application');
  const helper = join(root, 'helper.mjs'); await writeFile(helper, 'export const helper = true;'); await chmod(helper, 0o700);
  const config = join(root, 'config.json'); await writeFile(config, JSON.stringify({ schemaVersion: 2, appDir: 'apps/web', execution: { ...recipe, inputs: [{ id: 'helper', path: 'helper.mjs' }], env: { API: { fromEnv: 'TEST_API' } }, setup: [{ argv: ['node', '{input.helper}'] }] } }));
  const scenario = join(root, 'scenario.json'); await writeFile(scenario, JSON.stringify({ schemaVersion: 2, id: 'view', title: 'View page', steps: [{ id: 'open', op: 'goto', path: '/' }] }));
  return { root, repo, config, scenario, helper };
}
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true }))); });

test('pure planning binds whole-repository source, normalized cwd, documents, and exact helper inputs', async () => {
  const files = await fixture();
  await writeFile(join(files.repo, 'source with\nnewline.txt'), 'preserved filename');
  await writeFile(join(files.repo, 'C:source.txt'), 'POSIX relative filename');
  const selected = await plan({ invocationDir: files.repo, configPath: files.config, scenarioPaths: [files.scenario] });
  expect(selected.config.execution.start).toMatchObject({ cwd: 'apps/web' }); expect(selected.config.execution.setup[0]).toMatchObject({ cwd: 'apps/web' });
  expect(selected.inputs).toMatchObject([{ id: 'helper', path: files.helper, executable: true, extension: '.mjs', byteLength: 27 }]);
  expect(selected.execution.environmentReferences).toEqual(['TEST_API']);
  expect(selected.inventories.after).toContainEqual(expect.objectContaining({ path: 'packages/shared/module.js' }));
  expect(selected.inventories.after).toContainEqual(expect.objectContaining({ path: 'source with\nnewline.txt' }));
  expect(selected.inventories.after).toContainEqual(expect.objectContaining({ path: 'C:source.txt' }));
  expect(selected.execution.estimatedSnapshotBytes).toBe(selected.sourceStats.before.bytes + selected.sourceStats.after.bytes);
  await expect(readFile(join(files.repo, 'apps/web/PLANNER-EXECUTED'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(validateSavedPlan(selected, files.repo)).resolves.toMatchObject({ headCommit: selected.headCommit });
});

test.each(['config', 'scenario', 'helper', 'helper-mode'] as const)('saved plans reject changed bound %s inputs', async (kind) => {
  const files = await fixture(); const selected = await plan({ invocationDir: files.repo, configPath: files.config, scenarioPaths: [files.scenario] });
  if (kind === 'helper-mode') await chmod(files.helper, 0o600);
  else { const path = kind === 'config' ? files.config : kind === 'scenario' ? files.scenario : files.helper; await writeFile(path, (await readFile(path, 'utf8')) + '\n'); }
  await expect(validateSavedPlan(selected, files.repo)).rejects.toMatchObject({ exitCode: 2, detail: { code: 'STALE_PLAN' } });
});

test('explicit commit plans stay pinned when their requested refs move', async () => {
  const files = await fixture(); await git(files.repo, 'branch', 'selected');
  const selected = await plan({ invocationDir: files.repo, configPath: files.config, routes: ['/'], head: 'selected' });
  await writeFile(join(files.repo, 'later.txt'), 'later'); await git(files.repo, 'add', '.'); await git(files.repo, 'commit', '-qm', 'later'); await git(files.repo, 'branch', '-f', 'selected', 'HEAD');
  const current = await validateSavedPlan(selected, files.repo);
  expect(current.headCommit).toBe(selected.headCommit); expect(await git(files.repo, 'rev-parse', 'selected')).not.toBe(selected.headCommit);
});

test('WORKTREE plans require the same pinned HEAD even if its source tree is identical', async () => {
  const files = await fixture(); const selected = await plan({ invocationDir: files.repo, configPath: files.config, routes: ['/'] });
  await git(files.repo, 'commit', '--allow-empty', '-qm', 'same bytes, changed commit');
  await expect(validateSavedPlan(selected, files.repo)).rejects.toMatchObject({ detail: { code: 'STALE_PLAN' } });
});

test('binds only declared helpers and rejects symlink ancestors and the aggregate cap', async () => {
  const files = await fixture(); const secret = join(files.root, 'undeclared-secret'); await writeFile(secret, 'not an input');
  const selected = await plan({ invocationDir: files.repo, configPath: files.config, routes: ['/'] }); expect(selected.inputs.map((input) => input.path)).toEqual([files.helper]);
  await mkdir(join(files.root, 'private')); await writeFile(join(files.root, 'private/helper.mjs'), 'helper'); await symlink('private', join(files.root, 'link'));
  const config = JSON.parse(await readFile(files.config, 'utf8')); config.execution.inputs = [{ id: 'helper', path: 'link/helper.mjs' }]; await writeFile(files.config, JSON.stringify(config));
  await expect(plan({ invocationDir: files.repo, configPath: files.config, routes: ['/'] })).rejects.toMatchObject({ exitCode: 2 });
  const large = Buffer.alloc(5 * 1024 * 1024); await writeFile(files.helper, large); await writeFile(join(files.root, 'second.mjs'), large);
  config.execution.inputs = [{ id: 'helper', path: 'helper.mjs' }, { id: 'second', path: 'second.mjs' }]; await writeFile(files.config, JSON.stringify(config));
  await expect(plan({ invocationDir: files.repo, configPath: files.config, routes: ['/'] })).rejects.toMatchObject({ detail: { code: 'INPUT_LIMIT' } });
});

test('saved plan persistence accepts plans above the old 1 MiB limit and validates their bound inputs', async () => {
  const files = await fixture(); const selected = await plan({ invocationDir: files.repo, configPath: files.config, routes: ['/'] });
  const large = PlanSchema.parse({ ...selected, warnings: [{ code: 'MANY_PATHS', message: 'Measured source paths', files: Array.from({ length: 8000 }, (_, index) => `path-${index}-${'x'.repeat(150)}`) }] });
  large.planId = calculatePlanId(large);
  expect(Buffer.byteLength(JSON.stringify(large))).toBeGreaterThan(1024 * 1024);
  await writePlan(large); await writePlan(large);
  const actual = await loadSavedPlan('.show-what-changed/plan.json', files.repo); expect(actual.planId).toBe(large.planId);
});

test('missing recipe fails with an actionable schema 2 requirement', async () => {
  const files = await fixture(); await expect(plan({ invocationDir: files.repo, routes: ['/'] })).rejects.toMatchObject({ detail: { code: 'RECIPE_REQUIRED' } });
});


test.each(['static', 'python', 'npm', 'pnpm'])('plans the public %s fixture without running setup or server commands', async (kind) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'swc-general-plan-'))); roots.push(root); const repo = join(root, 'repo');
  await cp(new URL(`../../fixtures/general-app/${kind}/`, import.meta.url), repo, { recursive: true });
  await git(repo, 'init', '-q'); await git(repo, 'config', 'user.name', 'General fixture'); await git(repo, 'config', 'user.email', 'fixture@example.invalid');
  await git(repo, 'add', '.'); await git(repo, 'commit', '-qm', 'Synthetic general app');
  const selected = await plan({ invocationDir: repo });
  expect(selected.scenarios[0]?.steps[0]).toMatchObject({ op: 'goto', path: '/' });
  expect(selected.coverage).toMatchObject({ complete: false, selected: [{ reason: 'EXPLICIT_SELECTION' }] });
  if (kind === 'static' || kind === 'python') expect(selected.inventories.after.some((entry) => entry.path === 'package.json')).toBe(false);
  if (kind === 'pnpm') { expect(selected.config.appDir).toBe('apps/web'); expect(selected.inventories.after).toContainEqual(expect.objectContaining({ path: 'packages/shared/index.js' })); }
  await expect(readFile(join(repo, 'node_modules/.package-lock.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});
