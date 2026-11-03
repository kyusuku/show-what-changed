# Revision 0.3 module contracts

R0 selects the existing shallow modules with new schema 2 data. The concrete definitions are src/schema/index.ts, src/schema/recipe.ts, and src/schema/contracts.ts. This document records caller usage and ownership. R2 through R5 callers have migrated and the full typecheck passes. Runtime, motion, installed-package, and release acceptance remain separate checks.

## Read the flow

The CLI calls planner.plan or loadSavedPlan. Planner first resolves the repository and configuration, then inspects full source inventories with Config.source. Plan binds every local input and normalized recipe. Planning starts no app command.

Runner obtains consent and creates RunContext. Workspace.prepare materializes two complete isolated snapshots without installing dependencies. Runtime.start resolves private environments and helper copies, allocates endpoints, runs prerequisites/services/setup/start/readiness/bootstrap, and returns RuntimeResult. Runner verifies source before capture and fails pre-capture mutation with exit 5.

Recorder.capture receives RuntimeResult.servers, scenarios, capture settings, and RunContext. It has no recipe or package-manager policy. Server carries a validated private in-memory storageState and public source identity. CaptureBundle never serializes the private auth input. CaptureBundle retains actual masked frames and half-open event timing for motion, plus checkpoint results shared with keyframes. Checkpoints are hash/size-bound Artifact objects with explicit fresh, held, or neutral identity and masking provenance.

Composer.render prepares trusted labels and overlays and an explicit Timeline. Composer.encode consumes that timeline and existing hashed sanitized artifacts. No application or browser is needed to re-encode a saved timeline. Runner verifies source after capture and reduces comparison, encoding, and cleanup independently.

## Keep the signatures

- plan(request, signal) returns Plan. loadSavedPlan and validateSavedPlan retain their public signatures.
- inspectSources(request, signal) receives SourceRequest.source and returns SourceInspection with inventories and stats. Workspace owns no npm policy.
- prepare(plan, run) returns WorkspacePair. Each Workspace stores sourceSettings so verify(workspaces, run) can retain its signature.
- start(workspaces, plan, run) returns RuntimeResult with servers and public per-side execution provenance.
- capture(servers, scenarios, settings, run) returns CaptureBundle.
- render(bundle, presentationSettings, run) returns Timeline.
- encode(timeline, run) returns Media.

Config is schemaVersion 2 with appDir, execution, source, routes, and capture. Commands have argv and optional cwd. Planner resolves omitted command cwd to appDir before binding the plan. The recipe remains the single command model; Plan.execution contains measured counts/bytes, environment reference names, an estimate, and the consent notice, not duplicate mutable argv arrays.

Plan stores inventories, sourceStats, configSource, scenarioSources, inputs, configDigest, and scenarioDigest. Private input records bind exact bytes/mode/path/extension. Saved plan reads permit 128 MiB. Config/scenario reads remain 1 MiB. Artifact metadata reads permit 256 MiB.

## Extend supervision without weakening ownership

SpawnSpec.env contains only explicit additions or overrides to the existing allowlisted child environment. It is not an instruction to inherit the parent environment. sensitiveValues are exact values to redact before diagnostic persistence. Runtime owns resolution, separate service bindings, and executable selection. Tool-owned Git, browser, and encoder processes receive no application secrets.

Interactive consent may transiently read explicitly named environment references only to redact its displayed recipe operands. This does not resolve execution bindings, validate missing references, mutate the plan, or persist values. Runtime resolves and validates authoritative execution bindings after consent. The preview preserves structural IDs, version ranges, reference names, token placeholders, and helper hashes. The complete original commands remain in the private plan.

ResourceRegistry accepts capture, browser, context, workspace, lock, container, network, image, builder, and private-dir resources. Runtime must actually dispose every registered kind. Stop/drain capture queues before closing contexts, then close browsers, stop processes, and remove the owned dependent resources in a safe order. Cleanup has an independent bounded 30-second budget.

RunContext.startedMonotonicMs is a fixed performance.now() origin, separate from its ISO startedAt. Runtime supplies it once. Deadline/cancellation cleanup cannot use a supervisor that refuses all work after cancellation. Docker cleanup commands need an independent bounded command path that preserves ownership and its original ledger.

Builder ownership uses pre-registered unpredictable names, a private client configuration, and inspected builder container/state-volume identities. Buildx does not expose arbitrary labels for those internal resources. App/service containers, networks, and final images still use run/side labels. Do not infer ownership from a conventional name alone or remove shared default builders.

## Preserve capture identity and time

CaptureBundle discriminates captureMode. Both modes have sources, viewport, labels, checkpoint scenarios, sanitized settings, and warnings. Each captured scenario can carry sanitized errors independently from its action outcomes. This permits capture faults without inventing a failed action.

Motion additionally has a MotionScenario for each checkpoint scenario, in the same order. It contains per-side tracks, step markers, and annotation intervals. Track status distinguishes ok from failed. Every actual frame references a hashed sanitized PNG and preserves source, mapped, receipt, scale, offset, and scroll metadata. Track statistics report observed receipt/persistence/acknowledgement/rejection counts and queue high-water. Browser-produced drop count is unknown, represented as null. Source gaps do not themselves prove drops. Successful tracks have actual frames and exact equality of observed receipt, persistence, and acknowledgement counts, with zero rejections. Failed tracks retain actual counters without inventing completion. Count checkpoints and unique motion source PNGs together against the storage limits.

ClockMapping has rate 1, one offsetMs, bracketed source/host samples, uncertainty, drift, and combined error bound. Successful-track samples validate that mapping with at most 40 ms combined error. Failed tracks can retain excessive observed bounds or invalid samples as failure evidence. They never relabel those samples as a valid mapping or update its offset. All action/event timestamps and frame runElapsedMs use the same RunContext clock origin. Source seconds and elapsed milliseconds are never mixed implicitly.

Scenario start/end and annotation intervals use elapsed milliseconds. Each step records one barrier and a discriminated per-side timing result. Executed steps retain source-domain dispatch/completion/observation markers with host brackets and uncertainty. Failed steps retain only observed dispatch and failure events. Excluded/blocked steps retain their actual transition time. When the source clock is unavailable, a failed step can record an explicitly host-only failure marker. It cannot invent source timing. Waiting starts after that side finishes observation and ends at the next barrier. Failed and excluded sides do not create verified checkpoint pairs.

Timeline schema 2 uses templateVersion 2. It stores title, keyframe-step, or motion-scenario segments. Motion selections bind each output frame index to before/after actual source frames and a trusted static overlay. Null selections render neutral pixels. Every referenced source/overlay/poster has a hash entry. Motion scenarios preserve elapsed duration and output is 30 FPS. No side-specific retiming or interpolation is allowed. Timeline also stores captureSha256 as digest(bundle), the SHA-256 of canonical validated public capture JSON. Manifest.artifacts.capture separately binds the raw capture.json file bytes. Timeline includes explicit step/annotation boundaries, and a verified-checkpoint or incomplete poster selection. Composer exports validateTimelineCapture(timeline, bundle) and uses it before encoding. It checks the capture identity, exact schedule/latest eligible frames, annotations, held states, and poster. Offline compose checks both saved documents and never trusts a rewritten timeline solely because its image hashes still match.

## Hold ownership and proof

Integrator owns all files under src/schema, test/contracts, generated schema, CLI, runner, package inputs, and this contract. Worker A owns planner/workspace and their tests. Worker B owns runtime and lifecycle tests. Worker C owns recorder/composer and their media tests. Owners propose shared-type changes to the integrator instead of editing them concurrently.

Initial grounding reports are retained in evidence/artifacts/revision-0.3/R0. The prior architecture alternatives remain in docs/audit/spec-revision-0.3-design.md. R0 contract checks do not certify the unimplemented runtime. Full G01 acceptance remains part of the final candidate audit.

## Project public metadata deliberately

Private Plan.configDigest and Plan.scenarioDigest are exact stale-input checks. Public Manifest instead exposes publicRecipeDigest and publicScenarioDigest, produced only by the named projections in src/schema/public.ts. Value-bearing command, environment, helper, authentication, locator, note, and fill operands do not enter these projections. Null remains valid if safe projection is unavailable. Dictionary tests must produce equal public and different private digests.

Recorder and runner own public text construction. Do not serialize raw exceptions, private warnings, input objects, auth state, helper paths, or environment values. Use fixed public diagnostic templates and publicRoute to remove query/fragment values. Titles/captions are explicit public text, bounded and redacted against known private values including scenario fills. RunContext.redactions holds registered known sensitive values. Runtime adds literal, raw template, and resolved consumer-specific environment values before use; runner adds private scenario fill values. Recorder calls redactions.text for explicit public titles/captions, without receiving recipes or secrets. The registry stays private and is never serialized. Manifest.captureQuality derives each motion side's clock bounds, observed counters/gaps, and failure time from CaptureBundle.

Runtime parses bounded storage-state files only after bootstrap and validates exact side origins and cookie hosts. The private in-memory state must be independently copied into each context and never serialized. Intended resource registration precedes creation; interrupted creation reconciles verified owned identities.

## Bounded sanitized persistence

Motion transport owns two distinct shutdown boundaries. A required synchronous, terminal subscription cutoff prevents new normal recorder callbacks while leaving the same CDP command channel usable. Forwarding is synchronous, with no adapter-owned deferred callback queue. The recorder stops the source, finishes clock sampling, cuts off delivery, then drains every admitted raw operation and fulfilled protocol acknowledgement response before protocol detachment. Sending an ACK alone cannot increment the acknowledged count. Safe persistence can continue independently after detachment, but successful bundle completion must drain it and join owned work. Source-stop capture time is unchanged by these later operations.

The adapter guards against a forwarding listener already selected by a reentrant emitter before unsubscription. Any such observed invocation excluded after cutoff must notify a fixed-code rejected-frame failure and attempt its real acknowledgement; it cannot leave a successful zero-rejection track. An upstream event that never reaches the recorder's subscription remains unmeasured. Cutoff and detach do not prove that Chromium or Playwright flushed all queued frames. Preserve the unknown source-drop count and the strict successful-track receipt, persistence, and acknowledgement equality. A failed deadline may leave a stable incomplete result while actual resource ownership remains pending.

Raw capture remains limited to two pending frames per side and 128 MiB across the run. Once a frame is completely masked and raw buffers are released, CDP acknowledgement may occur before durable writing. The sanitized persistence queue has a separate 256-frame per-side and 32-MiB run-wide limit. Timestamp order is checked at acceptance, independent of disk completion. Only successful writes count as persisted frames. Bundle completion drains accepted safe writes; capture end time comes from source stop, not disk drain. Overflow, disk failure, and cancellation retain truthful failure state and bounded cleanup.

Source and bound input permissions represent Git executable semantics. Snapshots preserve exact bytes and executable status. Declared helper copies use 0644 or 0755 below private 0700 parents; caller permission bits and ACLs are not changed.
