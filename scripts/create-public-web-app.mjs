#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const fixtureSource = fileURLToPath(new URL('../fixtures/public-web-app/', import.meta.url));
const feedbackRelativePath = 'packages/board-data/src/feedback.mjs';

export function createPublicWebApp(destination) {
  const repoRoot = destination ? resolve(destination) : mkdtempSync(join(tmpdir(), 'swc-public-workshop-'));
  if (existsSync(repoRoot) && (!lstatSync(repoRoot).isDirectory() || lstatSync(repoRoot).isSymbolicLink() || readdirSync(repoRoot).length !== 0)) {
    throw new Error('Public example destination must be a new or empty regular directory.');
  }
  mkdirSync(repoRoot, { recursive: true });
  cpSync(fixtureSource, repoRoot, {
    recursive: true,
    filter: (source) => !['node_modules', 'dist', '.git', '.show-what-changed'].includes(source.split('/').at(-1)),
  });
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
  Object.assign(env, {
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Workshop board example', GIT_AUTHOR_EMAIL: 'workshop@example.invalid',
    GIT_COMMITTER_NAME: 'Workshop board example', GIT_COMMITTER_EMAIL: 'workshop@example.invalid',
    GIT_AUTHOR_DATE: '2026-01-15T10:00:00+00:00', GIT_COMMITTER_DATE: '2026-01-15T10:00:00+00:00',
    LC_ALL: 'C', TZ: 'UTC',
  });
  const gitAt = (cwd, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgSign=false', '-c', 'tag.gpgSign=false', ...args], { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const git = (...args) => gitAt(repoRoot, ...args);
  git('init', '--initial-branch=main', '--object-format=sha1', '--template=');
  git('config', 'core.hooksPath', '/dev/null');
  git('config', 'core.autocrlf', 'false');
  git('add', '--all');
  git('commit', '--no-verify', '-m', 'Add the public workshop board');
  git('tag', 'fixture-base');
  const baseCommit = git('rev-parse', 'HEAD');
  const candidateRoot = mkdtempSync(join(tmpdir(), 'swc-public-candidate-'));
  rmdirSync(candidateRoot);
  let candidateAdded = false;
  let headCommit;
  try {
    git('worktree', 'add', '--detach', candidateRoot, baseCommit);
    candidateAdded = true;
    writeFileSync(join(candidateRoot, feedbackRelativePath), readFileSync(join(repoRoot, 'acceptance/feedback.after.mjs')));
    gitAt(candidateRoot, 'add', '--', feedbackRelativePath);
    gitAt(candidateRoot, 'commit', '--no-verify', '-m', 'Explain invalid task details');
    gitAt(candidateRoot, 'tag', 'fixture-head');
    headCommit = gitAt(candidateRoot, 'rev-parse', 'HEAD');
    if (git('diff', '--name-only', baseCommit, headCommit) !== feedbackRelativePath) throw new Error('The public candidate must change only its feedback source.');
  } finally {
    if (candidateAdded) git('worktree', 'remove', '--force', candidateRoot);
  }
  git('merge', '--ff-only', headCommit);
  if (git('status', '--porcelain') !== '') throw new Error('The generated public example must be clean.');
  return {
    repoRoot, baseCommit, headCommit, baseRef: 'fixture-base', headRef: 'fixture-head',
    configPath: join(repoRoot, 'show-what-changed.config.json'),
    scenarios: {
      navigation: join(repoRoot, 'acceptance/navigation.scenario.json'),
      validation: join(repoRoot, 'acceptance/validation.scenario.json'),
    },
    feedbackPath: join(repoRoot, feedbackRelativePath), feedbackRelativePath,
    worktreeReplacement: { from: 'Two details need attention', to: 'Ready for one final check' },
    expectedValidation: {
      before: { title: 'Check the task details', message: 'Add a longer title and a valid contact email.', tone: 'neutral' },
      after: { title: 'Two details need attention', message: 'Use at least 6 characters for the title and an email such as maker@example.invalid.', tone: 'guided' },
    },
    checkpoints: { navigation: 'library-inner-scroll', validation: 'validation-feedback' },
    viewport: { width: 390, height: 844 },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length > 2 || (args.length === 2 && args[0] !== '--dir') || args[0]?.startsWith('-') && args[0] !== '--dir' || args[0] === '--dir' && args.length !== 2) {
    process.stderr.write('Usage: node scripts/create-public-web-app.mjs [destination | --dir destination]\n');
    process.exitCode = 2;
  } else {
    try { process.stdout.write(`${JSON.stringify(createPublicWebApp(args[0] === '--dir' ? args[1] : args[0]), null, 2)}\n`); }
    catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
  }
}
