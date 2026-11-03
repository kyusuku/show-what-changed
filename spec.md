# show-what-changed implementation specification

**Revision:** 0.3. **Date:** 2 November 2026. **Target:** the first public 0.1.0 experimental release, implemented from the existing candidate within a targeted 24-hour work window.
**Owner:** Tampraphon Lorattanasane. **License:** MIT.
**State:** implementation contract, not a claim of implemented support or release readiness.

> Given two source versions and an explicit recipe for running a web application, run both versions, replay the same browser scenario, and produce a truthful BEFORE | AFTER motion video.

This revision supersedes the npm-only, keyframe-first release boundary. The [completed revision 0.2](docs/audit/spec.r02-completed-2026-11-02.md) and its evidence remain historical. The existing implementation and demos still have that older scope until the new gates pass. Do not carry old passing statuses into this revision.

The [implementation graph](docs/implementation-graph.md), [machine-readable graph](docs/implementation-graph.json), [decision record](docs/audit/spec-revision-0.3-design.md), and [general web-app acceptance contract](docs/web-app-acceptance.md) support this document. This spec is normative. Conflicts in supporting documents must be repaired before implementation proceeds.

## 1. Product and release boundary

### 1.1 Required outcomes

- Support locally runnable browser applications without a language, framework, package-manager, or root-manifest whitelist. A static site, Python app, npm app, pnpm monorepo, or containerized app uses the same source, scenario, and output contracts.
- Provide an explicit execution recipe. Automatic discovery is a convenience, not a prerequisite for compatibility. A recipe declares setup, application directory, startup, environment bindings, backing services, readiness, and state assumptions.
- Compare exact Git commits or a commit against the final eligible WORKTREE bytes. Default BEFORE is exact HEAD. Default AFTER is WORKTREE. A requested merge-base mode is explicit.
- Preserve the caller's checkout, index, branch, uncommitted files, and installed dependencies. Execute only in separately owned source snapshots.
- Make motion the default capture mode. Record actual intermediate browser frames with app animations enabled. Do not manufacture motion by interpolating images, fading between screenshots, or changing playback speed independently on each side.
- Retain keyframes as an explicit alternative and as checkpoints/posters. Never silently substitute them for failed motion capture.
- Prove useful operation across representative web applications through the installed package. Public fixtures, documentation, and acceptance contracts must be independent of any private application.
- Deliver a CLI, strict JSON output, and a generic coding-agent skill. The surrounding AI supplies repository knowledge and scenarios. No model call is embedded in the product.
- Prepare a publicly releasable repository, package, documentation, synthetic demo, license inventory, and reproducible evidence. Publication is a separate authorized action.

The tool remains one TypeScript ESM npm package running on Node 24 on Linux and macOS. That does not require target applications to use Node, npm, or JavaScript. Target runtimes are separately supplied prerequisites. The tool does not silently install system runtimes, Docker, browser binaries, FFmpeg, or global package managers.

### 1.2 Honest compatibility statement

The public claim is: “Compare web applications across stacks using an explicit local execution recipe.” It is not “automatically run every repository.” Compatibility requires a supported source layout, available declared runtimes/services, a reachable local browser UI, and a valid scenario.

The required examples cover static files, root npm, a pnpm workspace with shared packages, a non-JavaScript application, and a Docker application with an isolated backing service. No built-in adapter for each language is required. A custom recipe must not require a fake package.json or conversion to npm.

Remaining limits must be published: Linux/macOS, Chromium, one repository, one selected app per run, one viewport per run, bounded resources, supported local Git layouts, and explicit data/auth setup. Native apps, terminal-only programs, production-site recording without source identity, remote preview URL comparison, Windows, automatic SSO login, browser extensions, popups, cross-origin main-frame journeys, video/audio export beyond MP4, upload bots, and a dedicated MCP server are deferred.

### 1.3 Time and completion

The 24-hour target applies to extending the existing code, with four concurrent owners, prepared tools, accessible representative web app source, and a usable local Docker daemon with buildx. It is not an unconditional delivery guarantee. Hours 0–2 settle capture, source-volume, and service-ownership risks. The final four hours are reserved for verification and repairs.

A missed checkpoint does not authorize dropping motion, representative web app, source preservation, masks, truthful failures, or cleanup. Report incomplete work and the exact failing gate. Additional framework presets, caches, automatic route adapters, visual polish beyond the approved layout, and hosting integrations are the first deferrals.

## 2. Architecture and ownership

Keep the current shallow modules and replace their npm/keyframe assumptions.

| Module | Responsibility |
| --- | --- |
| schema | Strict versioned input/output contracts, defaults, and generated JSON schemas |
| planner | Pure source inspection, recipe normalization, route selection, immutable execution preview |
| workspace | Language-independent inventories, source materialization, provenance, caller preservation |
| runtime | Prerequisites after consent, environment resolution, setup/bootstrap commands, processes, containers, readiness, owned cleanup |
| recorder | Browser actions, source clocks, masked frame streams, checkpoints, step results |
| composer | Timestamp scheduling, trusted presentation, encoding, poster, offline recomposition |
| runner | Lifecycle sequencing, resource registry, cancellation, status reduction |
| cli | Flags, execution consent, one JSON envelope, human diagnostics |

Installation moves out of workspace into runtime. Workspace must not import package-manager policy. Recorder must not know npm, pnpm, application directories, or Docker ownership. Composer must consume only sanitized artifacts and validated metadata.

RunContext owns a run ID, private directories, monotonic deadline, cancellation signal, diagnostic sink, and resource registry. Every process, browser context, frame queue, container, image, network, and temporary directory registers before the next fallible operation. Registration and cleanup are idempotent.

The core flow is:

~~~mermaid
flowchart LR
  Source[Git sources and recipe] --> Plan[Immutable plan]
  Plan --> Workspace[Two owned snapshots]
  Workspace --> Runtime[Setup and owned services]
  Runtime --> Capture[Actions and masked motion frames]
  Capture --> Compose[Aligned timeline and MP4]
  Compose --> Evidence[Manifest poster and local PR text]
~~~

## 3. Versioned contracts and CLI

### 3.1 Schema policy

All active input/output documents use schemaVersion 2. The package is unpublished, so do not build parallel v1 execution paths. Reject v1 inputs with a migration diagnostic. Port existing keyframe behavior into schema 2. Old candidate archives and v1 media remain readable with their historical binary; new compose does not claim v1 compatibility.

The corrected unpublished motion capture contract separates observed timing from bounded playback. Earlier experimental schema 2 captures with the obsolete motion start/end shape remain associated with their historical binary. Current compose requires the current strict capture shape and must reject the obsolete shape rather than silently reinterpret it. Config, scenario, recipe, and plan shapes do not change for this correction.

Use strict objects and discriminated unions. Reject unknown keys, invalid combinations, and unsupported versions. Generate JSON schemas from the same definitions used at runtime. Every JSON example in this spec and the packaged documentation must validate.

Config and scenario inputs are UTF-8, at most 1 MiB each. Saved plans may be at most 128 MiB because they describe bounded source inventories. Capture/timeline/manifest metadata may be at most 256 MiB each. Enforce byte limits before parsing and item limits after parsing. IDs match [a-z0-9][a-z0-9-]{0,63}. Human captions are at most 160 characters, locator strings 512, and fill values 4096. Argument vectors contain 1–64 strings of at most 4096 characters each, without NUL bytes. Config is data and is never imported as executable code.

### 3.2 Commands

Keep plan, compare, compose, doctor, and clean. With no subcommand, use compare. Preserve --base, --head, --merge-base, --route, --scenario, --config, --json, --allow-exec, --plan, --timeout, --ci, --help, and --version.

Routes and scenarios are mutually exclusive and repeatable up to three times. Scenarios contain at most twelve steps. A saved plan excludes source, route, scenario, and config overrides. --timeout is the overall execution deadline, default 1800 seconds and maximum 3600. CI never prompts. Plan and doctor never execute repository commands or start its services.

~~~sh
show-what-changed plan --config show-what-changed.config.json --scenario change.scenario.json --json
show-what-changed compare --plan .show-what-changed/plan.json --allow-exec --json
show-what-changed compose .show-what-changed/runs/RUN_ID --json
~~~

The examples describe the revised interface and must not be advertised as working on the historical candidate.

### 3.3 Result and plan

Every JSON command emits exactly one envelope with schemaVersion, command, status, exitCode, data, error, and warnings. Child output goes to bounded private diagnostics, never stdout. Status is ok, partial, failed, nothing, or cancelled. Errors include code, phase, optional side/step ID, sanitized message, and a useful next action.

A plan includes resolved source OIDs, requested refs, comparison mode, private canonical repo path, WORKTREE fingerprint, materialized-input inventory, appDir, fully normalized recipe, scenarios, coverage, source counts/bytes, config/scenario content digests, command arrays, environment reference names, required resources, limits, and consent notice. It contains no resolved environment secrets or auth-state bytes.

Compute planId as SHA-256 of canonical JSON excluding planId and generatedAt. Canonical JSON recursively sorts object keys and preserves array order. Bind local config/scenario file bytes and any referenced local recipe inputs by digest. On compare, revalidate those digests and the WORKTREE fingerprint. Compare explicit refs by the pinned OIDs even if branches move. For WORKTREE require its pinned HEAD to remain unchanged. Report STALE_PLAN or STALE_SOURCE instead of silently replanning.

## 4. General execution recipe

### 4.1 Configuration shape

This pnpm example is a schema example. The general web-app acceptance contract defines the required behavioral evidence.

~~~json
{
  "schemaVersion": 2,
  "appDir": "apps/web",
  "execution": {
    "env": {
      "APP_ORIGIN": {"template": "{origin}"}
    },
    "services": [],
    "setup": [
      {"cwd": ".", "argv": ["pnpm", "install", "--frozen-lockfile"], "timeoutMs": 600000}
    ],
    "start": {
      "kind": "process",
      "cwd": "apps/web",
      "argv": ["pnpm", "exec", "next", "dev", "--hostname", "127.0.0.1", "--port", "{port}"]
    },
    "ready": {"path": "/", "statuses": [200], "timeoutMs": 300000},
    "bootstrap": [],
    "state": {"kind": "stateless"}
  },
  "routes": {"include": ["/"], "params": {}},
  "capture": {
    "mode": "motion",
    "viewport": {"width": 1280, "height": 800},
    "maskRects": [],
    "fixedTime": null,
    "stepTimeoutMs": 10000,
    "observeMs": 800,
    "maxScenarioMs": 60000
  }
}
~~~

A static site has appDir ".", empty setup, and process argv ["python3","-m","http.server","{port}","--bind","127.0.0.1","--directory","public"]. A Python application can create its own .venv and run its pinned application server. Neither case is required to contain any npm files.

Required root fields are schemaVersion and execution. appDir defaults to ".". Routes default to empty include/params. Capture defaults to motion with the values shown. execution requires start and state. Its env, services, setup, bootstrap, and inputs default to empty. ready defaults to path "/", statuses [200], timeoutMs 300000. Command cwd defaults to appDir and timeoutMs to 300000. Setup/bootstrap commands have no kind field.

All cwd, appDir, Dockerfile, build-context, generated-directory, and state-file paths are normalized relative paths with no escape, symlink ancestor, or control character. Resolve command cwd inside each owned snapshot. Relative argv[0] resolves from command cwd. Absolute installed executable paths are permitted and recorded privately.

### 4.2 Commands, prerequisites, and environments

Run argv arrays with shell:false. Compound commands belong in an explicitly invoked repository script. Do not concatenate shell fragments. Setup has at most eight commands. Bootstrap has at most four and runs after application readiness but before browser contexts. Both sides execute independently.

A process start must remain foreground. Daemonizing or secretly creating detached Docker resources is outside the process recipe contract. Setup/bootstrap scripts are trusted arbitrary code, not a security sandbox. The tool cannot prevent deliberately malicious code from escaping process ownership.

Optional execution.requires is a list of at most eight {argv, expectedVersion} probes. expectedVersion is a semantic-version range. Probes run only after execution consent, with the application's environment. Missing or incompatible capabilities fail before setup. Record the actual executable and observed version privately; public metadata omits local absolute paths. Known npm/pnpm recipes use frozen installs and verify that lockfiles do not change. Explicit recipes may use any tool and multiple lockfiles. Record dependency reproducibility as declared, none, or unverified; a custom command's name alone cannot prove reproducibility.

Start from the existing minimal process-environment allowlist. execution.env maps names to exactly one of {literal}, {fromEnv}, or {template}. Literals are for nonsecret configuration. Secrets must use explicitly named fromEnv bindings. Missing bindings fail before app execution. Resolve a binding once per run, then use it on both sides except side-specific resource values. Plans and public artifacts record binding names only. Redact resolved sensitive values before diagnostic persistence. Do not discover or copy ignored/private .env files, or inherit the entire parent environment. Eligible tracked .env files remain source under section 5; planning warns about them without printing contents. Source preservation is not secret detection.

Optional execution.pathPrependFromEnv names one parent variable containing one absolute executable-directory path. Add that directory to the child PATH only. It selects an app runtime without changing the tool's Node process. Never infer app engine compatibility from the tool's process.version.

The only substitutions are {port}, {origin}, {stateDir}, {side}, {runId}, {input.ID}, and {service.ID.host}/{service.ID.port}. In argv, each substitution occupies one whole argument. In env.template, tokens may occur within a string. Reject unknown tokens. No general expression evaluation or secret substitution into argv is supported.

{port} means the app's published loopback port for host-side application setup/bootstrap/probes, the app's containerPort for app-container environment, the service's allocated loopback port for process-service commands, and that service's containerPort for container-service environment. {origin} always means the selected app's browser-reachable loopback origin. Test unequal published and container ports explicitly. {stateDir} is a side-owned private directory. Services have distinct IDs and ports. Service host/port tokens resolve to loopback published ports for host consumers and to side-network aliases/container ports for container consumers. A container cannot refer to a host-process service in this release.

Optional execution.inputs declares at most sixteen nonsecret helper files as {id,path}, totaling at most 8 MiB. Resolve paths relative to the config directory, or accept explicit absolute local paths. Require regular files without symlink ancestors. Hash them during planning, revalidate at execution, and copy exact bytes and executable-bit semantics into each side's private inputs directory. Materialize regular inputs as mode 0644 and executable inputs as 0755 under private mode-0700 ancestors. Do not copy arbitrary caller permission bits or ACLs; never change caller permissions. Preserve the filename extension. {input.ID} resolves to that copied file, never the mutable caller original. Helper imports must use separately declared files through explicit token arguments; no undeclared sibling tree is copied. Local auth/service wrappers can use this mechanism without editing application source. Input paths and content remain private; plans bind their digests.

Allocate resources before commands so build and serve receive the same side-specific public origin. App environment applies to setup/start/bootstrap. Setup and bootstrap always execute on the host, including for a container app, and receive host-resolvable service endpoints. Container startup receives container-network endpoints. Resolved fromEnv values remain identical across these consumers; generated tokens are consumer-specific. A service has its own env map and does not inherit app secrets. Tool-owned Git, browser, and encoder processes never inherit application secrets.

### 4.3 Host processes and services

execution.services contains at most four entries, started in declaration order before application setup. IDs are unique. A service can refer only to preceding services. Process services have {id, kind:"process", cwd, argv, env, ready}. Their readiness is either {kind:"http", path, statuses, timeoutMs} or {kind:"tcp", timeoutMs}. TCP readiness proves only that the owned port is listening, not database health. Application startup readiness is HTTP only. Then bootstrap may create authentication state, then browser contexts are created and scenarios run. A successful goto proves navigation, not application-specific UI readiness. Scenarios that require a particular UI state use explicit expectVisible steps; their failures follow the normal required-step failure rules. HTTP readiness alone is never proof of a successful UI comparison.

Process servers get fresh process groups and exact loopback ports from a bounded allocation range, 4310–4499. Each listener must belong to the expected live process group and bind only to loopback. Detect unrelated listeners, silent port fallback, startup exits, and readiness redirects outside the app origin. Retry a port race at most twice after owned cleanup. Require the existing reliable lsof/ps capability checks.

An optional process-service setup array runs after its preceding dependencies are ready and before starting that service. It obeys the same command and provenance rules.

### 4.4 Docker execution

Docker is optional for host-only recipes and required for a Docker recipe. Support a deliberately bounded Docker Engine adapter, not arbitrary Compose orchestration.

A container service has {id, kind:"container", image, containerPort, env, ready}. image must include an immutable digest. The tool creates one separate container per side and service. Persistent named volumes, external networks, host networking, privileged mode, host device access, Docker socket mounts, and caller-supplied container names are unsupported. App/service data lives in its disposable writable layer or owned mounts. For both service images and locally built app images, inspect image-declared VOLUME destinations before create. Cover those destinations with explicit per-side tmpfs mounts, each capped at 256 MiB. Reject destinations that overlap application source, known executable paths, /swc-state, or /swc-inputs. Inspect all mounts before starting; unexpected anonymous/named volumes or host binds are an error, not an implicit ownership exception.

The app start variant is {kind:"container", build:{context, dockerfile}, containerPort}. Build each side independently from its owned snapshot, without extra build contexts or secret build arguments. Record the Dockerfile digest, image IDs, and resolved base image identities. Pin base images in release fixtures. There are no arbitrary extra docker flags. Allow only the bounded tmpfs mounts above, the tool-owned side state directory read/write at /swc-state, and declared private inputs read-only at /swc-inputs. For the container consumer, {stateDir} and {input.ID} resolve to those paths. Host setup/bootstrap use the host paths for the same owned directories. App environment is passed at run time; build-time public configuration must be expressed in source or a declared nonsecret setup-generated file covered by the generated-file contract.

For each side create a unique labeled network. App and container services use that network. Publish required host ports explicitly on 127.0.0.1. Verify inspected container identity, labels, network membership, port mappings, and liveness before readiness. Docker daemon listeners use this ownership check, never a bypass of host-process ownership.

Container-app builds require the Docker buildx plugin and a disposable docker-container builder owned by this run. Do not select or mutate the user's default builder. Use a private client configuration, an unpredictable builder name, and explicitly recorded builder container/state-volume IDs. Register the intended name before creating it and reconcile interrupted creation/build by that exact identity. Apply run/side labels and unique tags to final images and record their IDs. On cancellation, stop/remove the owned builder to terminate its build tasks, then verify its container and state volumes are absent. Builder-created cache is owned and removed with that builder; pre-existing Docker builders, images, caches, and credentials are never pruned or copied. The builder state-volume exception is tool-owned infrastructure, not permission for app/service named volumes. An unresolved builder or image identity produces cleanup failure. G07/G15 include interruption during build and survival of an unrelated builder/image.

Register random run/side ownership labels and intended resource names before creation, then record exact returned IDs. On an interrupted create, reconcile by exact ownership label. Clean only verified owned IDs. Remove containers, then networks, then locally built owned images. Shared pulled base images remain cached. Never prune global resources or remove anything with uncertain ownership. Resource absence is verified after cleanup. Docker cleanup failure prevents clean success.

### 4.5 State and authentication

execution.state is one of:
- {kind:"stateless"}. The selected scenario requires no mutable backend state. This is a declaration, not proof of arbitrary application behavior.
- {kind:"isolated", seedId:string}. seedId must resolve to one nonsecret execution.inputs ID. Each side receives identical bound seed bytes through {input.ID}, its own state directory/database, and setup/bootstrap that initializes that state. Missing or changed seed inputs fail before execution. Record the seed input identity, declared isolation, and actual service identities; do not infer semantic database equality. The synthetic acceptance test proves both initial datasets and independence after a write.
- {kind:"external-read-only", description:string}. External dependencies are outside tool ownership. Display a data-parity warning. The scenario must not intentionally mutate them.

Shared writable external backends are unsupported in the initial release. Production credentials, migrations, paid providers, and worker operations require their own explicit user authorization; the tool does not obtain that authorization from a recipe file.

Optional execution.auth is {storageState:"relative-file.json"}. Resolve it under each side's private stateDir after bootstrap. Validate the bounded Playwright storage-state structure. Permit only that side's exact origin and host cookies; reject other origins rather than silently rebasing credentials. Browser contexts receive separate copies. Session-storage injection and interactive third-party login are deferred. No storage state, credential, or cookie value enters public artifacts. Authentication is tested against a local synthetic app, not assumed from schema presence.

## 5. Source identity and snapshots

Require a nonbare local Git repository with existing commits and no unresolved index. Preserve exact-ref and explicit unique merge-base semantics. Reject refs beginning "-", unavailable refs, and ambiguous merge bases. Do not fetch, stash, reset, or change the caller's branch.

Use Git argument arrays with hooks, external diff, textconv, and fsmonitor disabled for managed operations. Parse NUL-delimited filenames. Compare exact endpoint content; disable rename inference and treat renames as delete/add. Support detached HEAD and shallow repositories when the requested objects exist. Reject invalid UTF-8 paths instead of corrupting them.

WORKTREE means final filesystem bytes. Enumerate the union of HEAD-tracked, index-tracked, and nonignored untracked paths. Index-only deletion with a retained file must still render that file. A staged edit reverted on disk must render the disk version. Source identity includes existence, executable bit, length, and SHA-256 of every eligible file, sorted by UTF-8 path bytes.

Snapshot the entire eligible repository, not just appDir. Root workspace metadata, shared packages, assets, and lockfiles must survive at their original paths. Remove the root npm/package-lock requirement and the blanket rejection of workspace/local dependencies or multiple package-manager files.

Default limits are 1 GiB and 100,000 source files per side. Optional source.maxBytes may raise the byte limit up to 2 GiB; source.maxFiles may raise the count to 200,000. A single source file is at most 512 MiB. Stream hashing, copying, and Git blob reads with bounded buffers; do not load an entire repository through one maxBuffer call. Plan reports measured counts and estimated snapshot disk needs. Account separately for dependency/build and media budgets.

Never silently discard tracked files because a directory is called dist, build, or docs. Tracked static build output can be application source. Always exclude .git internals and the tool's registered output. Source symlinks, submodules, LFS pointers, sparse checkouts, configured Git filters, and file/directory type transitions remain explicit unsupported source layouts. Generated dependency symlinks in owned ignored dependency trees are permitted.

Optional source.generatedDirs is at most 32 relative directory prefixes. It declares directories created by setup/build that are not source. Reject a declaration covering tracked files or eligible pre-existing input files. Git-ignored untracked dependencies/build output are already outside the input inventory. New nonignored files outside declared generatedDirs invalidate provenance. A general source-exclusion glob feature is deferred.

Create separate detached owned worktrees even for identical OIDs. For WORKTREE, overlay captured final bytes and Git executable-bit semantics and apply deletions. Validate path containment without following symlinks. Re-inventory the caller immediately after copying and compare the destination against the intended snapshot. Concurrent edits cause STALE_SOURCE; do not claim an atomic filesystem snapshot.

Rehash both actual source inventories after setup/bootstrap and after capture, including newly eligible files. Pre-capture source mutation fails with exit 5. Mutation discovered after capture makes available media partial and visibly invalidates source provenance. Generated artifacts and declared private state remain outside source identity.

Capture fingerprints identify supplied source bytes, not external APIs, database contents, system libraries, or runtime nondeterminism. Record execution provenance separately: container output has its built image ID, while host generated/build artifacts are explicitly unverified. A setup-generated file can affect rendering without changing the source inventory; its exclusion must not be described as proof of build-artifact parity. Test that changed generated configuration changes the built image identity or retains the explicit unverified host-build label. Record those limitations separately. Do not conflate an exact Git OID with full environmental reproducibility.

## 6. Scenarios and coverage

Explicit scenarios are the reliable cross-stack interface. Retain basic Next App Router discovery under appDir as a convenience. Discovery reads both endpoints, handles route groups and supplied dynamic samples, and reports unresolved shared components/configuration, unsupported slots/interception, and omitted routes. It never executes app code or invents routes for another framework.

Explicit scenario/route selection sets coverage.complete=false with EXPLICIT_SELECTION. That alone does not make a successful bounded run partial. Automatic unresolved/omitted/unsupported candidates do. No resolved scenario with possibly relevant changes is ROUTE_REQUIRED, not “no change.” No source changes without explicit selection is exit 4. Only proven documentation/test-only changes may yield NO_UI_CANDIDATES. Treat ambiguous files as potentially relevant.

A scenario uses schemaVersion 2, an ID, title, and 1–12 steps. First step is goto. Each step has a unique ID, op, optional note, only:before|after|both, allowMissing:Side[], timeoutMs, and observeMs. Defaults are both, no allowed absence, configured timeout, and configured observation interval. Browser contexts/storage reset between scenarios from the declared per-side auth input. Backing services and backend data are initialized once per run and persist across scenarios. There is no automatic database reset between scenarios; authors must make their ordered scenarios valid under that lifecycle.

| Operation | Operands and behavior |
| --- | --- |
| goto | App-relative path. Navigate with DOMContentLoaded and require a successful HTTP response and allowed final origin. |
| click | Exact locator; normal actionability and strict matching. |
| fill | Exact locator and value. Replace contents. Values never appear in captions or public metadata. |
| hover | Exact locator; preserve hover through later checks/captures. |
| scrollBy | y from -1600 through 1600, optional exact target locator. Smooth-scroll the window or that element. |
| expectVisible | Exactly one visible matching target before the step deadline. |
| screenshot | Capture a checkpoint without altering pointer/focus. Motion recording continues around it. |

Locator is exactly one of role/name, label, text, testId, or css. Matching is literal and exact. No regex-string magic, nth, XPath, fuzzy fallback, or silently clicked neighboring control. CSS gets a stability warning. An optional scroll target must resolve to exactly one element. Verify the requested clamped scroll position and wait for scroll movement to finish or timeout; do not assume window is the app's scrolling element.

App-relative paths start with "/" and remain on the side's allocated origin. Reject network-path references, alternate schemes, credentials, controls, and backslashes. A null navigation response succeeds only for a verified same-document fragment change from a previously successful document. Popups, new pages, downloads, dialogs, and file choosers fail the affected step. Subresources/server traffic can still use the network.

only excludes a side without lookup. allowMissing permits only zero matches on a locator operation after bounded presence polling. It never excuses ambiguity, hidden/disabled existing controls, assertion errors, or timeouts after finding a target.

| Side outcome | Subsequent behavior | Media |
| --- | --- | --- |
| ok | Advance after both sides finish observation | Real captured frames and checkpoint |
| expected_absent | Continue | Explicit expected-absence annotation; no verified pair |
| skipped_by_side | Continue | Explicit side exclusion; neutral or last safe image |
| failed | Block later steps on this side | Failure begins at recorded failure marker; safe prior frame if capture is unavailable |
| blocked | No further action | Clearly held image with blocked-step label |

A fresh scenario gets fresh contexts even after a prior side failure. Required failures yield partial media when safe material exists. changeRatio is defined only for ok/ok checkpoint pairs. Absence, exclusion, or held failure images must not be counted as verified unchanged results.

## 7. Browser motion and privacy

### 7.1 Capture modes

Use the pinned Chromium through Playwright, DPR 1, en-US, UTC, light scheme, and fresh contexts. Service workers remain blocked. Keep browser sandbox defaults. Default viewport is 1280×800. A run may configure even/odd integer dimensions from 320–1920 wide and 240–1200 high, at most 2,073,600 source pixels. Both sides use identical settings. Release tests cover 1280×800 and a 390×844 narrow viewport. Physical device emulation and multiple simultaneous viewports are deferred.

Motion uses reducedMotion:"no-preference" and leaves CSS animation, transitions, caret, timers, and requestAnimationFrame running. Optional fixedTime fixes Date only. Do not pause animation clocks or smooth motion after capture. Keyframe mode retains animation-disabled screenshots and selector masks. Motion capture.mode has maskRects and rejects maskSelectors; keyframes has maskSelectors and rejects maskRects. The default is motion.

Each step timeout includes lookup, action, required settlement, observation, and its checkpoint. Default 10 seconds, range 100–30000 ms. observeMs is 0–3000, default 800. Scenario maximum is 60 seconds and run maximum three scenarios. Wait for fonts and two animation frames before a checkpoint without waiting for network idle. Delayed UI requires explicit expectVisible. Continuing animation is valid in motion mode.

Derive scenario start and its configured action deadline from one host monotonic sample. A deadline does not permit a late successful action. Failure observation, blocked results, source shutdown, and safe persistence may complete after the action allowance. Preserve their actual evidence and complete owned cleanup. The motion playback prefix remains bounded by the configured allowance, at most 60 seconds.

### 7.2 Motion backend and clocks

Use Chromium CDP Page.startScreencast with format:"png" and everyNthFrame:1. The local design probe established that the pinned browser can supply PNG frames and metadata.monotonicTimestamp. It did not prove sustained masking, encoding, Linux behavior, or release smoothness.

No native recordVideo file is written. Raw frames remain in bounded memory. Preserve source monotonic timestamps in seconds, optional source epoch timestamp, receipt time in the run clock, sequence, dimensions, scale/offset metadata, mask digest, and sanitized artifact hash. Require finite, increasing source monotonic timestamps and expected dimensions. A missing clock field is CAPTURE_CLOCK_UNSUPPORTED, not permission to substitute callback receipt time.

Measure action dispatch/completion markers in the same CDP monotonic domain using Performance metrics and bounded host round-trip brackets. Before recording, choose one fixed unit-rate mapping per session, runElapsedMs = 1000 * sourceMonotonicSeconds + offsetMs. Derive offset/error bounds from bracketed samples, not callback arrival. Later calibration samples after navigation validate this same mapping; they never replace its offset or retime prior frames. Preserve native durations. Retain the maximum observed mapping uncertainty and drift. The combined error bound must be at most 40 ms. Missing/incompatible clock samples, a clock reset, or excessive drift fail that side explicitly. Test a recalibration that would move a timestamp backward and require failure. Do not subtract page performance.now(), Node performance.now(), and epoch values as if they were interchangeable.

Both sides dispatch an action from one barrier. Record actual dispatch markers and skew. Wait for both action/observation outcomes before the next barrier. Record during navigation, actions, waiting, and failure detection. Faster sides remain live while waiting; label that interval “Waiting for other side.” Do not freeze a healthy app merely to force identical animation progress.

Keep the actual host barrier unchanged. Validate source action markers against host boundaries through their measured host brackets, while retaining the fixed source mapping and source-domain order. A mapped estimate within its valid uncertainty may precede a host barrier or follow the host observation end; this does not move the barrier or event. Host-only blocked, excluded, and fallback times obey host ordering directly. A host failure before its source dispatch's hostBeforeMs is a definite reversal; a failure inside that dispatch bracket can be concurrent with sampling. Do not add arbitrary timing tolerances or constrain initial/shutdown calibration samples as though they were action markers.

Callback work must be bounded and acknowledged. At most two pending raw frames per side and 128 MiB of raw frame buffers are allowed. After complete masking and release of raw buffers, acknowledgement may precede durable persistence. A separate sanitized queue is bounded to 256 frames per side and 32 MiB across the run. Drain accepted safe writes before returning a completed bundle; stop source timing when recording stops rather than after disk drain. Persistence or queue failures remain explicit, and counters distinguish acknowledgement from actual persistence. Apply backpressure and record sequence/gap statistics. Do not hide queue overflow, decoder errors, timestamp regressions, or dropped frames. A capture fault stops the affected side, blocks its later actions, and yields partial media when safe frames exist.

A delivered frame is one handed synchronously to the recorder's subscriber. On normal shutdown, stop the source and finish clock sampling, end that subscription at an explicit synchronous cutoff, then finish masking and actual acknowledgements for every delivered frame before detaching the protocol session. Only a fulfilled protocol acknowledgement response increments the acknowledged count; sending the command is insufficient. Drain accepted safe writes and join owned work before successful completion. The cutoff does not retract a callback that already began. A known forwarding invocation excluded after cutoff must produce an explicit rejected-frame failure rather than a lossless success claim.

Subscription cutoff is not a browser encode or protocol flush. A frame still queued in Chromium or Playwright may never reach the recorder, including a frame with a pre-stop source timestamp. These unobserved frames are outside the delivered counters; sourceDroppedFrames remains null. Disclose this limit instead of claiming every browser frame was captured. Keep source-stop capture time separate from later delivery cutoff, acknowledgement, persistence, and disposal. The motion acceptance thresholds below still apply without exception.

Do not mistake a static page producing few change-driven frames for capture failure. Preserve gap statistics and distinguish explicit capture errors from no visual updates. The controlled movement fixture establishes cadence while known motion is happening.

### 7.3 All-frame masking

Motion masks are at most twenty fixed viewport rectangles {x,y,width,height} with integer coordinates, positive size, and full containment in the selected viewport. Fill with opaque #101010. Apply the same rectangles to every frame before persistence, encoder input, diagnostic image, or checkpoint output. Decode and validate PNG dimensions before allocating large images. Resize/scale metadata outside the verified DPR-1 mapping fails closed.

A rectangle must cover the entire travel area of the sensitive content. It does not follow an element. Dynamic selector tracking in motion is explicitly deferred because separately sampled DOM geometry is not frame-atomic. Existing CSS-selector masks remain available only in keyframe mode. Never silently ignore an incompatible mask configuration.

On mask failure, persist no affected raw frame. Use a prior sanitized frame or neutral panel for failure presentation. Do not save raw recordings “temporarily.” No automatic PII detection is claimed. Public demo fixtures use synthetic content.

Source frame storage is limited to 12,000 PNGs and 10 GiB per run, checked incrementally. Disk exhaustion or limit overflow is explicit failure/partial output, never success. Capture must cancel cleanly under backpressure. Source frame buffers, queues, and encoders belong to the resource registry.

### 7.4 Motion acceptance

The primary motion gate uses a known three-second continuously moving object, a native transition, a scroll container, and synchronized visual pulses. Each side must retain at least 60 distinct measured object positions across that interval, with no unexplained source gap above 200 ms while movement is known to continue. Measure source timestamps and decoded motion, not only file FPS or frame hashes affected by a clock overlay.

Pulse alignment error must be at most 80 ms under the verified clock mapping. Record drift and dispatch skew. Repeat the entire final capture/mask/compose/encode path three times on each required platform. Review the videos at normal speed. A visible stall, invented transition, or perceptually poor motion can fail review despite meeting numeric minimums.

These thresholds are release criteria, not measured guarantees for every web app. Output is 30 FPS, not a claim of 30 newly captured frames each second or a performance benchmark. No 60 FPS promise is made.

## 8. Composition and artifacts

### 8.1 Media model

CaptureBundle schema 2 discriminates motion and keyframes. It records source identities, viewport, mode, sanitized settings, scenario/step results, clock mappings, frame references/hashes, and checkpoint metrics. Only the recorder creates sanitized-frame records. The composer validates paths, dimensions, hashes, bounds, and timestamps before use.

Each motion scenario stores timing with startMs, limitMs, and observedEndMs. The observed end is the maximum of the measured action-loop end and actual source-stop observations, not a later persistence-drain completion time. limitMs retains the configured scenario allowance. One shared pure projection derives the playback window from startMs through min(observedEndMs, startMs + limitMs). Keep all original step markers and sanitized frame evidence, including evidence outside that window.

Timeline schema 2 contains templateVersion 2, FPS 30, output dimensions, scenario/step boundaries, frame selections, annotation intervals, poster selection, and totalFrames. A motion track maps source timestamps to one common elapsed timeline at original speed. At each output time select the latest available actual source frame. Neutral pixels precede the first valid frame. Repetition represents elapsed time or explicitly held failure/excluded states. No optical-flow interpolation, per-side time warping, or synthetic in-between frames.

Each scenario has one 1-second title. Motion scenario duration is its derived playback end minus start, rounded up once to integer output frames. Sample startMs + frameIndex * 1000 / 30 without retiming source events. All intervals are half-open and contiguous. Output duration is bounded by three title seconds plus three 60-second scenarios. Intersect derived annotations with the relevant window and omit empty intervals. A failure after the shown window remains at its actual timestamp and appears in the existing title's final-outcome summary; never move its timed failure badge earlier. Preserve failed and blocked outcomes even when their intervals are not visible. Initial rendering and offline compose use the same projection and full validation. Keyframes use their configured observeMs with a minimum six output frames per step. Never mix timing semantics without a capture-mode label.

### 8.2 Presentation and encoder

Retain the existing 1920×686 comparison canvas, 4-pixel divider, 48-pixel header, and 40-pixel caption. Fit each source viewport into its 958×598 panel without cropping, stretching, or upscaling. Narrow viewports are letterboxed. Labels include BEFORE/AFTER and shortened source identity. Motion uses “MOTION”; keyframes use “KEYFRAMES.” Show bounded coverage, source/state limitations, waiting, expected absence, exclusion, failed, and blocked intervals where applicable.

Use the trusted HTML renderer for static labels, captions, title cards, and status overlays. Its only inputs are sanitized text and already masked images. Bundle the existing font, block network, escape through textContent, and use bounded one-line ellipsis. Initial captions remain English/ASCII fallback with an explicit Unicode warning. Unicode source identities and app screenshots remain intact.

Do not render every output frame through a fresh browser screenshot. Use FFmpeg scaling/composition with trusted generated numeric filter arguments and pre-rendered overlays, or an equivalently verified bounded pipeline. Doctor must check every newly required filter. No input text/path may become executable filter syntax.

Encode H.264/libx264, yuv420p, CFR 30, CRF 23, veryfast, faststart, without audio. Stream with backpressure. Validate codec, dimensions, decoded frame count, rational FPS, duration within one frame, and first/boundary/final decoded images. No unreviewed quality-degrading retry. Report file size without an upload-size promise.

Checkpoint changeRatio remains pixelmatch over masked source pixels, threshold 0.1, excluding anti-alias differences. It measures visible difference, not correctness or motion equivalence. Use only ok/ok pairs. Choose the earliest checkpoint with the highest valid ratio as poster. If none exists, choose an explicitly incomplete safe frame. Never choose a raw/unmasked frame.

compose validates saved sanitized source frames, overlays, timeline, and hashes and re-encodes without application servers, app runtimes, Docker, or a browser. It cannot repair failed actions, source mutation, poor capture, or missing frames. Preserve comparisonOutcome and cleanupOutcome independently from encodingOutcome. Successful encoding recovery updates artifact hashes/status without clearing earlier partial evidence.

### 8.3 Artifact and error contract

Create exclusive run directories under .show-what-changed/runs with UTC-time/random IDs and private permissions. Validate canonical containment and reject symlink/non-directory output ancestors. Never overwrite unrelated files. Do not automatically edit .gitignore.

Public-oriented artifacts are compare.mp4, poster.png, manifest.json, capture.json, timeline.json, and local pr.md. Sanitized source frames and overlays are separate subdirectories. Plans, auth state, environment material, resource ledgers, and bounded logs remain private. No secret values, fill values, raw HTTP bodies, absolute usernames, or raw browser exceptions appear in public metadata.

Manifest records schema/spec/tool versions, requested/resolved sources, materialized hashes, public recipe/scenario digests, selected runtime/image identities, capture mode, viewport, timestamps, clock quality, gaps, coverage, state/data-parity declarations, outcomes, artifact hashes/bytes/relative paths, warnings/errors, and cleanup. Missing artifacts are null, not nonexistent advertised paths. Exact config/scenario/input digests remain private for stale-input checks. Public recipe/scenario digests use a separately specified canonical redacted projection: retain schema version, IDs, operation kinds, side policies, and nonsecret capability declarations; replace every value-bearing operand, environment value/reference, locator, note, helper content, and auth field with a constant REDACTED marker. Public digests must not act as oracles for low-entropy fill values or credentials. Test a dictionary of short fill values and require identical public digests but different private digests. Omit a public digest if its projection cannot be proven safe.

| Condition | Status / exit |
| --- | --- |
| Valid media, source, cleanup, required actions and capture contract | ok / 0 |
| Useful safe media with required failure, blocked side, clock/capture failure, source mutation, automatic coverage gap, or cleanup failure | partial / 3 |
| No changes or proven no UI candidates | nothing / 4 |
| Invalid input, unsupported schema/source, stale plan/source, unresolved route | failed / 2 |
| Setup/bootstrap/materialization failure | failed / 5 |
| Startup/readiness failure before capture | failed / 6 |
| Execution consent missing | failed / 7 |
| Missing tool/app capability | failed / 8 |
| No usable capture, unsafe frame output, rendering/encoding/validation failure | failed / 9 |
| Overall deadline | cancelled / 10 |
| SIGINT or SIGTERM | cancelled / 130 or 143 |
| Internal defect | failed / 1 |

Cancellation takes precedence, then fatal errors, then partial. Append cleanup errors without hiding the first cause. Once a run directory exists, write a terminal manifest whenever process survival permits. Process crash/SIGKILL may leave a ledger for later diagnostics.

## 9. Trust, cleanup, and recovery

Execution consent binds the two source identities, command arrays, environment reference names, declared resources, and side effects shown in the plan. Existing explicit authorization may cover a run. --allow-exec is per invocation, not persistent trust. Interactive compare asks only when authorization is absent. A recipe, page, log, scenario, or CI variable cannot grant consent.

Application scripts and servers have the user's account privileges and may use the network. The tool has no telemetry or automatic upload. Worktrees and local containers are not a complete hostile-code sandbox. Browser request interception alone is not server egress isolation. Release fixtures and general web-app acceptance must avoid real accounts and paid/production services by construction.

Preserve the existing owned process-group supervision. Close browser contexts before browser shutdown, stop accepting frames, drain or discard bounded private queues safely, terminate owned command groups, and clean owned containers/resources and temporary workspaces. Give process groups TERM, a bounded grace period, then KILL. Cleanup has its own bounded 30-second budget. Docker operations also have deadlines.

Do not kill a process merely because a PID or port matches a stale file. Validate process identity/start time and ownership. clean refuses uncertain, active, or escaping targets and never performs global Docker cleanup. A tool-level repository lock prevents concurrent tool runs, not editor edits. doctor reports suspected abandoned runs without deleting them. Repeated cleanup is safe.

Logs are capped at 5 MiB per process and redacted before storage. Public diagnostics provide sanitized summaries, not raw tails. Preserve source provenance, media validity, and cleanup as distinct outcomes. Setup, recording, encoding, and cleanup must all respond to cancellation.

## 10. General web-app acceptance

Use the [web-app acceptance contract](docs/web-app-acceptance.md). Public release validation must be reproducible without access to a private application. Exercise a nontrivial, publicly redistributable web application with two useful normal-route flows, plus the static/npm/pnpm/Python/container matrix. Pin the source and license before executing it. Do not claim compatibility with every possible repository from these finite examples.

Run setup at the declared workspace root, build required shared packages, start only the selected app and declared services, and preserve independent side state. Do not convert applications to npm, discard required source, or use toy replacements for the selected normal-route flows. A separately generated large-repository fixture must exercise source inventories above the old 200 MiB limit.

Required flows cover navigation with actual menu or panel motion and inner-container scrolling at 390×844, and a form with synthetic invalid input plus a visible source change to its validation feedback. Prepare the change in an isolated candidate worktree. Select stable locators from the actual source. A local inert dependency is allowed only with explicit disclosure. It does not prove production authentication or external service behavior.

The final installed tarball must run both scenarios three consecutive times without manual intervention, produce reviewed motion media, preserve source/index/dependencies, and leave no owned resources. Save a public recipe and repeat command, then verify a subsequent WORKTREE comparison. The named source, scenarios, patch, dependencies, limitations, and evidence must be redistributable. Separate private app checks remain outside the repository and package and cannot be a public release prerequisite.

No private application names, identifiers, paths, source, selectors, recipes, environment/auth files, patches, recordings, or acceptance documents belong in the public source tree, package, demos, or published Git history. Test the actual candidate archive and full intended public history for leaks. Preserve any development history containing private context only outside the public release repository.

## 11. Verification gates

Each gate has a reproducible command, source identity, expected result, actual exit code, and artifact evidence. “Not run” is not passing. Tests that asserted obsolete npm rejection must be replaced with positive cross-stack tests; unrelated preservation/failure tests remain required. The new status ledger is [revision 0.3 status](evidence/revision-0.3-status.json).

| ID | Mandatory evidence |
| --- | --- |
| G01 | Strict schema 2 and every documented JSON example validate; unknown fields, tokens, unsafe paths, v1 inputs, incompatible mask modes, and malformed plans fail. |
| G02 | Exact refs, diverged endpoints, unique merge base, shallow missing refs, detached HEAD, index-only deletion, staged/unstaged cancellation, and WORKTREE additions/deletions preserve existing semantics. |
| G03 | Streaming inventories handle large-repository source and shared packages; source mutation/copy races fail; caller HEAD/index/tracked/untracked/dependencies remain unchanged. |
| G04 | Installed package compares root npm, pnpm workspace, Python app, and static site; non-JavaScript/static fixtures have no npm manifest. Tool/app runtime separation is exercised. |
| G05 | Recipe cwd/env/tokens/ordered services/setup/bootstrap behave as declared. Missing refs/prerequisites fail before app startup; lock/source mutation cannot yield success. |
| G06 | Host listener conflicts, silent fallback, unrelated listeners, readiness redirects/timeouts, and startup/capture exits produce truthful errors; unrelated processes survive. |
| G07 | Docker app plus backing service has side-isolated data, inspected ownership, and exact cleanup on success, startup failure, cancellation, and timeout. App/service image-declared volumes and interrupted buildx builders are covered; unrelated containers, networks, builders, and images survive. |
| G08 | Every scenario action, inner-container smooth scroll, exact locator ambiguity, fragment navigation, timeout cancellation, and hover persistence is exercised. |
| G09 | Expected absence/exclusion are unverified pairs; required failure blocks later side actions and is visibly labeled at the correct motion time. |
| G10 | Full motion pipeline meets section 7.4 on both platforms across three runs. Actual positions, source gaps, pulse alignment, and normal-speed viewing are recorded. |
| G11 | Every persisted frame has exact opaque masks before encoding through navigation, motion, failure, and cancellation. Decoded output is checked in scaled/letterboxed coordinates with codec-aware criteria for absence of sensitive content, not exact pixel equality after lossy H.264. No unmasked raw artifact exists. Keyframe selector masking still passes. |
| G12 | Clock fields, unit conversion, calibration uncertainty, drift, nonmonotonic/missing timestamps, queue overflow, static pages, and frame bounds have explicit tests. |
| G13 | Trusted titles/labels/status intervals, dimensions, safe failure panels, poster selection, Unicode fallback, and text escaping render correctly. |
| G14 | Exact frame schedule/count, first/boundary/final decoded images, codec/FPS/faststart, and offline recompose pass. Recovery cannot clear capture/source/cleanup faults. |
| G15 | SIGINT/SIGTERM and overall deadline during setup, container build/create, startup, recording, and encoding leave no owned resources; cleanup faults cannot report clean success. |
| G16 | Locks, PID reuse, stale ledgers, malicious output paths, symlink outputs, repeated clean, and forced-kill residue recovery preserve unrelated resources. |
| G17 | A synthetic authenticated app loads independent private storage states; isolated seeded state is side-specific; external-read-only state remains explicitly unverified. Secrets never enter public metadata/logs. |
| G18 | Pure planning executes no repository code; consent binding, private env resolution, JSON envelopes, artifact hashes, null missing artifacts, and no-change exits are correct. |
| G19 | Publicly redistributable web-app navigation/inner-scroll and form-feedback comparisons pass three consecutive times through the final installed package; exact public inputs, useful reviewed media, a subsequent WORKTREE run, preservation, and cleanup are verified. |
| G20 | Typecheck, build, generated schema checks, configured lint/format, unit/integration, full Linux and macOS installed-package smoke pass against the new candidate. |
| G21 | npm pack allowlist, clean tarball installation, help/doctor/plan/compare/compose/clean, bundled assets/skill, and literal public quickstarts pass without source-tree dependencies. |
| G22 | README, support matrix, CLI help, skill, and synthetic success/partial motion demos accurately describe implemented behavior. A fresh agent completes a documented custom-recipe run. |
| G23 | Exact candidate/archive/spec hashes, full-history/package secret scan, dependency advisory triage, license notices, and public artifact review are complete. Private application context and raw material are absent from the full intended public history and package. |
| G24 | Owner publishing handoff has exact commands, public-repository/license prerequisites, npm ownership/auth/provenance path, rollback/deprecation guidance, and independent post-publish install verification. Actual publication requires explicit authorization. |

G01–G24 must all have accepted evidence for ready_for_owner_publish. G24 may pass as a complete reviewed handoff without executing publication. “Published” additionally requires observed public repository/package availability and an independent install of that published version.

Do not silently skip unavailable platforms, Docker, representative web app, or motion gates. Report blockers. Final evidence binds the exact implementation commit, source archive, package tarball digest, and spec digest. Rebuild or revalidate when package inputs change. Old C2 results do not certify the new candidate.

## 12. Open-source release and agent handoff

Publish one npm package with a deliberate allowlist, MIT license, third-party notices, security/contribution guidance, support matrix, and synthetic demo. Do not publish credentials, private application context, plans/logs, source, or owner recordings. Prepare locally and review the complete public diff/archive before any visibility or registry mutation.

The agent skill must inspect the repository, choose or write an explicit recipe, choose meaningful scenarios, run doctor and plan, explain exact commands/state assumptions, use already granted execution authorization, compare, inspect actual output, and return existing artifact links with limitations. It must not invent flags, silently switch source versions, relax required steps, or claim all UI changes were covered. An MCP wrapper is not required for this workflow.

A later implementation goal must name this revision and the graph, authorize bounded local/synthetic application execution, state any container/provider permissions, assign file ownership, and use the G01–G24 predicate. “Finish” means the new contract and release evidence pass, not that the old tests still pass or time expired. Public publishing actions must be separately explicit in that goal or authorized after the concrete handoff.

## 13. Build graph and review loops

Use [the graph](docs/implementation-graph.md) as an incremental migration plan. Freeze schema examples and capability-probe outcomes before workers change shared contracts. The root integrator owns schema and runner integration. Other owners work in isolated worktrees or disjoint files. Reconcile actual git status before starting; preserve unrelated work.

Each node follows contract example, focused behavioral check, implementation, focused verification, independent review, and integration. Use at most two focused repair attempts before diagnosing the underlying contract/architecture issue. Replan dependents after interface changes. A failed requirement is never fixed by weakening the test or marking a required action expected absent.

Milestones are a fully sanitized motion prototype by hour 2, integrated general-app motion by hour 10, representative public web-app comparison by hour 14, installed package by hour 18, and final verification/release preparation by hour 24. They are planning checkpoints, not current evidence. The graph contains owners, dependencies, deliverables, gate IDs, and explicit stop conditions.

## 14. Design evidence and explicit deferrals

The [design record](docs/audit/spec-revision-0.3-design.md) explains the selected architecture and rejected alternatives. The local synthetic PNG probe is feasibility evidence only. It does not certify a smooth, continuously masked, cross-platform implementation.

Deferred capabilities include automatic arbitrary-stack discovery, per-framework route adapters beyond existing Next support, arbitrary Compose files, cross-origin login journeys, sessionStorage injection, dynamic selector-following motion masks, remote preview comparisons, filesystem symlink/submodule/LFS support, caches, import graphs, audio, GIF/WebM export, 60 FPS guarantees, browser performance measurement, and automatic publishing.

Primary technical references:
- [Playwright screencast API](https://playwright.dev/docs/api/class-screencast).
- [Chromium screencast protocol](https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-startScreencast).
- [Playwright authentication state](https://playwright.dev/docs/auth).
- [Docker container lifecycle](https://docs.docker.com/reference/cli/docker/container/run/), [container builder state](https://docs.docker.com/build/builders/drivers/docker-container/), and [builder removal](https://docs.docker.com/reference/cli/docker/buildx/rm/).
- [pnpm workspace semantics](https://pnpm.io/workspaces).

Installed API/source inspection and runtime probes take precedence over assumptions from newer documentation. An API declaration is not evidence of sustained capture quality.
