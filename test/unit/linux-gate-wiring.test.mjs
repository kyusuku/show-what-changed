import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({ files: new Map(), calls: [], exits: {}, report: null, currentStage: null }));
vi.mock('node:child_process', () => ({
  spawn: (executable, args, options) => {
    const id = state.currentStage;
    state.calls.push({ id, executable, args, options });
    const child = new EventEmitter();
    child.stdout = child.stderr = { pipe() {} };
    setImmediate(() => child.emit('close', state.exits[id] ?? 0, null));
    return child;
  },
}));
vi.mock('node:fs', () => ({ createWriteStream: (path) => {
  if (path.endsWith('.stdout.log')) state.currentStage = path.split('/').at(-1).replace('.stdout.log', '');
  return { end(done) { done(); } };
} }));
vi.mock('node:fs/promises', () => ({
  mkdir: async () => {}, copyFile: async () => {}, cp: async () => {},
  readFile: async (path) => {
    if (state.files.has(path)) return state.files.get(path);
    if (path.startsWith('/sys/') || path.startsWith('/proc/')) return 'oom_kill 0\n';
    throw new Error(`Unexpected gate input ${path}`);
  },
  writeFile: async (path, data) => {
    if (path.endsWith('/result.json')) state.report = JSON.parse(data);
  },
}));

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const originalVersion = process.version;
let originalExitCode;
beforeEach(() => {
  originalExitCode = process.exitCode;
  Object.defineProperty(process, 'version', { value: 'v24.22.2', configurable: true });
  vi.resetModules();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  state.files.clear(); state.calls.length = 0; state.exits = {}; state.report = null;
  const source = Buffer.from('Synthetic source archive.');
  const candidate = Buffer.from('Synthetic candidate archive.');
  state.files.set('/tmp/swc-source.tar', source);
  state.files.set('/tmp/swc-candidate.tgz', candidate);
  state.files.set('/tmp/swc-gate-input.json', JSON.stringify({ mode: 'release', sourceArchiveSha256: digest(source), tarballSha256: digest(candidate) }));
  state.files.set('/home/pwuser/project/package.json', JSON.stringify({ scripts: {} }));
  state.files.set('/home/pwuser/gate-evidence/package-smoke/report.json', JSON.stringify({ status: 'passed', root: '/tmp/synthetic-fresh-install', candidate: { sha256: digest(candidate) } }));
  state.files.set('/home/pwuser/gate-evidence/installed-motion/motion-check.json', JSON.stringify({ status: 'numeric-passed', completeRepetitionMatrix: true, visualReview: { status: 'pending' } }));
  for (const name of ['host-compatibility', 'public-app']) state.files.set(`/home/pwuser/gate-evidence/${name}/report.json`, JSON.stringify({ pending: [`Independent ${name} review remains pending.`] }));
});
afterEach(() => {
  Object.defineProperty(process, 'version', { value: originalVersion, configurable: true });
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
});

test('Linux release verification reuses the matching fresh installed package for the full motion matrix and retains visual review', async () => {
  await import('../../scripts/linux-gate/container.mjs');
  const motion = state.calls.find(({ id }) => id === 'installed-motion');
  expect(motion.args).toEqual(['scripts/revision-0.3-motion-check.mjs', '--installed-root', '/tmp/synthetic-fresh-install/installed/node_modules/show-what-changed', '--output-dir', '/home/pwuser/gate-evidence/installed-motion']);
  expect(state.calls.findIndex(({ id }) => id === 'package-source-binding')).toBeLessThan(state.calls.findIndex(({ id }) => id === 'package-smoke'));
  expect(state.calls.findIndex(({ id }) => id === 'package-smoke')).toBeLessThan(state.calls.findIndex(({ id }) => id === 'installed-motion'));
  expect(state.report).toMatchObject({ status: 'passed', platformChecksComplete: true, releaseGateComplete: false, notRunStages: [], motionCheck: { status: 'numeric-passed', completeRepetitionMatrix: true, visualReview: 'pending' } });
  expect(state.report.pendingAcceptance).toContain('Review each installed motion recording at normal playback speed.');
  expect(process.exitCode).toBe(0);
});

test('a failed package smoke prevents motion execution and records every unstarted release stage', async () => {
  state.exits['package-smoke'] = 1;
  await import('../../scripts/linux-gate/container.mjs');
  expect(state.calls.some(({ id }) => id === 'installed-motion')).toBe(false);
  expect(state.report).toMatchObject({ status: 'failed', platformChecksComplete: false, releaseGateComplete: false, notRunStages: ['installed-motion', 'host-compatibility', 'public-app', 'repeatability'] });
  expect(state.report.stages.find(({ id }) => id === 'package-smoke').exitCode).toBe(1);
  expect(process.exitCode).toBe(1);
});

test.each([
  { status: 'failed', root: '/tmp/synthetic-fresh-install', candidate: { sha256: digest(Buffer.from('Synthetic candidate archive.')) } },
  { status: 'passed', root: '/tmp/synthetic-fresh-install', candidate: { sha256: 'a'.repeat(64) } },
  { status: 'passed', root: 'relative-install', candidate: { sha256: digest(Buffer.from('Synthetic candidate archive.')) } },
])('a zero-exit smoke cannot supply an unsuccessful, mismatched, or relative installation', async (smoke) => {
  state.files.set('/home/pwuser/gate-evidence/package-smoke/report.json', JSON.stringify(smoke));
  await import('../../scripts/linux-gate/container.mjs');
  expect(state.calls.some(({ id }) => id === 'installed-motion')).toBe(false);
  expect(state.report).toMatchObject({ status: 'failed', platformChecksComplete: false });
  expect(state.report.notRunStages).toContain('installed-motion');
});

test.each([
  { status: 'failed', completeRepetitionMatrix: false },
  { status: 'numeric-passed', completeRepetitionMatrix: false },
])('a zero-exit motion command cannot complete the platform without a passing full matrix', async (motion) => {
  state.files.set('/home/pwuser/gate-evidence/installed-motion/motion-check.json', JSON.stringify(motion));
  await import('../../scripts/linux-gate/container.mjs');
  expect(state.calls.some(({ id }) => id === 'installed-motion')).toBe(true);
  expect(state.report).toMatchObject({ status: 'failed', platformChecksComplete: false, notRunStages: ['host-compatibility', 'public-app', 'repeatability'] });
});

test('a source snapshot remains incomplete for platform release verification and starts no installed-package stages', async () => {
  const input = JSON.parse(state.files.get('/tmp/swc-gate-input.json'));
  state.files.set('/tmp/swc-gate-input.json', JSON.stringify({ ...input, mode: 'snapshot' }));
  await import('../../scripts/linux-gate/container.mjs');
  expect(state.calls.some(({ id }) => id === 'installed-motion' || id === 'package-smoke')).toBe(false);
  expect(state.report).toMatchObject({ status: 'passed', platformChecksComplete: false, releaseGateComplete: false });
  expect(state.report.unmetReleaseGates).toContain('Installed-package and repeatability gates require --release.');
});
