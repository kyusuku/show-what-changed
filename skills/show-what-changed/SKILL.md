---
name: show-what-changed
description: Use when a user wants local visual evidence of a web application change across Git snapshots, a BEFORE and AFTER video, or recovery of a saved show-what-changed run.
---

# Show what changed

Use the installed CLI with `--json`. Version `0.1.0` is unpublished and revision 0.3 acceptance remains in progress. Read the [packaged README](../../README.md) and release evidence. Never infer publication from local artifacts.

## Inspect and plan

1. Confirm the application repository and requested snapshots. Defaults are exact `HEAD` and current `WORKTREE` bytes.
2. Run `show-what-changed doctor --json` when prerequisites are unknown. Use the package's pinned Playwright installer.
3. Read the [config schema](../../schema/config.v2.json) and [scenario schema](../../schema/scenario.v2.json). Supply an explicit schema 2 execution recipe. Applications need no npm manifest or language whitelist.
4. Run `show-what-changed plan --json` with the chosen `--config`, sources, and either routes or scenarios. Planning executes no app code. Review source IDs, commands, declared environment names, inputs, state, services, and coverage locally. Keep plans private.

Node 24 runs the tool. The recipe selects application runtimes, setup, foreground startup, HTTP readiness, and optional isolated services. Missing application environment bindings fail; never copy all parent environment or invent unsupported flags. Runtime commands are trusted code, not a sandbox.

## Author a truthful scenario

Use schema 2, at most three scenarios, and twelve unique steps each. Start with `goto`. Available operations are `goto`, `click`, `fill`, `hover`, `scrollBy`, `expectVisible`, and `screenshot`. Use exact locators, `expectVisible` for delayed readiness, and exact inner scroll targets.

Motion is default. It records actual browser frames. Use fixed `maskRects` covering sensitive content's full travel area. Explicit keyframes use `capture.mode: "keyframes"` and `maskSelectors`. Never mix masks or substitute keyframes for failed motion.

Use synthetic or disposable data. Allowed zero-match absence and deliberate `only` exclusions are unverified pairs. Never weaken required actions, broaden ambiguous locators, or remove masks to obtain success.

## Execute authorized work

Use existing authorization when it covers both planned snapshots and commands. Otherwise present the concrete plan before requesting execution consent.

```sh
show-what-changed compare --plan .show-what-changed/plan.json --allow-exec --json
```

`--ci` never grants consent. A saved plan accepts no overrides. Regenerate stale plans rather than editing them. Read `--help` for bounds and timeout options.

## Review and report

Parse the single stdout JSON result. Inspect actual artifacts, status, exit code, coverage, side results, provenance, capture quality, and cleanup. Exit `3` can retain partial media; held, absent, or excluded states never mean unchanged. Data parity declarations do not prove database equality. Output CFR 30 is not a capture-rate or performance guarantee.

Return reviewed local video and poster links, exact sources, selected coverage, and limitations. Upload or post only with explicit authorization for the reviewed files and destination. Never share plans, auth/environment files, helpers, private logs, or whole run directories.

`compose <runDir> --json` validates and re-encodes saved capture/timeline/images without app servers, Docker, or a browser. It cannot repair capture or clear earlier faults. Use `doctor` for ownership diagnostics and `clean <runId>` only for an authorized inactive run. After repeated failures, diagnose the cause instead of replaying unchanged commands.
