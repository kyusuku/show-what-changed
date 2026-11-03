import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { checkCancelled, failure } from '../schema/errors.js';

const execute = promisify(execFile);
export type ProcessRow = { pid: number; parent: number; group: number; started: string };
export function childEnvironment(runId: string, side?: string, port?: number): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'CI']) if (process.env[name] !== undefined) env[name] = process.env[name];
  env.BROWSER = 'none'; env.NEXT_TELEMETRY_DISABLED = '1'; env.SWC_RUN_ID = runId;
  if (side !== undefined) env.SWC_SIDE = side;
  if (port !== undefined) env.PORT = String(port);
  return env;
}
export async function systemProbe(argv: readonly string[], timeout = 1500, signal?: AbortSignal): Promise<{ stdout: string; stderr: string; code: number }> {
  if (signal) checkCancelled(signal);
  const [command, ...args] = argv;
  if (!command) throw new TypeError('Empty probe');
  try { const result = await execute(command, args, { encoding: 'utf8', env: { ...childEnvironment('probe'), LC_ALL: 'C' }, timeout, maxBuffer: 5 * 1024 * 1024, ...(signal ? { signal } : {}) }); return { stdout: result.stdout, stderr: result.stderr, code: 0 }; }
  catch (error) {
    if (signal) checkCancelled(signal);
    if (error instanceof Error && 'code' in error && typeof error.code === 'number' && 'stdout' in error && typeof error.stdout === 'string') return { stdout: error.stdout, stderr: 'stderr' in error && typeof error.stderr === 'string' ? error.stderr : '', code: error.code };
    throw failure(8, 'MISSING_CAPABILITY', 'runtime', `Required system probe ${command} could not run.`, 'Install the required system tool and retry.');
  }
}
export async function processTable(): Promise<ProcessRow[]> {
  const { stdout, code } = await systemProbe(['ps', '-axo', 'pid=,ppid=,pgid=,stat=,lstart=']);
  if (code !== 0) throw failure(8, 'PROCESS_INSPECTION_FAILED', 'runtime', 'Process ownership could not be inspected.', 'Ensure ps is available and process inspection is allowed.');
  return stdout.split('\n').filter((line) => line.trim()).flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (!match?.[1] || !match[2] || !match[3] || !match[4] || !match[5]) throw failure(8, 'PROCESS_INSPECTION_FAILED', 'runtime', 'Unexpected process inspection output.', 'Use a supported Linux or macOS host.');
    if (match[4].startsWith('Z')) return [];
    return [{ pid: Number(match[1]), parent: Number(match[2]), group: Number(match[3]), started: match[5] }];
  });
}
export async function groupMembers(group: number): Promise<ProcessRow[]> { return (await processTable()).filter((row) => row.group === group); }
