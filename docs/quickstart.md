# Compare a synthetic pricing change

This guide creates a disposable Git app and a local BEFORE | AFTER video. The pricing lesson explicitly uses keyframes so its checkpoints remain repeatable. Motion is the default for recipes that omit capture mode.

This tutorial targets experimental version `0.1.1`. Use synthetic or disposable data when adapting it.

## Install the package

Use Node `24.x`. Release checks use Node `24.22.2` and npm `11.12.1`. Check [release readiness](release-readiness.md) for the archive identity and publication status. Before `0.1.1` is published, replace the package name below with the path to its reviewed tarball.

```sh
SWC_INSTALL="$(mktemp -d)"
npm install --prefix "$SWC_INSTALL" --no-audit --no-fund show-what-changed@0.1.1
SWC="$SWC_INSTALL/node_modules/.bin/show-what-changed"
node "$SWC_INSTALL/node_modules/playwright/cli.js" install chromium
"$SWC" doctor --json
```

The Playwright `install --with-deps chromium` variant also installs system libraries. Follow [the prerequisites](../README.md#prerequisites), including matching FFmpeg and ffprobe, Git, `ps`, and a supported `lsof`.

Continue when `doctor` reports `status: "ok"` and `exitCode: 0`. This checks tool capabilities, including the composition filters. Application-specific prerequisites are checked from the selected recipe after consent.

## Create the disposable application

From a checkout of this tool repository, create the synthetic pricing app and copy its scenario.

```sh
SWC_FIXTURE="$(mktemp -d)"
node scripts/create-fixture.mjs --dir "$SWC_FIXTURE"
cp test/fixtures/scenarios/pricing.scenario.json "$SWC_FIXTURE/pricing.scenario.json"
cd "$SWC_FIXTURE"
```

The helper creates the `fixture-base` and `fixture-head` Git refs. BEFORE has monthly pricing. AFTER adds a Yearly switch. It uses an explicit npm setup and foreground start recipe. The app's configuration selects `capture.mode: "keyframes"`, selector masking, and `observeMs: 800`.

The helper does not install or start the app. Those commands run only after execution consent.

## Read the seven-step scenario

The copied `pricing.scenario.json` contains this schema 2 scenario.

```json
{
	"schemaVersion": 2,
	"id": "pricing-toggle",
	"title": "Switch yearly pricing",
	"steps": [
		{"id": "open", "op": "goto", "path": "/pricing"},
		{"id": "ready", "op": "expectVisible", "target": {"role": "heading", "name": "Pricing"}},
		{"id": "toggle", "op": "click", "target": {"role": "switch", "name": "Yearly"}, "allowMissing": ["before"]},
		{"id": "saving", "op": "expectVisible", "target": {"text": "Save 20%"}, "only": "after"},
		{"id": "hover", "op": "hover", "target": {"role": "button", "name": "Get Pro"}},
		{"id": "hover-retained", "op": "expectVisible", "target": {"testId": "hover-state"}},
		{"id": "poster", "op": "screenshot", "note": "Hover on the plan button"}
	]
}
```

The switch is deliberately absent in BEFORE. `allowMissing` permits only zero matches. It does not excuse hidden, disabled, ambiguous, or broken controls. The saving assertion explicitly excludes BEFORE. Those two outcomes are labeled and unverified.

## Review the bound plan

```sh
"$SWC" plan --base fixture-base --head fixture-head --scenario pricing.scenario.json --json
```

Inspect the private `.show-what-changed/plan.json`. Confirm both resolved commit IDs, the seven steps, the keyframe mode, the recipe commands, generated directories, and state declaration. Confirm that the output directory is ignored before committing any tool output.

Planning executes no application code. A saved plan binds exact input bytes and source identities. Do not edit it. If inputs change, regenerate and review the plan.

## Authorize this comparison

The next command permits both snapshots' recipe commands to run with your account's privileges.

```sh
"$SWC" compare --plan .show-what-changed/plan.json --allow-exec --json
```

Without `--allow-exec`, an interactive terminal can ask for consent. A noninteractive command returns exit `7` until execution is authorized. `--ci` and `CI=true` disable prompts and do not grant consent.

A successful lesson reports five verified checkpoint pairs, one expected absence, and one exclusion. Confirm the actual manifest. An MP4's existence alone does not prove success.

## Inspect the artifacts

Use the returned run ID to find `.show-what-changed/runs/<runId>/`.

| Artifact | Inspect |
| --- | --- |
| `compare.mp4` | BEFORE and AFTER labels, `KEYFRAMES`, yearly pricing, retained hover, and any incomplete badges. |
| `poster.png` | The earliest checkpoint with the highest valid masked difference, or an explicitly incomplete safe image. |
| `manifest.json` | Source identity, selected coverage, actual side results, provenance, and independent cleanup and encoding outcomes. |
| `capture.json` and `timeline.json` | Mask provenance, image hashes, mode, boundaries, and saved frame schedule. |
| `pr.md` | Local summary for a later manually reviewed attachment. |
| `private/` | Private plans and bounded diagnostics. Do not share this directory. |

A required failure blocks later steps on that side. Safe partial media shows that failure and exits `3`; no usable capture or an encoding failure exits `9`. Held images never prove that a blocked action ran.

## Adapt the recipe to another web app

A web app does not need npm files. Save a schema 2 execution recipe at its Git root, or use `--config` to select a private local config. This example serves a `public` directory with an already installed Python 3.

```json
{
	"schemaVersion": 2,
	"execution": {
		"start": {
			"kind": "process",
			"argv": ["python3", "-m", "http.server", "{port}", "--bind", "127.0.0.1", "--directory", "public"]
		},
		"ready": {"path": "/", "statuses": [200]},
		"state": {"kind": "stateless"}
	},
	"capture": {
		"mode": "motion",
		"viewport": {"width": 1280, "height": 800},
		"maskRects": [],
		"observeMs": 800
	}
}
```

Adapt the exact command and readiness path to your app. Use setup commands for frozen dependency installation or a build. In a workspace, set `appDir` and explicit command `cwd` where needed. Declare generated directories rather than excluding source because its directory is named `dist` or `build`. See [the recipe contract](../spec.md#4-general-execution-recipe) for pnpm, services, state, environment bindings, helpers, and restricted containers.

Select explicit `--route /path` or `--scenario scenario.json`. These flags are mutually exclusive and each may repeat up to three times. Basic Next.js route discovery is optional convenience, not a requirement for other stacks. Automatic scenarios do not infer interactions or exhaustive UI coverage.

Use exact role, label, text, test ID, or CSS locators. Add `expectVisible` for delayed UI readiness. `scrollBy` can target the window or an exact inner-container locator and uses smooth scrolling.

## Choose masks for the capture mode

Motion leaves app animations running and saves actual intermediate frames. Configure fixed viewport rectangles in `maskRects`. Each rectangle must cover sensitive content's entire travel area. Masking happens before source persistence and encoding. Fixed Date does not pause animation clocks.

Keyframes require `capture.mode: "keyframes"`. They use animation-disabled checkpoints and `maskSelectors`. Motion rejects selector masks, and keyframes reject rectangle masks. A failed motion capture does not silently switch modes. Masking is not automatic secret detection.

Use synthetic data and review all artifacts before sharing. Keep environment, auth, helpers, plans, and logs private. The CLI uploads nothing.

## Re-encode or remove one run

Replace the run ID with the exact value from the result.

```sh
SWC_RUN_ID='replace-with-runId-from-result'
"$SWC" compose ".show-what-changed/runs/$SWC_RUN_ID" --json
```

Recomposition validates the saved capture, timeline, source images, overlays, and hashes. It starts no app server, Docker resources, or browser. It preserves earlier capture, provenance, coverage, and cleanup faults.

After reviewing or copying the required artifacts, remove that inactive run.

```sh
"$SWC" clean "$SWC_RUN_ID" --json
```

The command refuses active or uncertain ownership. After a forced kill or power loss, inspect `doctor --json` before attempting recovery. Never replace ownership checks with broad process killing or directory deletion.
