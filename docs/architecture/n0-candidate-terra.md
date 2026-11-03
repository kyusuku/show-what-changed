# N0 candidate. Independent module contracts

## Usage

The CLI accepts a plan or creates one. An execution grant is per invocation.

```sh
show-what-changed plan --route /pricing --json
show-what-changed compare --plan .show-what-changed/plan.json --allow-exec --json
show-what-changed compose .show-what-changed/runs/<runId> --json
```

```ts
// CLI: parse arguments, print one Result, set its exit code.
const result = await compare(request, { signal, confirmExecution });
printResult(result, json);

// Runner: the same modules are usable with a prepared test context.
const pair = await prepare(plan, run);
const servers = await start(pair, plan, run);
const bundle = await capture(servers, plan.scenarios, captureSettings(plan), run);
const provenance = await verifyProvenance(pair, run);
const timeline = await render(bundle, composerSettings(plan, provenance), run);
const media = await encode(timeline, run);

// Compose command: does not launch browsers or app servers.
const result = await recompose(runDir, { signal });
```

These are internal package interfaces, not a promise of a public npm library API. The runner call site is illustrative: it must use the cleanup and outcome sequence below.

## Data and signatures

The integrator owns strict Zod 4 schemas in `src/schema`. `z.output<typeof Schema>` is the sole TS representation of every wire document. The schema module exports parsers, defaults, generated JSON Schema and types `Config`, `Scenario`, `Plan`, `CaptureBundle`, `Timeline`, `Manifest`, `Result<T>`, `ToolError`, and `Warning`. It exports schemas for nested types needed by other modules. Each persisted document carries version 1. Parse unknown data at entry and persistence boundaries, reject unknown keys and enforce the full spec. Generic `Result<T>` is built from one envelope schema and the supplied data schema. Do not hand-maintain another document interface.

```ts
type Side = 'before' | 'after';
type Pair<T> = Readonly<Record<Side, T>>;
type Oid = string;                  // resolved full commit OID, not fixed length
type Sha256 = string;               // validated hex digest
// Absolute paths are internal only. Artifact document paths are run-relative.
type AbsPath = string;
type RelativePath = string;
type Outcome = { errors: ToolError[]; warnings: Warning[] };

type PlanRequest = {
  invocationDir: AbsPath;
  base?: string; head?: string; mergeBase?: boolean;
  routes?: readonly string[]; scenarioFiles?: readonly AbsPath[];
  configFile?: AbsPath;
};
type CompareRequest =
  | { kind: 'new'; plan: PlanRequest; allowExec: boolean; ci: boolean; timeoutMs: number }
  | { kind: 'saved'; planFile: AbsPath; allowExec: boolean; ci: boolean; timeoutMs: number };
type EntryContext = {
  signal: AbortSignal;
  confirmExecution: (preview: Pick<Plan, 'execution' | 'baseCommit' | 'headCommit' | 'headKind'>) => Promise<boolean>;
};
function plan(request: PlanRequest): Promise<Plan>;
function compare(request: CompareRequest, context: EntryContext): Promise<Result<Manifest>>;
function recompose(runDir: AbsPath, context: Pick<EntryContext, 'signal'>): Promise<Result<Manifest>>;
```

`Plan` is immutable after validation. Its Zod schema includes all §3.3 source identities, config source and digest, normalized settings/scenarios, deterministic changed-file and coverage data, execution preview and warnings. It is private because it can contain fill values and absolute paths. Canonical JSON and `planId` exclude ID and generated timestamp exactly as §3.3 specifies. Planner is effect-free with respect to repository execution, workspace changes and services. It can invoke only safe read-only Git inspection. A saved plan is revalidated before consent and snapshot, including raw config bytes, `planId`, repository and WORKTREE checks. Explicit commit plans keep pinned OIDs even if a named ref or caller HEAD moves.

### Source inspection and pure helpers

N1 owns the `workspace/source` public entry. N4 imports only this entry and never imports snapshot or runtime internals. IO and pure transformation are separate so routing tests need no Git process or server.

```ts
type SourceEntry = Readonly<{
  path: RelativePath; executable: boolean; bytes: number; sha256: Sha256;
}>;
type InventoryEntry = SourceEntry | Readonly<{ path: RelativePath; absent: true }>;
type Inventory = readonly InventoryEntry[]; // unique, UTF-8 byte sorted
// Availability is explicit. Blob bytes are returned only on request, not embedded in a Plan.
type SourceView = Readonly<{ commit: Oid; entries: Inventory }>;
type Inspection = Readonly<{
  repoRoot: AbsPath; requestedBase: string; requestedHead: string;
  baseCommit: Oid; headCommit: Oid; headKind: 'commit' | 'worktree';
  baseResolution: 'exact' | 'merge-base'; before: SourceView; after: SourceView;
  sourceFingerprint: Sha256 | null;
  changedFiles: Plan['changedFiles']; warnings: Warning[];
}>;
interface SourceReader {
  inspect(request: PlanRequest): Promise<Inspection>;
  readFile(side: Side, path: RelativePath): Promise<Uint8Array>;
  // `readFile` reads the exact inspected source; detect changes and fail on mismatch.
}
function openSource(request: PlanRequest): Promise<SourceReader>;
function parseNulPaths(bytes: Uint8Array): readonly RelativePath[];
function inventoryFingerprint(entries: Inventory): Sha256;
function compareInventories(before: Inventory, after: Inventory): Plan['changedFiles'];
function validateInventory(entries: Inventory): void;
```

The reader checks repository/filter/attribute safety before any conversion-capable Git operation, resolves refs once, inspects both full sources and validates root npm manifests and lockfiles. `readFile` is for route/config discovery and preflight, bounded and tied to the inspected bytes. `compareInventories` compares final bytes and modes, never index-mediated diff for WORKTREE. A commit-to-commit name-status diff has the spec's no-renames semantics. Helpers reject invalid UTF-8 and duplicates; fingerprint canonicalization is fixed by N0 fixtures. WORKTREE inventory includes HEAD/index/unignored candidate union, absent markers and exclusions in §5.2. Detect unsupported tree transitions, generated tracked paths, bounds, submodules, links, LFS, filters, local dependencies and monorepos before execution. No plan operation invokes repository scripts or hooks.

### Run ownership and processes

```ts
type CancelCause = 'timeout' | 'sigint' | 'sigterm';
type ProcessExit = Readonly<{ code: number | null; signal: NodeJS.Signals | null }>;
type OwnedProcess = Readonly<{
  exit: Promise<ProcessExit>; stdin: NodeJS.WritableStream | null;
}>;
type SpawnSpec = Readonly<{
  argv: readonly [string, ...string[]]; cwd: AbsPath;
  env: Readonly<Record<string, string>>; logName: string;
  stdin: 'ignore' | 'pipe';
}>;
interface Supervisor {
  // spawn uses shell:false, owns the process group and registers before returning.
  spawn(spec: SpawnSpec): Promise<OwnedProcess>;
  stop(process: OwnedProcess): Promise<void>;  // idempotent, owned handles only
  stopAll(): Promise<Outcome>;                // idempotent, bounded cleanup
}
interface ResourceRegistry {
  // Registration is immediate after creation, before the next await or fallible operation.
  register(resource: { kind: 'browser' | 'context' | 'worktree' | 'lock';
    description: string; dispose: () => Promise<void> }): void;
  disposeAll(): Promise<Outcome>;             // reverse order, idempotent
}
interface RunContext {
  readonly runId: string;
  readonly paths: Readonly<{ repoRoot: AbsPath; runDir: AbsPath;
    privateDir: AbsPath; tempDir: AbsPath }>;
  readonly deadlineNs: bigint;                // monotonic, not wall clock
  readonly signal: AbortSignal;
  readonly cancelCause: () => CancelCause | null;
  readonly diagnostics: { write(process: string, chunk: Uint8Array): void };
  readonly resources: ResourceRegistry;
  readonly supervisor: Supervisor;
}
```

Context creation validates containment and ownership before any managed write, obtains an exclusive repository lock and creates a private run directory. The cleanup deadline is independent of an aborted execution signal. Process environments are built from the §11 allowlist; private logs are bounded and sanitized. Browser subprocesses are owned through registered Playwright browser/context close handles in addition to supervised spawned process groups. Cleanup closes contexts and browsers, terminates groups, waits at most three seconds before KILL, disposes exact owned worktrees and lock, and completes within ten seconds. Persist failures. Never identify a process for termination using a stale PID alone.

### Workspace and runtime

```ts
type Workspace = Readonly<{
  side: Side; root: AbsPath; sourceHash: Sha256;
  // Baseline is an internal inventory of actual materialized content and mode.
  baseline: Inventory;
}>;
type WorkspacePair = Pair<Workspace>;
type Provenance = Pair<{ valid: boolean; actualHash: Sha256; errors: ToolError[] }>;
function prepare(plan: Plan, run: RunContext): Promise<WorkspacePair>;
function verifyProvenance(pair: WorkspacePair, run: RunContext): Promise<Provenance>;

type Server = Readonly<{
  side: Side; origin: string; port: number;
  // Resolves once the owned server dies. Recorder uses this while executing a step.
  exited: Promise<ProcessExit>;
}>;
type ServerPair = Pair<Server>;
function start(pair: WorkspacePair, plan: Plan, run: RunContext): Promise<ServerPair>;
```

`prepare` creates separate registered detached worktrees only after consent. It overlays the WORKTREE snapshot safely, verifies copy against the plan and destination, independently runs `npm ci`, then re-enumerates both sources including new eligible files. A post-install change is fatal exit 5. Materialized hashes reflect actual workspace bytes and modes. Runner calls `verifyProvenance` after capture even if recording fails; after-capture mutation is partial if media is possible. Runtime starts two independently owned process groups and exposes only verified loopback origins and exit signals. Readiness includes exact configured status, live process and every listener's process-group and loopback ownership. A port race retries the pair at most twice after stopping both. A startup failure stops both. An exit during recording becomes that side's failed then blocked states, not a fabricated successful frame.

### Recorder and composer

```ts
// Pick from the already normalized config; no duplicate settings schema or policy.
type RecorderSettings = Readonly<{
  fixedTime: Config['capture']['fixedTime'];
  maskSelectors: Config['capture']['maskSelectors'];
  stepTimeoutMs: Config['capture']['stepTimeoutMs'];
  holdMs: Config['capture']['holdMs'];
  labels: Pair<string>;
}>;
function captureSettings(plan: Plan): RecorderSettings;
function capture(servers: ServerPair, scenarios: readonly Scenario[],
  settings: RecorderSettings, run: RunContext): Promise<CaptureBundle>;

type ComposerSettings = Readonly<{
  // Known before rendering. These caveats must appear visibly in titles/captions.
  coverage: Plan['coverage']; provenance: Provenance; warnings: readonly Warning[];
}>;
type Media = Readonly<{
  video: { path: RelativePath; sha256: Sha256; bytes: number };
  poster: { path: RelativePath; sha256: Sha256; bytes: number };
  ffmpegVersion: string; ffprobeVersion: string;
}>;
function composerSettings(plan: Plan, provenance: Provenance): ComposerSettings;
function render(bundle: CaptureBundle, settings: ComposerSettings, run: RunContext): Promise<Timeline>;
function encode(timeline: Timeline, run: RunContext): Promise<Media>;
```

Capture discovers and records its actual browser and tool versions. Capture runs scenarios sequentially with fresh per-side contexts. Each step shares one index across sides and has `ok`, `expected_absent`, `skipped_by_side`, `failed` or `blocked` status. The first failed/blocked step has a neutral frame if no safe frame exists. All saved screenshots use masks; held frames keep their failure state. Whole-step timeout closes the context when needed. Do not serialize fill values or raw browser errors. Ratios exist only for verified pairs and are computed from masked source PNGs. See §7–8 for exact side-state matrix, navigation, fixed time, settling, masking and hover invariants.

Render reads persisted, contained, regular masked PNGs and the bundle, never app pages. It creates an isolated, network-blocked template context and registers it. It writes composed PNGs, their hashes and the integer-frame timeline; it records a deterministic poster selection. `encode` validates the timeline, all paths, dimensions and hashes, then streams persisted PNGs with exact frame repetition to supervised FFmpeg and verifies with ffprobe. It uses neither Chromium nor app servers. The returned `Media` names only validated, atomically installed files. Default dimensions, frame rates, layout, encoding, bounds and text safety are fixed by spec §9, not user-facing options.

## Failure flow and single ownership

Modules throw an internal typed failure containing one sanitized `ToolError` and a category mapping to the spec exit code. Partial step failures are data in `CaptureBundle`, not fatal throws. Recorder reports runtime side exits as step states. The runner alone owns the state machine, persists its atomic manifest updates and reduces comparison, encoding and cleanup outcomes. It writes a terminal manifest whenever the run directory exists, including early failure. Diagnostics remain private; `Result` includes only sanitized errors and paths allowed by the spec.

Sequence is validate and plan, check consent, create context and lock, prepare, start, capture, verify provenance, render, persist comparison and cleanup/encoding state, encode, clean in `finally`, reduce and atomically write terminal manifest and `pr.md`. If capture itself throws, still verify any prepared workspace and clean; no unsafe invented bundle is rendered. Once cancellation occurs, stop new work. The original cancellation/fatal error wins over a later cleanup error; retain both. Cleanup-only failure after valid media yields partial exit 3. Outcome mapping, including no-change 4, invalid input 2, consent 7, prepare 5, startup 6, capability 8, output 9, timeout 10 and signals 130/143, follows §10. An unexpected defect is 1. Valid explicit bounded selection is not a coverage-gap partial.

Recompose parses the existing manifest and timeline, validates files and hashes, encodes atomically, and changes only encoding outcome, media metadata, encoding versions, terminal reduction and local PR text. Comparison and cleanup outcomes remain independent and unchanged. It cannot erase a partial capture or provenance failure. Abandoned runs are reported by doctor. Clean validates exact ownership and refuses uncertain activity.

## Coordination and rationale

The structure respects the spec's fixed module owners. Schema owns persisted structure and defaults; workspace owns source identity and installs; runtime owns listener verification; recorder owns action semantics and masked frames; composer owns presentation and encoding; runner owns durable outcomes. CLI only adapts arguments, signals, consent and output. N1 can build against `Plan`, `RunContext` and the pure source helpers. N2 needs `ServerPair`, settings and a synthetic `CaptureBundle`. N3 needs only that bundle, settings and a synthetic `Timeline`. N4 uses `SourceReader` and schema contracts. Freeze exact schemas and fixtures before delegating and notify every dependent if they change.

We accept a second full provenance inventory pass in exchange for detecting app or install source mutation. We accept an internal run-relative wire format and private absolute execution paths in exchange for portable artifacts and strict privacy boundaries. The run registry makes partially completed setup reachable by `finally`, while domain modules hide process and resource details. There is one owner per outcome and one schema definition per persisted shape.

A structurally different alternative is a central mutable pipeline object whose stages directly update one shared run record and expose live pages and process handles. It hides fewer decisions from callers, gives every stage write access to terminal status, couples recomposition to runtime and makes failure recovery race-prone. The selected immutable handoffs keep domain policy inside its owner and leave status reduction to the runner.

The synthesis decision belongs to the parent arena. Before parallel work, implement Zod schemas and deterministic synthetic capture/timeline fixtures, then prove the screenshot-to-encoding capability spike. Source mutations during copy remain best-effort detectable rather than an atomic filesystem snapshot. External platform and installed-package gates remain required evidence.
