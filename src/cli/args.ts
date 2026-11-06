import { Command, CommanderError } from 'commander';
import { z } from 'zod';
import type { CompareRequest, PlanRequest } from '../schema/contracts.js';
import type { Result } from '../schema/index.js';
import { TOOL_VERSION } from '../schema/index.js';
import { failure, ToolFailure } from '../schema/errors.js';
import { sanitizeText } from '../schema/io.js';

type CommandName = Result<unknown>['command'];
type Flags = { json: boolean };
export type ParsedCommand =
  | (Flags & { kind: 'plan'; request: PlanRequest })
  | (Flags & { kind: 'compare'; request: CompareRequest; allowExec: boolean; ci: boolean; timeoutMs: number })
  | (Flags & { kind: 'compose'; runDir: string })
  | (Flags & { kind: 'doctor' | 'setup' })
  | (Flags & { kind: 'clean'; runId: string })
  | (Flags & { kind: 'help'; command: CommandName; text: string })
  | (Flags & { kind: 'version'; command: CommandName; text: string });
const OptionsSchema = z.strictObject({
  json: z.boolean().optional(), base: z.string().optional(), head: z.string().optional(), mergeBase: z.boolean().optional(),
  route: z.array(z.string()).optional(), scenario: z.array(z.string()).optional(), config: z.string().optional(),
  plan: z.string().optional(), allowExec: z.boolean().optional(), ci: z.boolean().optional(), timeout: z.string().optional(),
});
function collect(value: string, previous: string[] | undefined): string[] { return [...(previous ?? []), value]; }
function sourceFlags(command: Command): Command {
  return command.option('--base <ref>', 'Exact BEFORE ref, default HEAD')
    .option('--head <ref>', 'Exact AFTER ref or WORKTREE, default WORKTREE')
    .option('--merge-base', 'Use the unique merge base as BEFORE')
    .option('--route <path>', 'Explicit app-relative route, repeat up to three times', collect)
    .option('--scenario <file>', 'Versioned JSON scenario, repeat up to three times', collect)
    .option('--config <file>', 'JSON config path relative to the invocation directory');
}
function common(command: Command): Command {
  return command.option('--json', 'Write exactly one versioned JSON result').version(TOOL_VERSION)
    .allowExcessArguments(false).exitOverride();
}
function planRequest(options: z.infer<typeof OptionsSchema>, invocationDir: string): PlanRequest {
  return { invocationDir,
    ...(options.base === undefined ? {} : { base: options.base }), ...(options.head === undefined ? {} : { head: options.head }),
    ...(options.mergeBase === undefined ? {} : { mergeBase: options.mergeBase }), ...(options.route === undefined ? {} : { routes: options.route }),
    ...(options.scenario === undefined ? {} : { scenarioPaths: options.scenario }), ...(options.config === undefined ? {} : { configPath: options.config }),
  };
}
function commandName(value: string | undefined): CommandName {
  return value === 'plan' || value === 'compose' || value === 'doctor' || value === 'setup' || value === 'clean' ? value : 'compare';
}
export function parseCli(args: readonly string[], invocationDir: string, ciEnvironment = false): ParsedCommand {
  const output: string[] = [];
  const program = common(new Command()).name('show-what-changed')
    .description('Compare web applications from isolated Git snapshots as a BEFORE | AFTER motion video using an explicit execution recipe. Keyframes are an explicit alternative.')
    .addHelpCommand(false).showHelpAfterError(false).showSuggestionAfterError(false)
    .configureOutput({ writeOut: (text) => output.push(text), writeErr: () => {}, outputError: () => {} });
  let parsed: ParsedCommand | undefined;
  let active: CommandName = 'compare';
  const accept = (name: CommandName, command: Command, argument?: string): void => {
    active = name;
    const options = OptionsSchema.parse(command.optsWithGlobals());
    const json = options.json ?? false;
    if (options.route !== undefined && options.scenario !== undefined) throw failure(2, 'CONFLICTING_SELECTION', 'arguments', '--route and --scenario cannot be used together.', 'Choose routes or scenario files for this invocation.');
    if (name === 'plan') { parsed = { kind: 'plan', json, request: planRequest(options, invocationDir) }; return; }
    if (name === 'compare') {
      if (options.plan !== undefined && [options.base, options.head, options.mergeBase, options.route, options.scenario, options.config].some((value) => value !== undefined)) throw failure(2, 'PLAN_OVERRIDE', 'arguments', '--plan cannot be combined with source, config, route, or scenario overrides.', 'Regenerate the plan with the desired overrides, then compare it.');
      const timeout = options.timeout ?? '1800';
      if (!/^\d+$/.test(timeout) || Number(timeout) < 1 || Number(timeout) > 3600) throw failure(2, 'INVALID_TIMEOUT', 'arguments', '--timeout must be an integer from 1 to 3600 seconds.', 'Use --timeout 1800 or another supported duration.');
      parsed = { kind: 'compare', json, request: options.plan === undefined ? { kind: 'new', request: planRequest(options, invocationDir) } : { kind: 'saved', path: options.plan }, allowExec: options.allowExec ?? false, ci: ciEnvironment || (options.ci ?? false), timeoutMs: Number(timeout) * 1000 };
      return;
    }
    if (name === 'doctor' || name === 'setup') { parsed = { kind: name, json }; return; }
    if (argument === undefined) throw failure(2, 'MISSING_ARGUMENT', 'arguments', 'This command requires one argument.', 'Run the command with --help to see its argument.');
    parsed = name === 'compose' ? { kind: 'compose', json, runDir: argument } : { kind: 'clean', json, runId: argument };
  };
  const compare = sourceFlags(common(program.command('compare', { isDefault: true }).description('Plan, request consent, capture, and compose')))
    .option('--plan <file>', 'Execute an unchanged saved plan')
    .option('--allow-exec', 'Permit this invocation to run the displayed setup, services, application commands, and bootstrap')
    .option('--timeout <seconds>', 'Overall deadline, default 1800, maximum 3600')
    .option('--ci', 'Never prompt for consent; also enabled by CI=true');
  compare.action((_options, command: Command) => accept('compare', command));
  const planner = sourceFlags(common(program.command('plan').description('Inspect source and write a private plan without running app code')));
  planner.action((_options, command: Command) => accept('plan', command));
  common(program.command('compose').description('Re-encode saved sanitized frames and timeline without app servers or a browser')).argument('<runDir>').action((argument: string, _options, command: Command) => accept('compose', command, argument));
  common(program.command('setup').description('Download the pinned Chromium browser and check machine prerequisites without running app code')).action((_options, command: Command) => accept('setup', command));
  common(program.command('doctor').description('Diagnose prerequisites and abandoned runs without running app code')).action((_options, command: Command) => accept('doctor', command));
  common(program.command('clean').description('Remove one registered inactive owned run')).argument('<runId>').action((argument: string, _options, command: Command) => accept('clean', command, argument));
  try {
    program.parse([...args], { from: 'user' });
    if (!parsed) throw failure(2, 'INVALID_ARGUMENT', 'arguments', 'The command could not be parsed.', 'Use --help for the supported commands.');
    return parsed;
  } catch (error) {
    if (error instanceof CommanderError && error.exitCode === 0) {
      const requested = args.find((arg) => ['compare', 'plan', 'compose', 'doctor', 'setup', 'clean'].includes(arg));
      return { kind: error.code === 'commander.version' ? 'version' : 'help', command: commandName(requested) ?? active, json: args.includes('--json'), text: output.join('') };
    }
    if (error instanceof ToolFailure) throw error;
    const hint = error instanceof CommanderError ? sanitizeText(error.message).slice(0, 240) : 'Use the documented flags, with at most three routes or scenarios.';
    throw failure(2, 'INVALID_ARGUMENT', 'arguments', 'An option or argument is unsupported, missing, or invalid.', `${hint} Run --help for supported alternatives.`);
  }
}
