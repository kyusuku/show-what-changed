import { access, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import type { CommandContext, RunContext } from '../schema/contracts.js';
import type { DoctorReport, Result } from '../schema/index.js';
import { DoctorReportSchema } from '../schema/index.js';
import { createRunContext, cleanupRun } from '../runtime/context.js';
import { inspectOwnedRuns } from '../runtime/ownership.js';
import { systemProbe } from '../runtime/process-table.js';
import { lsofCapability, LSOF_SETUP } from '../runtime/lsof.js';
import { openBrowser } from '../runtime/browser.js';
import { dockerCapabilities } from '../runtime/docker.js';
import { checkMediaCapabilities } from '../composer/index.js';
import { repositoryRoot, GIT_OPTIONS } from '../workspace/git.js';
import { checkCancelled, cancellation, failure } from '../schema/errors.js';
import { sanitizeText } from '../schema/io.js';
import { failureResult, normalizeFailure } from './index.js';

export async function doctor(context: CommandContext): Promise<Result<DoctorReport>> {
  const report: DoctorReport = { schemaVersion: 2, platform: `${process.platform}-${process.arch}`, capabilities: [], abandonedRuns: [] };
  const record = (name: string, available: boolean, version: string | null, message: string, setupCommand: string | null = null): void => { report.capabilities.push({ name, available, version, message, setupCommand }); };
  let root: string | undefined;
  let run: RunContext | undefined;
  const warnings: Result<DoctorReport>['warnings'] = [];
  try {
    checkCancelled(context.signal);
    record('node', /^v24\./.test(process.version), process.version, 'Node 24.x is the supported runtime.', 'Install Node 24.x.');
    for (const [name, argv] of [
      ['git', ['git', ...GIT_OPTIONS, '--version']],
      ['lsof', ['lsof', '-v']], ['ps', ['ps', '-p', String(process.pid), '-o', 'pid=']],
      ['ffmpeg', [process.env.SWC_FFMPEG ?? 'ffmpeg', '-version']], ['ffprobe', [process.env.SWC_FFPROBE ?? 'ffprobe', '-version']],
    ] satisfies [string, string[]][]) {
      try {
        const probe = await systemProbe(argv, 10000, context.signal);
        if (name === 'lsof') {
          const capability = lsofCapability(`${probe.stdout}\n${probe.stderr}`);
          const available = probe.code === 0 && capability.supported;
          record(name, available, capability.version, available ? 'Supported lsof executable probe passed.' : 'A supported lsof executable is required for reliable listener ownership checks.', available ? null : LSOF_SETUP);
          continue;
        }
        const available = probe.code === 0;
        record(name, available, available ? sanitizeText((probe.stdout || probe.stderr).split('\n')[0] ?? '').slice(0, 256) : null, available ? 'Executable probe passed.' : 'Executable probe failed.', available ? null : `Install ${name} from your operating system package manager.`);
      } catch { record(name, false, null, 'Executable is unavailable.', name === 'lsof' ? LSOF_SETUP : `Install ${name} from your operating system package manager.`); }
    }
    checkCancelled(context.signal);
    const docker = await dockerCapabilities(context.signal);
    checkCancelled(context.signal);
    record('docker', docker.available, docker.version, 'Optional for host recipes. Docker Engine is required for container recipes.', docker.available ? null : 'Install and start a local Docker Engine.');
    record('buildx', docker.buildx !== null, docker.buildx, 'Optional for host recipes. The buildx plugin is required for container builds.', docker.buildx ? null : 'Install the Docker buildx plugin.');
    try {
      const font = await readFile(new URL('../../assets/fonts/Inter-Regular.woff2', import.meta.url));
      record('font', font.subarray(0, 4).toString('ascii') === 'wOF2', 'Inter 4.1 Regular', 'Bundled local font asset checked.');
    } catch { record('font', false, null, 'Bundled font is missing.', 'Reinstall show-what-changed.'); }
    let browserInstalled = false;
    try { await access(chromium.executablePath(), constants.X_OK); browserInstalled = true; } catch { browserInstalled = false; }
    root = await realpath(await mkdtemp(join(tmpdir(), 'show-what-changed-doctor-')));
    try {
      run = await createRunContext({ repoRoot: root, timeoutMs: 60000, signal: context.signal, diagnostics: context.diagnostics });
      if (browserInstalled) {
        try { const browser = await openBrowser(run); record('chromium', true, browser.version(), 'Pinned Chromium launch passed.'); await browser.close(); }
        catch { record('chromium', false, null, 'Pinned Chromium could not launch.', 'Run show-what-changed setup. If Chromium still cannot launch, install the operating system browser libraries listed at https://github.com/kyusuku/show-what-changed/blob/main/docs/installation.md#linux-setup.'); }
      } else record('chromium', false, null, 'Pinned Chromium is not installed.', 'Run show-what-changed setup.');
      try { await checkMediaCapabilities(run); record('h264', true, null, 'A real libx264 encode and ffprobe decoded-frame check passed.'); }
      catch { record('h264', false, null, 'H.264 encoding or decoded-media validation failed.', 'Install matching FFmpeg and ffprobe with libx264 support.'); }
    } catch {
      if (!report.capabilities.some((capability) => capability.name === 'chromium')) record('chromium', false, null, 'Browser probe needs working process inspection.', 'Install ps and lsof, then rerun doctor.');
      record('h264', false, null, 'Encoding probe needs working process inspection.', 'Install ps and lsof, then rerun doctor.');
    }
    checkCancelled(context.signal);
    try { report.abandonedRuns = await inspectOwnedRuns(await repositoryRoot(context.invocationDir)); }
    catch { warnings.push({ code: 'RUN_INSPECTION_UNAVAILABLE', message: 'No readable repository run inventory was available from this directory.' }); }
  } catch (error) { return { ...failureResult<DoctorReport>('doctor', cancellation(context.signal) ?? normalizeFailure(error, 'doctor')), warnings }; }
  finally {
    const cleanup = run ? await cleanupRun(run) : null;
    if (cleanup?.status === 'failed') warnings.push({ code: 'DOCTOR_CLEANUP_FAILED', message: 'A temporary capability probe needs manual cleanup.' });
    else if (root) await rm(root, { recursive: true, force: true });
  }
  const missing = report.capabilities.some((capability) => !capability.available && capability.name !== 'docker' && capability.name !== 'buildx') || warnings.some((warning) => warning.code === 'DOCTOR_CLEANUP_FAILED');
  return { schemaVersion: 2, command: 'doctor', status: missing ? 'failed' : 'ok', exitCode: missing ? 8 : 0, data: DoctorReportSchema.parse(report), error: missing ? failure(8, 'ENVIRONMENT_INCOMPLETE', 'doctor', 'One or more required capabilities are unavailable.', 'Follow the individual setup commands, then rerun doctor.').detail : null, warnings };
}
