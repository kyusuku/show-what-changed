# Independent ownership and terminal-result review

The goal is a 0.1.0 release candidate that preserves truthful terminal outcomes while serializing runs and cleanup. This bounded review covers the ownership and finalization implementation, including failure and cancellation interleavings. It does not establish full release readiness. Throughput checkpoint: n/a, read-only investigation. Product implementation remained read-only. The baseline was the uncommitted tree over commit `b792378c5150faf147dd7f3396d2bec28142ab06`.

## Findings

### Failed cancellation rewrite leaves a successful persisted result

A disposable real `compose --json` process received SIGTERM after its first terminal public write completed. A loader then injected an error before the cancellation rewrite. The process returned exit 143 and a `cancelled` manifest in JSON. The saved `manifest.json` and `pr.md` still said `ok` and exit 0. The saved and returned manifests differed. The runner swallowed the rewrite error in `src/runner/index.ts:84` and released ownership. This is a proven combined cancellation and output-failure case. It does not show ordinary cancellation failing.

The probe copied an existing successful run into a disposable Git repository. The loader sent an actual OS signal and introduced an output failure at the second public write. It did not modify product files. Raw result: `/private/tmp/swc-n6-final-write-m7SzRC/probe.json`. Reproduction: `PATH=/private/tmp/swc-toolchain/node_modules/.bin:$PATH node /private/tmp/swc-n6-final-write-probe.mjs`. The fixture and loader are local temporary evidence, not package tests. The process and FFmpeg access required the authorized unsandboxed execution environment.

The initial sandboxed attempt returned an environment capability failure before the target interleaving. The recorded result above is the subsequent unsandboxed run.

### Signal during ownership release is ignored after the decision freezes

A second real `compose --json` process paused inside `releaseRepositoryLock` before it changed the lock. SIGTERM arrived while the process was alive, held the lock, and had not returned JSON. The process resumed and returned exit 0 and `ok`. The saved manifest also said `ok`. The loader controlled scheduling but did not inject an output or lock failure.

This behavior follows the current decision freeze immediately after the first terminal write. The wording in `spec.md:416` says cancellation takes precedence if it arrives before the terminal result. If the returned CLI result is that boundary, the behavior violates the contract. If the previously committed manifest is that boundary, the behavior follows the implementation's chosen interpretation. The specification does not explicitly resolve that distinction. Raw result: `/private/tmp/swc-n6-release-signal-YhgIIQ/probe.json`. Reproduction: `PATH=/private/tmp/swc-toolchain/node_modules/.bin:$PATH node /private/tmp/swc-n6-release-signal-probe.mjs`.

## Scope and verification

The lock protocol uses an exclusive directory for both run and clean. Resource cleanup retains the lock for terminal writes. Release checks the lock identity and owner nonce, marks the run inactive, and removes the lock. Release reports `released`, `retained`, or `uncertain`. The runner repairs metadata only after a retained failure and does not write after an uncertain release. Repeated release returns the cached outcome.

The focused runtime suite passed independently with 15 tests and zero failures. Command: `PATH=/private/tmp/swc-toolchain/node_modules/.bin:$PATH npx vitest run test/unit/runtime-finalization.test.ts --reporter=dot`. The suite covers normal retained cleanup, contention with clean and compose, stale-lock cleaner serialization, initializer failure, partial removal, and uncertain ownership. The focused suite is not a substitute for final integrated or installed-package gates.

The Prove It Works principle led to direct CLI probes that read the returned JSON and persisted files. Poteto-mode, unslop, and technical-writing shaped the report. The `how` skill's delegated workflow was not used because this reviewer was explicitly assigned a bounded independent review without nested delegation.

## Baseline hashes

| File | SHA-256 |
| --- | --- |
| `src/runtime/context.ts` | `426daec4787c6e11225b108b720c04d1dc075275edee8abb03f0eb9591e5047f` |
| `src/runtime/ownership.ts` | `98466ca377acffe8a28aaa3c234f15e085db5cfee90cc2e7767c1905e085105a` |
| `src/runtime/files.ts` | `2877ec4004acad91c9d449d675c03eca6953a449efd630d7d3630a5c432db4b1` |
| `src/runner/index.ts` | `1bc983212c0229787a713dc4b216a9cee37b65875f454c4cfc2b6d34dccd314f` |
| `dist/runtime/ownership.js` | `cceeadbaed0957a6d31aa33f3951ff4f9fd52212668edc20e331049650f31250` |
| `dist/runner/index.js` | `e74abed63267029c87c6c19e172d324b0b43b15d6a14008de8b58e63af368526` |
| `dist/runner/artifacts.js` | `86e46c2aae29036b0b99a8f772a3252c98c86051bc59db792c42565b409840b7` |
