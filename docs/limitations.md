# Limitations and result codes

Revision 0.3 implements schema 2 recipes, motion capture, and explicit keyframes. Version `0.1.1` remains experimental. [Release readiness](release-readiness.md) records verification and publication status. This page describes the supported behavior and limits.

## Capture and interpretation

Motion is the default. It records actual intermediate Chromium frames, keeps animations running, and selects the latest available source frame on a common elapsed timeline. The 30-FPS MP4 does not imply 30 newly captured frames per second. Repeated frames can reflect unchanged content, capture gaps, or explicitly held failure states. The tool does not measure application performance, interpolate motion, or retime each side independently.

Stopping capture does not flush frames still queued in Chromium or Playwright. A trailing frame can be absent even if the browser presented it before recording stopped. Frame counters cover only frames delivered to the recorder, and `sourceDroppedFrames` remains `null` because unobserved losses are unknown. A successful capture does not guarantee that every browser frame or the final page state appears in the video.

Keyframes require `capture.mode: "keyframes"`. They use animation-disabled checkpoints held for each step's observation interval. Keyframe output cannot establish animation or smooth-scroll behavior. A motion failure never switches modes automatically.

The browser uses device scale factor `1`, locale `en-US`, timezone UTC, and light color scheme. The default viewport is `1280×800`. Configured dimensions may be 320–1920 wide and 240–1200 high, with at most 2,073,600 pixels. Both sides use one identical viewport. Output is fixed at `1920×686`; narrow or small sources are letterboxed without upscaling. Physical device emulation, multiple simultaneous viewports, audio, GIF, and WebM are unavailable. A run contains at most three scenarios, twelve steps per scenario, and 60 seconds per scenario.

Optional `fixedTime` fixes browser Date while animation clocks and timers continue. Server time, randomness, remote assets, and backend state can still differ. State and data parity are declarations recorded separately from source identity. Fresh browser contexts do not prove equivalent backend data.

Motion requires a valid fixed source-clock mapping with a combined error bound at most 40 ms. Clock, metadata, decoding, masking, queue, and storage faults fail the affected side. Safe partial media is possible; a neutral-only capture is unusable. Source storage is bounded to 12,000 PNGs and 10 GiB per run. Host load and disk behavior can affect capture. The controlled synthetic motion thresholds are acceptance criteria, not cadence guarantees for every app.

`changeRatio` measures differing pixels only for two successful captures. It is not a semantic correctness score. Noise can count as change. Expected absence, side exclusion, failed steps, and blocked steps have no verified pixel ratio.

Presentation labels use printable ASCII. Unsupported label characters become `?` with a warning. Application screenshot pixels and Unicode names in JSON are retained.

## Application and source layout

The tool runs on Node 24 on Linux and macOS. Other Node majors and Windows are unsupported. The application's runtime is selected by its explicit execution recipe. Static sites, Python apps, npm apps, and pnpm workspaces do not need the same source layout or package manager. Missing prerequisites fail before setup; the tool does not install arbitrary system runtimes automatically.

Linux must provide a working Chromium sandbox. Hosts with restricted user namespaces may need the scoped AppArmor profile described in Option 2 of [Chromium's host setup guidance](https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md). The CLI does not fall back to an unsandboxed browser.

The following source layouts fail validation before execution.

- Sparse checkouts, unmerged indexes, submodules, LFS pointers, symlinks, and nonregular source files.
- Configured Git filter drivers or `filter=` attributes, invalid UTF-8 paths, and file-to-directory transitions between the commit and WORKTREE snapshot.
- Files larger than 512 MiB or inventories above the configured source limits. Defaults are 100,000 files and 1 GiB per side; maximums are 200,000 files and 2 GiB.
- A `source.generatedDirs` declaration that covers tracked files or eligible existing input files.

The entire eligible repository is snapshotted, including workspace packages and multiple lockfiles. A tracked directory is not discarded merely because it is named `dist` or `build`. Generated dependency symlinks inside owned ignored dependency trees are allowed.

WORKTREE means final filesystem contents, not staged patch contents. Eligible untracked files are included. Ignored untracked files are excluded. The tool does not discover or copy private environment files, reuse the caller's dependency tree, fetch refs, stash work, or change the caller's branch. Tracked environment files remain source and can contain secrets; source preservation is not secret detection.

Concurrent source edits can invalidate a plan or snapshot. Detection is best effort, not an atomic filesystem snapshot. Installs or servers that mutate eligible source files invalidate provenance.

Source hashes describe supplied bytes. They do not establish equivalent external APIs, databases, generated host build artifacts, or system libraries. Host build artifacts remain explicitly unverified. Container output records its built image identity.

## Execution recipes

Every application requires a schema 2 `execution` recipe. Commands are argument arrays run without an implicit shell. Declare foreground startup, HTTP readiness, setup/bootstrap, environment bindings, state, and any services. The old `dev.argv` configuration and schema 1 documents are rejected; historical artifacts require their historical binary.

Host-process recipes support up to four ordered process or container services. App-container recipes use a bounded Docker Engine/buildx adapter. Docker Compose, external servers, daemonized process commands, privileged containers, host networking, Docker socket mounts, arbitrary host binds, and persistent app volumes are outside the contract. A container cannot depend on a host-process service. Container recipes require Docker and buildx; host-only recipes do not.

Each app-container build first exports one complete Docker image archive into a private directory outside the source snapshots. This needs temporary disk space for the full exported image in addition to BuildKit storage and the loaded Engine image. The archive is removed after its producer, loader, and owned builder have stopped. Disk-full or incomplete-export failures stop before image loading. An interrupted image load can still leave uncertain Engine state, so the run and lock remain retained until exact ownership can be reconciled. There is no fixed image-size cap; the existing build and run deadlines still apply.

Archive cleanup shares the active run cleanup deadline and never extends an earlier archive disposal deadline. A timeout retains run ownership and a failed cleanup outcome. Late producer or builder settlement does not restart archive deletion or turn failed cleanup into success. An archive removal already issued after inactivity and identity checks may still finish after the bounded wait expires. Explicit owned-run recovery must establish current inactivity, resource ownership, and remaining files.

Archive paths live under the tool-owned private directory with mode 0700. Creation rejects pre-existing paths, unexpected initial contents, symlinks, and detectable identity changes. These checks assume trusted setup code and a trusted Buildx exporter. They do not provide a sandbox against hostile code running as the same user. An empty mode-0700 replacement between mkdir and the first identity capture can be indistinguishable from the created directory. Pathname replacement between the last identity check and deletion or a Docker CLI open also remains possible for such an actor. A directory handle would still have the mkdir-to-open window, and Node does not expose portable descriptor-relative recursive removal. The checks do not establish absolute atomic creation identity.

Use explicit `fromEnv` names for secrets. Missing bindings fail; the parent environment and ignored `.env` files are not copied wholesale. Nonsecret helper inputs are explicitly declared, hash-bound, and copied separately to each side. Setup, bootstrap, and prerequisite probes execute only after consent. An environment allowlist, worktree, or container is not a hostile-code sandbox.

## Route selection

Basic detection supports Next.js App Router `app/` or `src/app/`. Both roots together are rejected. Route groups are supported. Dynamic routes need explicit concrete samples. Parallel slots and intercepting routes are unsupported.

Shared components, styles, global configuration, and unknown imports can leave automatic coverage unresolved. Automatic selection caps routes at three and reports omissions. It does not infer an import graph or claim complete application coverage.

Explicit routes or scenarios define bounded coverage. They can succeed even though `coverage.complete` is false. Automatic coverage gaps produce a partial result when there is a captured scenario. With no resolvable scenario, they produce an input error.

Automatic scenarios navigate and scroll down twice. Added or removed routes need deliberate side-specific scenarios. A 404 is a required navigation failure, not an expected absent control.

Apps outside basic Next.js discovery need explicit routes or scenarios. The foreground start command must honor the exact allocated port and bind only to loopback. HTTP readiness proves an owned server responds; use explicit `expectVisible` steps for required UI state. External or reused development servers are unsupported.

## Interaction and data boundaries

Locators use exact roles, names, labels, text, test IDs, or CSS. Multiple matches fail. No fuzzy fallback, XPath, arbitrary JavaScript, or interactive recording is available.

`allowMissing` permits only zero locator matches on a declared side. It does not excuse hidden, disabled, ambiguous, or failing controls. `only` excludes a side explicitly. Neither result counts as a verified pair.

Main-frame navigation must stay on the allocated app origin. Popups, downloads, file choosers, and dialogs fail the affected side. Subresources and servers can still access the network.

Declare state as `stateless`, seeded `isolated`, or `external-read-only`. Separate state directories and owned services support local initialization through setup/bootstrap. A declaration and identical seed bytes do not prove semantic data equality. Browser contexts reset between scenarios; backend services and data persist for the whole run.

Optional `execution.auth.storageState` reads a bounded Playwright state file from each side's private state directory after bootstrap. Each browser receives an independent copy valid only for that side's exact origin and host cookies. Session-storage injection, interactive third-party login, HAR replay, and shared writable external backends are unavailable. Authentication has synthetic local evidence, not automatic compatibility with every provider. A click can change a backend; use disposable data or a deliberately read-only scenario.

## Files and privacy

Masking is opt-in. Motion uses fixed viewport `maskRects`, filled opaque `#101010` before source persistence and encoding. Rectangles must cover sensitive content's full travel area; they do not follow elements. Keyframes use `maskSelectors`; a missing selector matches nothing. The modes reject each other's mask configuration. Neither method detects personal information. Review all images and metadata before sharing.

Plans and `private/` can contain local paths, fill inputs, helper inputs, auth state, environment material, and resource ledgers. Logs may contain sensitive application output despite bounded logging and redaction. Public-oriented artifacts are prepared for review, not certified safe to publish.

The tool does not upload artifacts or send telemetry. Install scripts and application code run with the user's privileges. An allowlisted environment does not prevent them from reading files or credentials through `HOME`. See [security](../SECURITY.md).

Normal cleanup stops owned processes and removes temporary workspaces while retaining artifacts. Forced kills and power loss can leave residue. `doctor` reports suspected abandoned runs without killing processes. `clean` refuses deletion when ownership or activity is uncertain.

## Result and exit codes

With `--json`, each command writes one versioned result document to stdout. Diagnostics use stderr. A missing artifact is `null` in the manifest. Early failures can return `data: null`.

| Exit | Status | Meaning |
| --- | --- | --- |
| `0` | `ok` | Selected work succeeded within its recorded coverage |
| `1` | `failed` | Unexpected internal error |
| `2` | `failed` | Invalid input, ref, stale plan, unresolved route, or unsupported repository |
| `3` | `partial` | Usable media with a required step failure, automatic coverage gap, invalid provenance, or cleanup failure |
| `4` | `nothing` | No source changes or only proven non-UI changes without explicit selection |
| `5` | `failed` | Workspace preparation, setup, or bootstrap failed |
| `6` | `failed` | A server failed to start, become ready, or remain alive before capture |
| `7` | `failed` | Execution consent is missing |
| `8` | `failed` | A required tool or application capability is unavailable |
| `9` | `failed` | No usable capture, rendering, encoding, or output validation failed |
| `10` | `cancelled` | Overall deadline expired |
| `130` | `cancelled` | Interrupted with SIGINT |
| `143` | `cancelled` | Terminated with SIGTERM |

Fatal errors take precedence over partial outcomes. Cancellation takes precedence if it arrives before the terminal result. A successful `compose` can repair encoding failure but cannot turn failed capture or incomplete coverage into success.
