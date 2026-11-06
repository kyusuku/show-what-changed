# show-what-changed

Compare a browser scenario across two Git snapshots and produce a labeled BEFORE | AFTER video.

Revision 0.3 uses explicit execution recipes for web applications across stacks. Motion is the default. It records actual intermediate Chromium frames and preserves their shared elapsed timing. Keyframes remain an explicit alternative.

Version `0.1.2` adds browser setup, an app-configuration prompt for coding agents, and clock recovery for delayed browser responses. The 40 ms clock error limit remains unchanged. The tool remains experimental. See [release readiness](docs/release-readiness.md) for verification and publication status.

The [synthetic examples](docs/demo/README.md) identify each recording's capture mode and candidate. Historical development clips and keyframe examples remain labeled separately from release-candidate motion evidence.

## Install and set up

Use Node.js 24 on macOS or Linux. Install the tool once, outside your application's dependencies.

```sh
npm install -g show-what-changed
show-what-changed setup
```

`setup` downloads the matching Chromium browser and checks the tools needed to record a comparison. It reports any missing system dependencies with instructions. Continue when it prints `setup: ok (exit 0)`.

For missing prerequisites, restricted networks, or an installation without global npm access, see [installation help](docs/installation.md). To check an existing installation without downloading anything, run `show-what-changed doctor`.

## Configure your app once

Paste this prompt into your coding agent while it has access to the app repository. The agent adapts the configuration to your app. The prompt authorizes a first local comparison using test data.

```text
Set up show-what-changed for this repository and produce a first local comparison.

Inspect the repository before choosing commands. Identify its web app, package manager, workspace layout, start command, readiness route, required environment variables, and test-data needs. Use the installed CLI's --help, README, and schemas for its exact supported behavior.

Create a minimal show-what-changed.config.json that matches this app. Keep existing valid configuration. Use a frozen dependency install when a lockfile exists, bind the server to 127.0.0.1 with the assigned {port}, and choose one meaningful page or short scenario. Configure state honestly. Use stateless only when appropriate; otherwise use isolated, disposable test data. Reference secrets through fromEnv instead of writing their values into files. Keep .show-what-changed/ out of Git.

Run doctor and create a plan for HEAD versus the current working tree. Inspect the plan before execution. You may run the planned setup and app commands in isolated source copies for this local comparison. Do not use production services, enable paid integrations, change application code to force success, or modify the checkout's dependencies or lockfile. Do not commit, push, or publish.

If required test credentials, services, or choices cannot be discovered safely, finish the independent setup and ask me only for those missing items. Otherwise run the comparison, inspect its result and video, and return the exact video path, a short explanation of the configuration, and any limitations. Do not claim success from the presence of an MP4 alone.
```

For manual configuration, use the [pnpm and Next.js example or static-site recipe](docs/app-setup.md). See the [recipe contract](spec.md#4-general-execution-recipe) for other stacks and [current limitations](docs/limitations.md) for supported behavior.

## Plan before execution

From the application's Git root, select a route that exists in the intended snapshots.

```sh
cd /absolute/path/to/your/app
show-what-changed plan --route / --json
```

BEFORE defaults to exact `HEAD`. AFTER defaults to the eligible current filesystem snapshot, including staged, unstaged, and nonignored untracked files. The tool creates isolated source copies. It does not modify `.gitignore`; exclude `.show-what-changed/` before committing output.

Read the private `.show-what-changed/plan.json`. Review source IDs, source limits, selected scenarios, coverage gaps, recipe commands, declared environment names, inputs, services, and state. Planning does not execute app code.

After authorizing those commands, run the saved plan.

```sh
show-what-changed compare --plan .show-what-changed/plan.json --allow-exec --json
```

This executes both snapshots' recipe with your account's privileges. Source copies protect the checkout from the tool's normal writes; they are not a security sandbox. `--ci` disables prompts and never grants execution permission.

Use [the quickstart](docs/quickstart.md) for a complete synthetic pricing lesson, exact interaction scenarios, mask modes, and offline recomposition.

## Capture and output limits

Motion uses change-driven browser sampling. Shutdown finishes frames already delivered to the recorder before closing their acknowledgement channel. Frames still queued in the browser or protocol at the subscription cutoff may be omitted, so the source dropped-frame count remains unknown. The tool does not claim to capture every browser frame.

| Area | Current contract |
| --- | --- |
| Platforms | Node 24 on Linux and macOS. See the accepted platform evidence in [release readiness](docs/release-readiness.md). |
| Sources | One Git repository and one selected app per run. Explicit recipes cover multiple stacks. Basic Next.js App Router route discovery is a convenience. |
| Browser | Chromium, one viewport per run, device scale factor `1`. Width `320–1920`, height `240–1200`, at most `2,073,600` source pixels. |
| Scenarios | At most three scenarios, twelve steps each, and sixty seconds of source capture per scenario. |
| Actions | Navigate, click, fill, hover, smooth window or inner-container scroll, visibility assertion, and checkpoint. |
| Motion | Actual PNG frames, fixed source-clock mappings, all-frame rectangle masks, and latest-source selection at output ticks. No image interpolation or independent side retiming. |
| Keyframes | Explicit `capture.mode: "keyframes"`, animation-disabled checkpoints, and selector masks. There is no silent fallback from motion. |
| Media | `1920×686` H.264 MP4 at output CFR 30, a PNG poster, sanitized source frames, overlays, schema 2 metadata, and local PR text. Output FPS does not promise thirty newly captured images per second. |
| Storage | At most `12,000` source and checkpoint PNGs and `10 GiB` per run. Resource or capture faults are explicit. |

A required action failure blocks later actions on that side. Available safe media shows failure or held-state labels. Expected absence and side exclusion are unverified pairs. Neither means unchanged. Explicit selection proves only its selected scenarios.

Motion accepts fixed viewport rectangle masks. Keyframes accept CSS selector masks. These settings cannot be mixed. Rectangles must cover the entire travel area of sensitive content. Masks are opt-in and do not detect personal information. Inspect every artifact before sharing.

## Commands and artifacts

| Command | Purpose |
| --- | --- |
| `plan` | Inspect source and bind a private plan without running app code. |
| `compare` | Obtain execution consent, prepare isolated snapshots, run the recipe, capture, and compose. This is the default command. |
| `compose <runDir>` | Validate saved capture, timeline, images, and hashes, then re-encode without app servers, Docker, or a browser. |
| `setup` | Install the matching Chromium browser and check tool prerequisites. |
| `doctor` | Check capabilities and report abandoned runs without running app code. |
| `clean <runId>` | Remove one registered inactive run and verified owned residue. |

Use `--help` for flags and `--json` for one versioned result on stdout. Diagnostics use stderr. Read the result's status and exit code before following its artifact paths. Exit `3` is partial and may contain useful media. An MP4 alone is not proof of success.

Review `compare.mp4`, `poster.png`, `manifest.json`, `capture.json`, `timeline.json`, and `pr.md` under `.show-what-changed/runs/<runId>/`. Recomposition preserves earlier capture, source, coverage, and cleanup faults. It cannot repair missing or poor source capture.

## Trust and sharing

The CLI has no telemetry and uploads nothing. Application commands and browser subresources can use the network. Stateful apps need declared isolation or explicit external read-only state; declarations are not proof of database equality. The manifest distinguishes `stateless-declared`, `isolated-declared`, and `external-unverified` data parity.

Use synthetic or disposable data. Keep plans, environment and auth files, helper inputs, and logs private. Attach only individually reviewed artifacts, with explicit authorization for the destination. Never attach a whole run directory. Read [the security policy](SECURITY.md).

The [agent skill](skills/show-what-changed/SKILL.md) uses the same CLI and JSON contract. No editor-specific plugin or MCP server is required.

## Development and license

Read [contributing](CONTRIBUTING.md) for development, [the specification](spec.md) for acceptance, and [publishing](docs/publishing.md) for the release procedure. Authored code uses the [MIT license](LICENSE). The bundled Inter font uses the SIL Open Font License. Dependencies retain their licenses in [third-party notices](THIRD_PARTY_NOTICES.md).
