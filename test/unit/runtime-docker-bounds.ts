import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';

export type DockerTestProfile = Readonly<{ buildkitImage: string; buildkitConfig: string }>;
export function boundedDockerArguments(argv: readonly string[], profile: DockerTestProfile): string[] {
  const builder = argv.findIndex((value, index) => value === 'buildx' && argv[index + 1] === 'create');
  if (builder >= 0) return [...argv.slice(0, builder + 2), '--driver-opt', 'memory=512m', '--driver-opt', 'memory-swap=512m', '--driver-opt', 'cpu-period=100000', '--driver-opt', 'cpu-quota=100000', '--driver-opt', `image=${profile.buildkitImage}`, '--buildkitd-config', profile.buildkitConfig, ...argv.slice(builder + 2)];
  const container = argv.findIndex((value, index) => value === 'container' && argv[index + 1] === 'create');
  if (container >= 0) {
    const memory = argv.some((value, index) => value === '--env' && argv[index + 1] === 'POSTGRES_PASSWORD') ? '512m' : '128m';
    return [...argv.slice(0, container + 2), '--memory', memory, '--memory-swap', memory, '--cpus', '0.5', ...argv.slice(container + 2)];
  }
  return [...argv];
}
export function runBoundedDockerCommand(options: DockerTestProfile & { executable: string; argv: readonly string[]; recordPath: string }): void {
  const argv = boundedDockerArguments(options.argv, options);
  if (argv.length !== options.argv.length) appendFileSync(options.recordPath, JSON.stringify({ at: new Date().toISOString(), argv }) + '\n', { mode: 0o600 });
  const child = spawn(options.executable, argv, { stdio: 'inherit', detached: false });
  child.once('error', () => { process.stderr.write('The fixture Docker executable could not start.\n'); process.exitCode = 1; });
  child.once('exit', (code) => { process.exitCode = code ?? 1; });
}
