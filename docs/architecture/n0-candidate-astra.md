# N0 candidate. Data pipeline with scoped ownership.

## Caller usage

The developer receives one truthful result. Module owners receive immutable documents and a scoped execution context. They never transfer live pages or responsibility for cleanup.

```ts
const result = await compare({ kind: 'saved', path: cli.planPath }, {
  invocationDir: cwd, signal: signalController.signal,
  timeoutMs: cli.timeoutSeconds * 1000, consent: { kind: 'allow-exec' },
  diagnostics: stderrDiagnostics,
});
printResult(result, cli.json);

const selected = await plan({ invocationDir: cwd, base: 'HEAD', head: 'WORKTREE' });
// Runner sequence inside a protected try/finally, after consent and capability checks.
const workspaces = await prepare(selected, run);
const servers = await start(workspaces, selected, run);
const bundle = await capture(servers, selected.scenarios, selected.config.capture, run);
const provenance = await verify(workspaces, run);
const timeline = await render(bundle, { coverage: selected.coverage, provenance }, run);
const media = await encode(timeline, run);

// Compose loads existing outcomes and validated timeline, acquires ownership, and encodes.
const recovered = await compose({ invocationDir: cwd, runDir }, context);
```

`compare` owns the omitted state persistence, deadline, consent decision and `finally` cleanup. `compose` owns recovery bookkeeping. Callers cannot clear capture failures by requesting another encode.

## Shared contracts

```ts
// src/schema/index.ts. Each named document comes from one strict Zod 4 definition.
type Config = z.output<typeof ConfigSchema>;
type Scenario = z.output<typeof ScenarioSchema>;
type Plan = z.output<typeof PlanSchema>;
type CaptureBundle = z.output<typeof CaptureBundleSchema>;
type Timeline = z.output<typeof TimelineSchema>;
type Manifest = z.output<typeof ManifestSchema>;
type ToolError = z.output<typeof ToolErrorSchema>;
type Warning = z.output<typeof WarningSchema>;
type Result<T> = z.output<ReturnType<typeof resultSchema<z.ZodType<T>>>>;
type Side = 'before' | 'after';
type Pair<T> = Readonly<Record<Side, T>>;
type RunPhase = Manifest['state'];
type RecorderSettings = Config['capture'];
type ProvenanceOutcome = Manifest['comparisonOutcome']['provenance'];
type CleanupOutcome = Manifest['cleanupOutcome'];
type Media = NonNullable<Manifest['artifacts']['media']>;
type ComposerSettings = Readonly<{
  coverage: Plan['coverage']; provenance: ProvenanceOutcome;
}>;
```

The generic result factory is schematic TypeScript. Freeze its compiling spelling in N0. Export `z.input` aliases only where parsing callers need omitted defaults. Shared nested outcomes and Media have schema definitions reused by Manifest, never hand-copied interfaces. Generated JSON Schemas come from those same definitions. Schema examples pin every required field in spec §3 and §10.

All persisted documents remain version 1. The specification explicitly makes these documents the module boundary, overriding the generic architect preference against exposing wire models. No second domain copy is needed. Runtime handles below are private in-memory contracts and cannot be serialized. Validated strings for absolute owned paths, relative artifact paths, origins and digests use distinct branded types in schema helpers.

```ts
// src/schema/contracts.ts. Integrator owns these non-wire contracts as well.
type PlanRequest = Readonly<{
  invocationDir: string; base?: string; head?: string; mergeBase?: boolean;
  routes?: readonly string[]; scenarioPaths?: readonly string[]; configPath?: string;
}>;
type CompareRequest =
  | { kind: 'new'; request: PlanRequest }
  | { kind: 'saved'; path: string };
type Consent =
  | { kind: 'allow-exec' }
  | { kind: 'deny' }
  | { kind: 'interactive'; confirm: (preview: ConsentPreview) => Promise<boolean> };
type CommandContext = Readonly<{
  invocationDir: string; signal: AbortSignal; timeoutMs: number;
  consent: Consent; diagnostics: DiagnosticSink;
}>;
type RunContext = Readonly<{
  runId: string; paths: OwnedPaths; startedAt: string;
  deadlineMs: number; signal: AbortSignal;
  diagnostics: DiagnosticSink; resources: ResourceRegistry; supervisor: Supervisor;
  capabilities: ValidatedCapabilities;
}>;
interface OwnedPaths {
  repoRoot: AbsolutePath; runRoot: AbsolutePath; privateRoot: AbsolutePath;
  framesRoot: AbsolutePath; composedRoot: AbsolutePath; temporaryRoot: AbsolutePath;
}
interface Supervisor {
  spawn(spec: SpawnSpec): Promise<OwnedProcess>;
  stop(process: OwnedProcess): Promise<void>;
  stopAll(): Promise<CleanupOutcome>;
}
interface SpawnSpec {
  argv: readonly [string, ...string[]]; cwd: AbsolutePath;
  purpose: 'probe' | 'install' | 'server' | 'browser' | 'encode';
  side?: Side; input?: 'pipe'; timeoutMs?: number;
}
interface OwnedProcess {
  readonly id: string; readonly groupId: number;
  readonly exited: Promise<ProcessExit>;
  readonly stdin: Writable | null;
}
interface ResourceRegistry {
  register(resource: OwnedResource): ResourceRegistration;
  dispose(): Promise<CleanupOutcome>;
}
interface OwnedResource {
  kind: 'process' | 'browser' | 'context' | 'workspace' | 'lock';
  identity: string; close: (cleanupDeadlineMs: number) => Promise<void>;
}
```

`ConsentPreview` is a safe projection of Plan, with source counts, identities, exact argv, output location and the required notice. `DiagnosticSink` accepts bounded private process streams and sanitized structured events. It never writes stdout. `ValidatedCapabilities` contains checked executable paths, versions and browser asset metadata. CLI supplies only allowlisted FFmpeg/ffprobe overrides to capability validation.

`deadlineMs` uses `performance.now()`. Cancellation reasons distinguish timeout, SIGINT and SIGTERM. `SpawnSpec` cannot supply arbitrary environment or shell options. Runtime constructs the documented allowlist and derives PORT/SWC_SIDE/SWC_RUN_ID from registered runtime state. Its private child handle and process-group witness stay inside Supervisor. `ProcessExit` is a tagged exit/signal/spawn-error record; it does not reject as an unhandled background promise.

Registration is synchronous immediately after acquisition and before the next await. Supervisor registers each spawned process before returning. Playwright-owned browsers and contexts register close callbacks in their creating module before use. The browser launch adapter also registers its live subprocess with Supervisor, including group ownership, before exposing the browser. N0 must prove this adapter; a close callback alone is insufficient for a hung browser. Registry disposal closes contexts/browsers, invokes Supervisor termination, then removes exact workspaces and the lock. Both operations are idempotent. Cleanup uses its own maximum ten-second deadline and remains possible after run cancellation. Registration failure closes the just-created resource immediately.

## Source boundary and N1 exports

```ts
type InventoryEntry =
  | { path: string; exists: true; executable: boolean; byteLength: number; sha256: string }
  | { path: string; exists: false };
type SourceInventory = readonly InventoryEntry[];
type SourceInspection = Readonly<{
  repoRoot: AbsolutePath; requestedBase: string; requestedHead: string;
  baseCommit: string; headCommit: string; baseResolution: Plan['baseResolution'];
  headKind: Plan['headKind']; inventories: Pair<SourceInventory>;
  sourceFingerprint: string | null; changedFiles: Plan['changedFiles'];
  packages: Pair<InspectedPackage>; warnings: Warning[];
}>;
declare function inspectSources(request: SourceRequest): Promise<SourceInspection>;
declare function fingerprintInventory(entries: SourceInventory): string;
declare function diffInventories(base: SourceInventory, head: SourceInventory): Plan['changedFiles'];
declare function validateInventory(entries: SourceInventory): void;
declare function validateOverlay(base: SourceInventory, head: SourceInventory): void;
type Workspace = Readonly<{
  side: Side; root: AbsolutePath; commit: string; kind: 'commit' | 'worktree';
  label: string; materializedHash: string; inventory: SourceInventory;
}>;
type WorkspacePair = Pair<Workspace>;
type Server = Readonly<{
  origin: LoopbackOrigin; sourceLabel: string; exit: Promise<ProcessExit>;
}>;
type ServerPair = Pair<Server>;
declare function prepare(plan: Plan, run: RunContext): Promise<WorkspacePair>;
declare function verify(workspaces: WorkspacePair, run: RunContext): Promise<ProvenanceOutcome>;
declare function start(workspaces: WorkspacePair, plan: Plan, run: RunContext): Promise<ServerPair>;
```

`SourceRequest` is the source-selection subset of PlanRequest. `InspectedPackage` contains parsed manifest/lockfile facts needed for preflight and framework detection, including available root app directories. Inspection owns ref resolution and complete supported-source preflight. It is observational I/O, not mathematically pure. Its four synchronous helpers are pure. These exports live in `workspace/source.ts`, with no startup import or top-level work. Planner may run hardened Git read probes through this boundary, never checkout, install, launch application code or create a RunContext. Tests can supply captured inspection fixtures to planner's pure reduction.

Inventories use UTF-8 byte ordering and explicit absence. Fingerprints include content/mode/length and ignore index identity as rendered content. Inspection rejects unsupported layout, filters, unsafe paths and package arrangements before consent. It reads both complete endpoints. Commit changes follow the specified no-renames Git diff. WORKTREE changes use inventory comparison. Index preservation is independent diagnostic evidence.

`prepare` creates both detached worktrees, registers each immediately, overlays the pinned WORKTREE bytes and verifies source and destination inventories before independent installs. It rechecks all eligible workspace source after each install, including new files. `verify` repeats that check after capture for both sides and reports invalid provenance as data so a visibly partial video remains possible. Inability to establish provenance is invalid, never implicit success. Later caller edits cannot affect the detached app.

`start` returns only after both origins pass exact-status, listener ownership, process-group and loopback checks. Its caller never substitutes a port or manages retry policy. `exit` lets recorder fail the affected side during capture without polling runtime internals. A dead server stays dead across scenarios; ordinary scenario failure resets in a fresh context.

## Module ownership and remaining signatures

```ts
declare function plan(request: PlanRequest): Promise<Plan>; // planner
declare function validateSavedPlan(plan: Plan, inspection: SourceInspection): Promise<void>;
declare function capture(servers: ServerPair, scenarios: readonly Scenario[],
  settings: RecorderSettings, run: RunContext): Promise<CaptureBundle>; // recorder
declare function render(bundle: CaptureBundle, settings: ComposerSettings,
  run: RunContext): Promise<Timeline>; // composer
declare function encode(timeline: Timeline, run: RunContext): Promise<Media>; // composer
declare function compare(request: CompareRequest, context: CommandContext): Promise<Result<Manifest>>;
declare function compose(request: ComposeRequest, context: CommandContext): Promise<Result<Manifest>>;
```

Planner owns config discovery and byte digests, normalization, route reduction, coverage, canonical Plan ID and saved-plan validation. Config/scenario overrides apply once. Saved-plan validation rereads its pinned configSource, checks canonical ID/config digest/repo identity and WORKTREE fingerprint plus HEAD only for WORKTREE. Existing commit OIDs remain authoritative when refs move. Runner repeats freshness checks under its acquired repository lock before preparation.

Recorder owns `capture.json`, all source PNGs and changeRatio. It receives normalized seven-op scenarios. Fixed viewport/DPR/browser behavior comes from schema constants, not selectable settings. It always returns both frames for every step, using neutral/held masked-safe frames when necessary. Required action errors become side statuses and block later steps on that side; fatal browser/cancellation/output failures throw. It executes eligible sides concurrently, awaits both outcomes, then advances. The sole masked image helper handles every capture. Whole-step timeout closes its context before advancing. Browser objects never escape this module.

Composer owns `timeline.json`, composed PNGs, poster and media. It derives capture incompleteness from the bundle and adds coverage/provenance caveats from settings before rendering. Titles, captions and poster share the same status policy. Fixed geometry/FPS/template values are constants. Timeline records exact integer frames and composed-image hashes. `encode` validates contained regular inputs and hashes again, needs only FFmpeg/ffprobe, and atomically replaces validated media. Runtime owns command execution, ownership, locks and cleanup. Runner alone writes manifest/pr.md and reduces final outcomes. CLI alone parses flags, acquires signal reasons, prompts, and prints one Result.

## Lifecycle and failure flow

Runner validates input and capabilities, plans, obtains consent, acquires the exclusive repository lock, creates registered private output paths and writes the running manifest. It persists phase changes from validating through preparing, starting, recording, rendering, encoding and cleaning. It writes `comparisonOutcome`, `cleanupOutcome` and `encodingOutcome` independently before encoding. Every path reaches cleanup and an atomic terminal manifest when a run directory exists. A failure before that point returns `data:null`.

Operational failures throw one `ToolFailure` carrying schema-derived ToolError plus an internal fatal category. Stable code/category mapping lives in schema, including input 2, workspace/install 5, startup 6, consent 7, capability 8, media 9 and internal 1. Step failures stay in CaptureBundle. No module chooses final status. Runner's single reducer applies cancellation 10/130/143 first, then fatal errors, then valid-media partial conditions, then success. Nothing 4 is returned only for the narrow planner outcome in §6. Cleanup errors append without overwriting an earlier fatal/cancel error. Valid media with cleanup failure is partial 3.

Recompose acquires the same ownership lock, loads validated persisted outcomes and Timeline, and registers only its current resources. It never creates servers or a browser. Successful encoding replaces only encoding outcome/media evidence and refreshes terminal manifest/pr.md/Result. Prior required failures, coverage gaps, invalid provenance and cleanup failures remain. Doctor is read-only; clean deletes only an exact ownership-verified inactive registered run and its residue. Their command-specific report schemas share Result, diagnostics and ownership helpers.

## Rationale and next step

The deep boundaries hide source semantics, browser state transitions and encoding details behind one operation each. Immutable documents make N1, N2 and N3 independent. Resource handles remain reachable after any thrown error. One writer per artifact prevents divergent status or hash updates. The accepted tradeoff is explicit persistence between modules, in exchange for inspectable failure evidence and browser-free recovery.

A structurally different alternative gives each side a `ComparisonSession` object that owns workspace, server, page and image history. It hides setup but exposes synchronization and cross-session failure coordination to the caller. It also keeps applications live during composition and makes recovery depend on session state. Reject it because the caller must understand more lifecycle policy and persisted encoding cannot stand alone.

Synthesis remains the parent arena's decision. N0 should freeze the schema fixtures and prove browser adoption/termination plus encode-only recovery first. N1 receives inspection fixtures and ownership contracts. N2 receives two supplied origins with non-resolving live exit promises. N3 receives masked synthetic bundles for success, expected absence, first-step failure and provenance/coverage gaps. All three can begin without another worker's implementation. No product choice needs owner clarification.
