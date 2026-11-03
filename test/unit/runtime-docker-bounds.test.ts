import { expect, test } from 'vitest';
import { boundedDockerArguments } from './runtime-docker-bounds.js';
const profile = { buildkitImage: 'moby/buildkit@sha256:' + 'a'.repeat(64), buildkitConfig: '/private/owned/buildkitd.toml' };
test('fixture builders retain explicit names and receive one-core512MiB bounds plus private serial worker config', () => {
  const args = boundedDockerArguments(['--config', '/private/owned/client', 'buildx', 'create', '--name', 'owned-builder', '--node', 'owned-node', '--driver', 'docker-container', '--bootstrap'], profile);
  expect(args).toEqual(expect.arrayContaining(['--name', 'owned-builder', '--node', 'owned-node', 'memory=512m', 'memory-swap=512m', 'cpu-period=100000', 'cpu-quota=100000', `image=${profile.buildkitImage}`, '--buildkitd-config', profile.buildkitConfig]));
  expect(args).not.toContain('--use');
});
test('fixture PostgreSQL gets512MiB while static apps get128MiB and both get half a core', () => {
  const db = boundedDockerArguments(['container', 'create', '--env', 'POSTGRES_PASSWORD', 'immutable-db-image'], profile);
  const app = boundedDockerArguments(['container', 'create', '--env', 'PORT', 'immutable-app-image'], profile);
  expect(db.slice(0, 8)).toEqual(['container', 'create', '--memory', '512m', '--memory-swap', '512m', '--cpus', '0.5']);
  expect(app.slice(0, 8)).toEqual(['container', 'create', '--memory', '128m', '--memory-swap', '128m', '--cpus', '0.5']);
  expect(db.at(-1)).toBe('immutable-db-image'); expect(app.at(-1)).toBe('immutable-app-image');
});
test('fixture transport leaves inspection, explicit build selection, and exact cleanup commands unchanged', () => {
  for (const args of [['container', 'inspect', 'owned-id'], ['buildx', 'build', '--builder', 'owned-builder', '.'], ['buildx', 'rm', '--force', 'owned-builder']]) expect(boundedDockerArguments(args, profile)).toEqual(args);
});
