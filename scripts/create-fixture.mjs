#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const fixtureSource = fileURLToPath(new URL('../fixtures/next-app-basic/', import.meta.url));
const afterRevision = `export default {
  name: 'after',
  accent: '#d24b27',
  headline: 'Flexible plans for growing teams.',
  description: 'Build your next big idea together, with room to grow.',
  yearly: true,
  pageHeight: 1900,
};
`;

export function createFixture(destination) {
  const repoRoot = destination ? resolve(destination) : mkdtempSync(join(tmpdir(), 'swc-next-fixture-'));
  if (existsSync(repoRoot) && (!lstatSync(repoRoot).isDirectory() || lstatSync(repoRoot).isSymbolicLink() || readdirSync(repoRoot).length !== 0)) {
    throw new Error('Fixture destination must be a new or empty regular directory.');
  }
  mkdirSync(repoRoot, { recursive: true });
  cpSync(fixtureSource, repoRoot, {
    recursive: true,
    filter: (source) => !['node_modules', '.next', '.git', '.show-what-changed', 'output'].includes(source.split('/').at(-1)),
  });
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Synthetic Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Synthetic Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    GIT_AUTHOR_DATE: '2026-01-15T10:00:00+00:00', GIT_COMMITTER_DATE: '2026-01-15T10:00:00+00:00',
    LC_ALL: 'C', TZ: 'UTC',
  };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_') && !['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_AUTHOR_DATE', 'GIT_COMMITTER_DATE'].includes(key)) delete env[key];
  }
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgSign=false', '-c', 'tag.gpgSign=false', ...args], { cwd: repoRoot, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '--initial-branch=main', '--object-format=sha1', '--template=');
  git('config', 'user.name', 'Synthetic Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'core.hooksPath', '/dev/null');
  git('config', 'core.autocrlf', 'false');
  git('add', '--all');
  git('commit', '--no-verify', '-m', 'Fixture base pricing');
  git('tag', 'fixture-base');
  const baseCommit = git('rev-parse', 'HEAD');
  writeFileSync(join(repoRoot, 'app/revision.js'), afterRevision);
  git('add', '--all');
  git('commit', '--no-verify', '-m', 'Fixture yearly pricing');
  git('tag', 'fixture-head');
  const headCommit = git('rev-parse', 'HEAD');
  return { repoRoot, baseCommit, headCommit, baseRef: 'fixture-base', headRef: 'fixture-head' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length > 2 || (args.length === 2 && args[0] !== '--dir') || args[0]?.startsWith('-') && args[0] !== '--dir' || args[0] === '--dir' && args.length !== 2) {
    process.stderr.write('Usage: node scripts/create-fixture.mjs [destination | --dir destination]\n');
    process.exitCode = 2;
  } else {
    try { process.stdout.write(`${JSON.stringify(createFixture(args[0] === '--dir' ? args[1] : args[0]), null, 2)}\n`); }
    catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
  }
}
