#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { resolve } from 'node:path';
import { parseCli } from './args.js';
import { formatConsentRecipe } from './consent.js';
import { plan } from '../planner/index.js';
import { writePlan } from '../planner/persist.js';
import { compare, compose, failureResult, normalizeFailure } from '../runner/index.js';
import { doctor } from '../runner/doctor.js';
import { cleanOwnedRun } from '../runtime/ownership.js';
import { repositoryRoot } from '../workspace/git.js';
import { ResultSchema } from '../schema/index.js';
import type { CleanReport, DoctorReport, Manifest, Plan, Result } from '../schema/index.js';
import type { CommandContext } from '../schema/contracts.js';
import { failure } from '../schema/errors.js';
import { sanitizeText } from '../schema/io.js';

type Data = Plan | Manifest | DoctorReport | CleanReport;
function requestedCommand(args: readonly string[]): Result<Data>['command'] {
  const first = args.find((arg) => !['--json', '--help', '--version', '-h', '-V'].includes(arg));
  return first === 'plan' || first === 'compose' || first === 'doctor' || first === 'clean' ? first : 'compare';
}
function printResult(result: Result<Data>, json: boolean): void {
  const validated = ResultSchema.parse(result);
  if (json) { process.stdout.write(JSON.stringify(validated) + '\n'); return; }
  process.stdout.write(`${result.command}: ${result.status} (exit ${result.exitCode})\n`);
  if (result.error) process.stderr.write(`${sanitizeText(result.error.message)}\n${sanitizeText(result.error.hint)}\n`);
  if (result.data && 'planId' in result.data) process.stdout.write(`Private plan: .show-what-changed/plan.json\nBEFORE ${result.data.baseCommit}\nAFTER ${result.data.headCommit} (${result.data.headKind})\n`);
  if (result.data && 'captureMode' in result.data) {
    const manifest = result.data;
    process.stdout.write(`Run: .show-what-changed/runs/${manifest.runId}\n${manifest.captureMode === 'motion' ? 'Motion recording' : 'Keyframe replay'}. Verified pairs: ${manifest.summary.verifiedPairs}. Failed side steps: ${manifest.summary.failedSteps}.\n`);
    if (manifest.artifacts.video) process.stdout.write(`Video: .show-what-changed/runs/${manifest.runId}/${manifest.artifacts.video.path}\n`);
  }
  if (result.data && 'capabilities' in result.data) for (const capability of result.data.capabilities) {
    process.stdout.write(`${capability.available ? 'OK' : 'MISSING'} ${capability.name}: ${capability.message}\n`);
    if (!capability.available && capability.setupCommand) process.stdout.write(`  ${capability.setupCommand}\n`);
  }
  for (const warning of result.warnings) process.stderr.write(`${warning.code}: ${sanitizeText(warning.message)}\n`);
}
async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const controller = new AbortController();
  const interrupt = (): void => controller.abort(failure(130, 'SIGINT', 'execution', 'The command was interrupted.', 'Inspect retained artifacts, then rerun when ready.'));
  const terminate = (): void => controller.abort(failure(143, 'SIGTERM', 'execution', 'The command was terminated.', 'Inspect retained artifacts, then rerun when ready.'));
  process.once('SIGINT', interrupt); process.once('SIGTERM', terminate);
  let prompt: ReturnType<typeof createInterface> | undefined;
  let json = args.includes('--json');
  let command = requestedCommand(args);
  try {
    const parsed = parseCli(args, process.cwd(), process.env.CI === 'true');
    json = parsed.json;
    if (parsed.kind === 'help' || parsed.kind === 'version') {
      if (json) printResult({ schemaVersion: 2, command: parsed.command, status: 'ok', exitCode: 0, data: null, error: null, warnings: [{ code: parsed.kind.toUpperCase(), message: sanitizeText(parsed.text.replace(/\r?\n/g, ' ')).trim() }] }, true);
      else process.stdout.write(parsed.text);
      return 0;
    }
    command = parsed.kind;
    const context: CommandContext = {
      invocationDir: process.cwd(), signal: controller.signal, timeoutMs: parsed.kind === 'compare' ? parsed.timeoutMs : 600000,
      diagnostics: { event: (message) => process.stderr.write(sanitizeText(message) + '\n') },
      consent: parsed.kind === 'compare' && parsed.allowExec ? { kind: 'allow-exec' }
        : parsed.kind === 'compare' && !parsed.ci && process.stdin.isTTY && process.stderr.isTTY ? {
          kind: 'interactive', confirm: async (selected, signal) => {
            process.stderr.write(`BEFORE ${selected.baseCommit} (${selected.execution.sourceFileCounts.before} files)\nAFTER ${selected.headCommit} (${selected.headKind}, ${selected.execution.sourceFileCounts.after} files)\n`);
            process.stderr.write(`Source bytes: ${selected.execution.sourceBytes.before} BEFORE, ${selected.execution.sourceBytes.after} AFTER\nRecipe: ${formatConsentRecipe(selected, process.env)}\nRecipe operands are redacted using declared environment and fill values. Review the private plan for complete inputs.\nEnvironment references: ${selected.execution.environmentReferences.join(', ')}\nOutput: .show-what-changed/runs/\n${sanitizeText(selected.execution.notice)}\n`);
            prompt = createInterface({ input: process.stdin, output: process.stderr });
            try { const answer = await prompt.question('Run these commands for this comparison? [y/N] ', { signal }); return /^(?:y|yes)$/i.test(answer.trim()); }
            finally { prompt.close(); prompt = undefined; }
          },
        } : { kind: 'deny' },
    };
    let result: Result<Data>;
    switch (parsed.kind) {
      case 'plan': {
        const selected = await plan(parsed.request, context.signal);
        await writePlan(selected);
        result = { schemaVersion: 2, command: 'plan', status: 'ok', exitCode: 0, data: selected, error: null, warnings: selected.warnings };
        break;
      }
      case 'compare': result = await compare(parsed.request, context); break;
      case 'compose': result = await compose(resolve(context.invocationDir, parsed.runDir), context); break;
      case 'doctor': result = await doctor(context); break;
      case 'clean': {
        const report = await cleanOwnedRun(await repositoryRoot(context.invocationDir), parsed.runId);
        result = { schemaVersion: 2, command: 'clean', status: 'ok', exitCode: 0, data: report, error: null, warnings: [] };
        break;
      }
      default: { const exhaustive: never = parsed; throw new Error(`Unexpected command ${String(exhaustive)}`); }
    }
    printResult(result, json);
    return result.exitCode;
  } catch (error) {
    const result = failureResult<Data>(command, normalizeFailure(error, 'validating'));
    printResult(result, json);
    return result.exitCode;
  } finally {
    prompt?.close();
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate);
  }
}

process.exitCode = await main();
