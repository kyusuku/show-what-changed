import type { ChildProcess } from 'node:child_process';
import type { Writable } from 'node:stream';
import type { BrowserContextOptions } from 'playwright';
import type { CleanupOutcome, Config, Coverage, Media, Plan, Provenance, Side, ToolError, Warning } from './index.js';

export type Pair<T> = Readonly<Record<Side, T>>;
export type PlanRequest = Readonly<{
  invocationDir: string;
  base?: string;
  head?: string;
  mergeBase?: boolean;
  routes?: readonly string[];
  scenarioPaths?: readonly string[];
  configPath?: string;
}>;
export type CompareRequest =
  | { kind: 'new'; request: PlanRequest }
  | { kind: 'saved'; path: string };
export type Consent =
  | { kind: 'allow-exec' }
  | { kind: 'deny' }
  | { kind: 'interactive'; confirm: (plan: Plan, signal: AbortSignal) => Promise<boolean> };
export type CommandContext = Readonly<{
  invocationDir: string;
  signal: AbortSignal;
  timeoutMs: number;
  consent: Consent;
  diagnostics: DiagnosticSink;
}>;
export interface DiagnosticSink {
  event(message: string): void;
}
export type InventoryEntry =
  | { path: string; exists: true; executable: boolean; byteLength: number; sha256: string }
  | { path: string; exists: false };
export type SourceInventory = readonly InventoryEntry[];
export type SourceRequest = Pick<PlanRequest, 'invocationDir' | 'base' | 'head' | 'mergeBase'> & Readonly<{ source: Config['source'] }>;
export type SourceInspection = Readonly<{
  repoRoot: string;
  requestedBase: string;
  requestedHead: string;
  baseCommit: string;
  headCommit: string;
  baseResolution: Plan['baseResolution'];
  headKind: Plan['headKind'];
  inventories: Pair<SourceInventory>;
  sourceFingerprint: string | null;
  changedFiles: Plan['changedFiles'];
  stats: Plan['sourceStats'];
  warnings: Warning[];
}>;
export type Workspace = Readonly<{
  side: Side;
  root: string;
  commit: string;
  kind: 'commit' | 'worktree';
  label: string;
  materializedHash: string;
  inventory: SourceInventory;
  sourceSettings: Config['source'];
}>;
export type WorkspacePair = Pair<Workspace>;
export type ProcessExit = Readonly<{ code: number | null; signal: NodeJS.Signals | null; spawnError: string | null }>;
export type ProcessOutput = Readonly<{ stdout: string; stderr: string; truncated: boolean }>;
export type SpawnSpec = Readonly<{
  argv: readonly string[];
  cwd: string;
  purpose: 'probe' | 'setup' | 'bootstrap' | 'service' | 'server' | 'docker' | 'browser' | 'encode';
  env?: Readonly<Record<string, string>>;
  sensitiveValues?: readonly string[];
  side?: Side;
  port?: number;
  input?: 'pipe';
  captureStdout?: boolean;
  timeoutMs?: number;
}>;
export interface OwnedProcess {
  readonly id: string;
  readonly pid: number;
  readonly groupId: number;
  readonly exited: Promise<ProcessExit>;
  readonly stdin: Writable | null;
  output(): ProcessOutput;
  isAlive(): boolean;
}
export interface Supervisor {
  spawn(spec: SpawnSpec): Promise<OwnedProcess>;
  adopt(child: ChildProcess, purpose: 'browser'): Promise<OwnedProcess>;
  stop(process: OwnedProcess): Promise<void>;
  stopAll(): Promise<CleanupOutcome>;
}
export interface ResourceRegistry {
  register(resource: {
    kind: 'capture' | 'browser' | 'context' | 'workspace' | 'lock' | 'container' | 'network' | 'image' | 'builder' | 'private-dir';
    identity: string;
    dispose: (deadlineMs: number) => Promise<void>;
  }): void;
  disposeAll(): Promise<CleanupOutcome>;
}
export type OwnedPaths = Readonly<{
  repoRoot: string;
  runDir: string;
  privateDir: string;
  tempDir: string;
  framesDir: string;
  composedDir: string;
}>;
export interface PublicRedactor {
  add(values: readonly string[]): void;
  text(value: string): string;
}
export type RunContext = Readonly<{
  runId: string;
  paths: OwnedPaths;
  startedAt: string;
  startedMonotonicMs: number;
  deadlineMs: number;
  signal: AbortSignal;
  diagnostics: DiagnosticSink;
  resources: ResourceRegistry;
  supervisor: Supervisor;
  redactions: PublicRedactor;
}>;
export type AuthStorageState = Exclude<NonNullable<BrowserContextOptions['storageState']>, string>;
export type Server = Readonly<{
  side: Side;
  origin: string;
  port: number;
  sourceLabel: string;
  source: import('./index.js').SourceIdentity;
  storageState: AuthStorageState | null;
  exited: Promise<ProcessExit>;
}>;
export type ServerPair = Pair<Server>;
export type RuntimeResult = Readonly<{ servers: ServerPair; provenance: Pair<import('./index.js').RuntimeSideProvenance> }>;
export type ComposerSettings = Readonly<{ coverage: Coverage; provenance: Provenance }>;
export type PreparedCapability = Readonly<{ executable: string; version: string }>;
export type MediaCapabilities = Readonly<{ ffmpeg: PreparedCapability; ffprobe: PreparedCapability }>;
export type RecorderSettings = Config['capture'];
export type { CleanupOutcome, Media, Provenance, ToolError, Warning };
