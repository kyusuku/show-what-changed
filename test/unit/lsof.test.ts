import { describe, expect, test } from 'vitest';
import { lsofCapability } from '../../src/runtime/lsof.js';

describe('Linux listener inspection prerequisite', () => {
  test.each(['4.95.0', '4.99.6', '4.99'])('rejects upstream %s with the known Linux process-name bug', (version) => {
    expect(lsofCapability(`lsof version information:\n    revision: ${version}\n`, 'linux')).toEqual({ supported: false, version });
  });
  test.each(['4.99.7', '4.100.0', '5.0.0'])('accepts fixed or newer upstream %s', (version) => {
    expect(lsofCapability(`\nlsof version information:\n    revision: ${version}\n`, 'linux')).toEqual({ supported: true, version });
  });
  test.each(['', 'lsof 4.99.7', 'revision: unknown', 'revision: 4.99.7-beta', 'revision: 4.99.7.1', 'example revision: 9.0.0'])('fails closed for unrecognized Linux output %j', (output) => {
    expect(lsofCapability(output, 'linux').supported).toBe(false);
  });
  test('does not impose the Linux-only minimum on macOS lsof', () => {
    expect(lsofCapability('lsof version information:\n    revision: 4.99.4\n', 'darwin')).toEqual({ supported: true, version: '4.99.4' });
  });
});
