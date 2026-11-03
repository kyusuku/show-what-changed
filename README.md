# show-what-changed

Compare a browser scenario across two Git snapshots and produce a labeled BEFORE | AFTER video.

Revision 0.3 uses explicit execution recipes for web applications across stacks. Motion is the default. It records actual intermediate Chromium frames and preserves their shared elapsed timing. Keyframes remain an explicit alternative.

Version `0.1.0` is an unpublished experimental candidate. Implementation and acceptance are still in progress. The final installed-package, platform, motion repetition, and representative application gates are not complete. See [release readiness](docs/release-readiness.md) for the current candidate and gate status.

[Development motion clip](fixtures/motion/r4-worker-development-compare.mp4) · [Its synthetic observations](fixtures/motion/r4-worker-development-result.json)

This controlled synthetic clip completed capture, masking, composition, encoding, and decoded movement checks with the current worker implementation. It is a source-build development run, not final-candidate proof. The [older pricing example](docs/demo/success/compare.mp4) and [incomplete example](docs/demo/partial/compare.mp4) are explicitly labeled keyframe recordings.

## Prerequisites

| Requirement | Scope |
| --- | --- |
| Node.js | Tool runtime `24.x`. Candidate checks use `24.22.2`. |
| npm | Installs this CLI. Candidate checks use `11.12.1`. Applications may use other tools. |
| Playwright and Chromium | Package dependency `1.64.1`, with Chromium revision `1248` installed separately. |
| FFmpeg and ffprobe | Matching system versions with H.264 `libx264` and the composition filters checked by `doctor`. Development macOS checks use `9.0.2`. |
| Git, `ps`, and `lsof` | Source and listener ownership checks. Linux needs `lsof` `4.99.7` or newer. macOS uses its system `lsof`. |
| Application tools | Declared by the recipe, such as Python, npm, or pnpm. The tool's Node version does not select the application's runtime. |
| Docker Engine and buildx | Required for container recipes. Host-process recipes do not require Docker. |

The CLI checks capabilities. It does not install browsers, system runtimes, FFmpeg, or Docker automatically. A successful `doctor` checks tool prerequisites; it does not certify that an application recipe works.

### Linux setup

Older `lsof` versions can omit listeners when Linux truncates a process name. Linux checks reject versions below `4.99.7` or an unidentifiable version. See the [upstream issue](https://github.com/lsof-org/lsof/issues/359).

From this repository's checkout, Ubuntu users can build the pinned version into a private installation directory.

```sh
sudo apt-get update
sudo apt-get install -y build-essential pkg-config libtirpc-dev libselinux1-dev curl ca-certificates ffmpeg git procps
sh scripts/linux-gate/install-lsof.sh "$HOME/.local"
export PATH="$HOME/.local/bin:$PATH"
lsof -v
```

The installer verifies its source hash and does not edit shell configuration.

## Install a reviewed local candidate

Get the tarball and its SHA-256 from [release readiness](docs/release-readiness.md). Verify that identity before installing outside the application checkout.

```sh
shasum -a 256 /absolute/path/show-what-changed-0.1.0.tgz
SWC_INSTALL="$(mktemp -d)"
npm install --prefix "$SWC_INSTALL" --no-audit --no-fund /absolute/path/show-what-changed-0.1.0.tgz
SWC="$SWC_INSTALL/node_modules/.bin/show-what-changed"
node "$SWC_INSTALL/node_modules/playwright/cli.js" install chromium
"$SWC" doctor --json
```

On Linux, use `sha256sum` if needed. Playwright's `install --with-deps chromium` variant also installs system libraries and can require administrator access. Use the installed pinned Playwright dependency rather than an unqualified latest installer.

No registry installation or npm publication is claimed while this candidate is unpublished.

## Describe how your app runs

Every app needs a schema 2 recipe. There is no root-manifest or package-manager whitelist. This example serves a Git repository's `public` directory using an already installed Python 3.

Save it as `show-what-changed.config.json` at the application Git root.

```json
{
	"schemaVersion": 2,
	"execution": {
		"start": {
			"kind": "process",
			"argv": ["python3", "-m", "http.server", "{port}", "--bind", "127.0.0.1", "--directory", "public"]
		},
		"state": {"kind": "stateless"}
	}
}
```

Capture defaults to motion at `1280×800`. Adapt the recipe's setup, working directory, foreground start command, readiness route, environment references, and state declaration to your app. Tokens occupy complete command arguments. Use explicit `fromEnv` bindings for secrets; do not place secret values in command arguments or config literals.

Recipes can describe static sites, Python apps, npm apps, pnpm workspaces, and restricted container apps. These are supported configuration paths, not a claim that every application or final platform gate has passed. Read the [recipe contract](spec.md#4-general-execution-recipe) and [current limitations](docs/limitations.md).

## Plan before execution

From the application's Git root, select a route that exists in the intended snapshots.

```sh
cd /absolute/path/to/your/app
"$SWC" plan --route / --json
```

BEFORE defaults to exact `HEAD`. AFTER defaults to the eligible current filesystem snapshot, including staged, unstaged, and nonignored untracked files. The tool creates isolated source copies. It does not modify `.gitignore`; exclude `.show-what-changed/` before committing output.

Read the private `.show-what-changed/plan.json`. Review source IDs, source limits, selected scenarios, coverage gaps, recipe commands, declared environment names, inputs, services, and state. Planning does not execute app code.

After authorizing those commands, run the saved plan.

```sh
"$SWC" compare --plan .show-what-changed/plan.json --allow-exec --json
```

This executes both snapshots' recipe with your account's privileges. Source copies protect the checkout from the tool's normal writes; they are not a security sandbox. `--ci` disables prompts and never grants execution permission.

Use [the quickstart](docs/quickstart.md) for a complete synthetic pricing lesson, exact interaction scenarios, mask modes, and offline recomposition.

## Capture and output limits

Motion uses change-driven browser sampling. Shutdown finishes frames already delivered to the recorder before closing their acknowledgement channel. Frames still queued in the browser or protocol at the subscription cutoff may be omitted, so the source dropped-frame count remains unknown. The tool does not claim to capture every browser frame.

| Area | Current contract |
| --- | --- |
| Platforms | Node 24 on Linux and macOS. Final revision 0.3 platform acceptance is pending. |
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
| `doctor` | Check capabilities and report abandoned runs without running app code. |
| `clean <runId>` | Remove one registered inactive run and verified owned residue. |

Use `--help` for flags and `--json` for one versioned result on stdout. Diagnostics use stderr. Read the result's status and exit code before following its artifact paths. Exit `3` is partial and may contain useful media. An MP4 alone is not proof of success.

Review `compare.mp4`, `poster.png`, `manifest.json`, `capture.json`, `timeline.json`, and `pr.md` under `.show-what-changed/runs/<runId>/`. Recomposition preserves earlier capture, source, coverage, and cleanup faults. It cannot repair missing or poor source capture.

## Trust and sharing

The CLI has no telemetry and uploads nothing. Application commands and browser subresources can use the network. Stateful apps need declared isolation or explicit external read-only state; declarations are not proof of database equality. The manifest distinguishes `stateless-declared`, `isolated-declared`, and `external-unverified` data parity.

Use synthetic or disposable data. Keep plans, environment and auth files, helper inputs, and logs private. Attach only individually reviewed artifacts, with explicit authorization for the destination. Never attach a whole run directory. Read [the security policy](SECURITY.md).

The [agent skill](skills/show-what-changed/SKILL.md) uses the same CLI and JSON contract. No editor-specific plugin or MCP server is required.

## Development and license

Read [contributing](CONTRIBUTING.md) for development, [the specification](spec.md) for acceptance, and [publishing](docs/publishing.md) for the owner's later handoff. Authored code uses the [MIT license](LICENSE). The bundled Inter font uses the SIL Open Font License. Dependencies retain their licenses in [third-party notices](THIRD_PARTY_NOTICES.md).
