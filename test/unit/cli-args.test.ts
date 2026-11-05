import { describe, expect, it } from 'vitest';
import { parseCli } from '../../src/cli/args.js';

describe('T01 CLI flags and T14 single-command selection', () => {
  it('defaults to compare with per-run consent absent', () => {
    expect(parseCli([], '/repo')).toMatchObject({ kind: 'compare', allowExec: false, ci: false, timeoutMs: 1800000, request: { kind: 'new', request: { invocationDir: '/repo' } } });
  });
  it('accepts root and trailing JSON flags', () => {
    expect(parseCli(['--json', 'plan', '--route', '/pricing'], '/repo')).toMatchObject({ kind: 'plan', json: true, request: { routes: ['/pricing'] } });
    expect(parseCli(['plan', '--route', '/pricing', '--json'], '/repo')).toMatchObject({ kind: 'plan', json: true });
  });
  it('keeps command-like ref values as ref values', () => {
    expect(parseCli(['--base', 'plan', '--head', 'doctor', '--allow-exec'], '/repo')).toMatchObject({ kind: 'compare', request: { kind: 'new', request: { base: 'plan', head: 'doctor' } }, allowExec: true });
  });
  it('accepts bounded saved-plan execution and CI environment', () => {
    expect(parseCli(['compare', '--plan', 'plan.json', '--timeout', '3600'], '/repo', true)).toMatchObject({ kind: 'compare', request: { kind: 'saved', path: 'plan.json' }, timeoutMs: 3600000, ci: true });
  });
  it.each([
    ['--yes'], ['--browser', 'firefox'], ['plan', '--allow-exec'], ['doctor', '--route', '/'],
    ['compose'], ['clean'], ['clean', 'one', 'two'], ['compare', '--route', '/', '--scenario', 's.json'],
    ['compare', '--plan', 'p.json', '--base', 'HEAD'], ['compare', '--plan', 'p.json', '--merge-base'],
    ['compare', '--timeout', '0'], ['compare', '--timeout', '3601'], ['compare', '--timeout', '1.5'], ['unknown'],
  ].map((args) => ({ args })))('rejects unsupported or conflicting arguments $args', ({ args }) => {
    expect(() => parseCli(args, '/repo')).toThrowError();
  });
  it('describes motion recipes and supports common help and version flags', () => {
    expect(parseCli(['--help'], '/repo')).toMatchObject({ kind: 'help', text: expect.stringMatching(/motion\s+video/) });
    expect(parseCli(['plan', '--help'], '/repo')).toMatchObject({ kind: 'help', text: expect.stringContaining('--route') });
    expect(parseCli(['doctor', '--version', '--json'], '/repo')).toMatchObject({ kind: 'version', json: true, text: '0.1.1\n' });
  });
});
