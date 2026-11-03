# N2 and N3 independent review

The goal is a trustworthy v0.1 comparison for developers reviewing UI edits. This review checks whether recorder and composer artifacts describe what ran, preserve masking, and remain usable after failures. It reviews the completed uncommitted implementation over `b792378c5150faf147dd7f3396d2bec28142ab06`.

The reviewer changed no product or test code. This report is the only repository file written by the reviewer. Reproduction scripts and their runs live in disposable `/private/tmp/swc-n23-*` paths. The root owner owns accepted fixes and their regression tests.

Throughput checkpoint. Read-only contract review, native comments and suppression scan, targeted real-browser probes, focused existing tests, and a bounded final report.

The Prove It Works principle changed the review from trusting owner reports to running concrete browser, cancellation, image-decoding, and saved-media checks. The poteto and unslop instructions shaped the report. No nested agents ran. Comment Sicko is unavailable, so the requested native comments and suppression scan replaced that tool before correctness review.

## Verdict

Six reproducible findings remain open against the hashes below. Two allow false successful behavior. The root accepted all six findings and owns their fixes. This is a review of the recorded source snapshot, not verification of later fixes or a full release-gate pass.

| ID | Priority | Finding | Source at reviewed snapshot |
|---|---|---|---|
| R1 | P1 | Hidden role targets become allowed absence and leave the scenario successful | `src/recorder/actions.ts:6` |
| R2 | P2 | Blocked badges name the safe-frame step instead of the failure | `src/composer/presentation.ts:28` |
| R3 | P2 | PNG decode limits can be bypassed before invalid input is rejected | `src/composer/images.ts:12-14` |
| R4 | P2 | Renderer deadline cancellation races context cleanup and retains the run lock | `src/composer/index.ts:30,43,98` |
| R5 | P2 | CSS input accepts unsupported Playwright selector-engine chains | `src/recorder/actions.ts:10` |
| R6 | P1 | A side fault during its peer's work disappears from the completed step | `src/recorder/index.ts:207-217` |

## R1. Hidden role targets bypass strict allowed-absence behavior

Spec section 7 permits `allowMissing` only for zero matches. It explicitly excludes hidden existing controls. `getByRole` excludes hidden elements by default. The presence loop consequently treats an existing hidden role target as absent.

The real-browser fixture contains `<button style="display:none" aria-label="Hidden role">Hidden role</button>`. A click with `target: {role: 'button', name: 'Hidden role'}`, `allowMissing: ['before', 'after']`, and a 350 ms step timeout produces `expected_absent` on both sides. The next screenshot executes with `ok`, and the scenario outcome is `ok`.

The existing hidden-control test at `test/integration/recorder.test.ts:199-205` uses a text locator, which retains hidden elements. It does not cover this role-locator behavior.

Run the reproduction with Node 24 and ordinary execution permission for Chromium and process inspection.

```sh
PATH=/private/tmp/swc-toolchain/node_modules/.bin:$PATH node --experimental-transform-types /private/tmp/swc-n23-review-probe.mjs
```

The retained bundle is `/private/tmp/swc-n23-review-n5rhZd/.show-what-changed/runs/20261101T204041306Z-7491a4bdbaeb948c/capture.json`. Cleanup returned `ok`.

The fix should preserve hidden role matches for presence and ambiguity checks, then let actionability or visibility fail the operation. A regression should cover a hidden named role and a duplicate role whose other match is hidden.

## R2. Blocked badges conflate failure identity with image identity

The same reproduction has `open`, `disabled`, and `later` steps. `open` succeeds. Clicking the disabled button reaches `STEP_TIMEOUT`. `later` is blocked and correctly retains `heldFromStepId: 'open'` because that is the safe image being shown.

`buildPresentation` emits `Not executed after step open | UNVERIFIED PAIR`. The failed step is `disabled`. The schema's held-frame field cannot identify why execution stopped.

The fix should derive the preceding failure for each side from the ordered captured scenario. It must retain `heldFromStepId` as image provenance. A first-navigation failure should also identify that actual failed step rather than the generic word `failure`.

## R3. Image bounds are checked after unsafe decoder allocation

Spec section 9.1 requires compressed and decoded bounds before rendering or encoding. The first IHDR check does not establish the PNG decoder's effective dimensions or limit its decompression.

Two bounded probes demonstrate distinct paths.

1. `/private/tmp/swc-n23-png-probe.mjs` creates a 32,680-byte PNG with declared dimensions 1280 by 800 and interlace set to 1. Its compressed payload expands to 33,554,432 bytes. Instrumenting `zlib.inflateSync` records `options: null` and all 33,554,432 output bytes before `validatePng` returns `IMAGE_INVALID`. The pinned pngjs interlaced path calls unbounded `zlib.inflateSync` in `node_modules/pngjs/lib/parser-sync.js`.
2. `/private/tmp/swc-n23-png-duplicate-probe.mjs` creates a 16,400-byte PNG with an initial 1280 by 800 IHDR and a second 2048 by 2048 IHDR. The first check passes. Instrumenting the actual `PNG.sync.read` result records width 2048, height 2048, and 16,777,216 RGBA bytes before final `IMAGE_INVALID`. The pinned parser accepts the later IHDR as its effective dimensions.

```sh
PATH=/private/tmp/swc-toolchain/node_modules/.bin:$PATH node --experimental-transform-types /private/tmp/swc-n23-png-probe.mjs
PATH=/private/tmp/swc-toolchain/node_modules/.bin:$PATH node --experimental-transform-types /private/tmp/swc-n23-png-duplicate-probe.mjs
```

Both commands exit 0 after recording the expected validation rejection. These are allocation-boundary probes, not performance benchmarks. They measure the actual decoder output length. No out-of-memory attempt ran.

The fix needs structural validation before pngjs can interpret another header, plus a bounded decompression path. Rejecting interlaced inputs alone leaves the duplicate-IHDR path open. The tool's own screenshots and composed PNGs provide a narrow format that can be validated without adding general image-format support.

## R4. Renderer cancellation races three context closes

The abort callback, resource disposer, and `finally` block each call `context.close()` independently. The recorder already shares one close promise, but the composer does not.

`/private/tmp/swc-n23-cancel-probe.mjs` renders a valid three-scenario, twelve-step bundle under real `createRunContext` deadlines of 1000, 1200, and 1400 ms. Each run preserves `exitCode: 10` and `DEADLINE_EXCEEDED`. Each cleanup returns `failed` with `CLEANUP_FAILED` and `An owned context could not be removed.`

```sh
PATH=/private/tmp/swc-toolchain/node_modules/.bin:$PATH node --experimental-transform-types /private/tmp/swc-n23-cancel-probe.mjs
```

The first retained run is `/private/tmp/swc-n23-cancel-ZQxeeY/.show-what-changed/runs/20261101T204320346Z-355bb0621ea6c79f`. A direct `stat` confirms its `.show-what-changed/run.lock` directory remains after cleanup. This finding does not claim a surviving browser process.

One idempotent close function should serve the abort callback, registered disposal, and `finally`. The primary deadline or signal error must remain unchanged. Regression coverage should assert both the cancellation code and successful cleanup, including lock removal.

## R5. A CSS field can invoke Playwright's nth engine

Spec section 7 accepts CSS locators but excludes nth and alternate locator grammar. Prepending `css=` does not prevent Playwright from parsing `>>` as a selector-engine separator.

`/private/tmp/swc-n23-selector-probe.mjs` creates two identical buttons. `LocatorSchema.parse({css: 'button >> nth=0'})` accepts the target. The ordinary CSS selector matches two buttons, but `exactLocator` matches one and clicks the first button. The output is `originalCount: 2`, `actualCount: 1`, and `clicked: 'first'`.

```sh
PATH=/private/tmp/swc-toolchain/node_modules/.bin:$PATH node --experimental-transform-types /private/tmp/swc-n23-selector-probe.mjs
```

Cleanup returns `ok`. The fix should validate CSS syntax before passing it to Playwright, as the mask path already does, while retaining valid standard CSS. Test both engine-chain rejection and successful ordinary CSS locators.

## R6. Asynchronous faults after one side's screenshot are lost

Spec sections 7 and 8 require page errors and server exits during recording to fail the affected side. The current step loop awaits two `execute` promises and persists their earlier return values. A side's event handlers can set `state.fault` after that side returns `ok` while its peer is still working. The loop never reconciles that new fault. On the final step, the failure disappears entirely. On an earlier step, it is attributed to the next step.

`/private/tmp/swc-n23-late-fault-probe.mjs` uses one `goto` step. BEFORE returns HTML immediately. AFTER delays its HTTP response by 900 ms. The BEFORE fixture either schedules a page error after 250 ms or resolves the supplied server-exit promise after 250 ms.

Both runs report scenario outcome `ok`, two `ok` sides, and `changeRatio: 0`. The server-exit reproduction also prints `signalled: true`, proving its supplied exit notification fired before capture finished. BEFORE elapsed is approximately 64 to 79 ms and AFTER elapsed is approximately 986 to 1002 ms in these reproduction records. These timings identify event ordering, not a performance claim.

```sh
PATH=/private/tmp/swc-toolchain/node_modules/.bin:$PATH node --experimental-transform-types /private/tmp/swc-n23-late-fault-probe.mjs
```

The retained bundles are `/private/tmp/swc-n23-late-fault-kNQtmV/.show-what-changed/runs/20261101T204531616Z-46e3025ba6f1e81b/capture.json` and `/private/tmp/swc-n23-late-fault-PpKL3b/.show-what-changed/runs/20261101T204532883Z-6692260e124efc6c/capture.json`. Both cleanups return `ok`.

Reconcile side health at the shared step boundary before persisting side statuses and metrics. A regression must place the fault after the fast side finishes but before its slower peer, including a one-step scenario so another step cannot reveal the missing fault later.

## Existing behavior checked

The native scan searched comments, TODO/FIXME/HACK markers, lint suppressions, TypeScript suppressions, and coverage suppressions before the correctness review. It found one explanatory comment in the recorder fallback and no scoped lint, TypeScript, or coverage suppression. No comments were deleted or restored. There was no Comment Sicko rerun, architecture sketch, or constraint encoding.

The following commands ran with `PATH=/private/tmp/swc-toolchain/node_modules/.bin:$PATH`.

| Check | Actual result | Evidence limit |
|---|---|---|
| `npx vitest run test/unit/scenario-states-metrics.test.ts test/unit/timeline-presentation.test.ts test/integration/recorder.test.ts` | Exit 0. Three files and 37 tests passed. | Existing tests miss R1, R2, R5, and R6. |
| `npx vitest run test/integration/composer-media.test.ts -t 'contains template\|validates all\|retains composed\|reopens persisted\|capability'` | Exit 0. Four tests passed and three skipped. | The matched cases verify template isolation, path/hash validation, failure recovery, and fresh-process browser-free encoding. The regex did not select the executable-override case. |
| `ffprobe` on `evidence/artifacts/n3/success-compare.mp4` | H.264, yuv420p, 1920 by 686, both FPS values 30/1, 55 decoded frames, duration 1.833333 seconds, 47,985 bytes. | Saved owner artifact, not a fresh CLI or installed-package run. |

The first default-sandbox recorder probe failed because system `ps` was unavailable. The ordinary escalation succeeded. No automatic approval rejection occurred.

The composer integration cases that write shared `evidence/artifacts/n3` files were deliberately excluded from this read-only review. The reviewer read their exact-frame extraction assertions and independently probed the retained MP4 metadata. That does not substitute for a fresh full CLI success and incomplete comparison.

Source review found one masked screenshot path and no unmasked fallback. Existing browser tests directly decode persisted normal, failed, and held frames and cover invalid masks, retained hover, fresh scenario storage, fixed Date with live timers, required failures, popup/dialog/download/file-chooser rejection, navigation restrictions, overlays, and cancellation codes. The memory and concurrency findings above bound those conclusions.

Composer source review found fixed trusted HTML, `textContent` assignments, an embedded hash-checked local font, network blocking, restrictive CSP, integer timeline scheduling, deterministic first-highest-ratio poster selection, exact PNG repetitions with per-write backpressure, FFmpeg argv arrays, and decoded ffprobe validation. The browser-free test passed in a copied source package without bundled font assets and with an unavailable Chromium path. Error cleanup preserves the original encoding error, and the renderer deadline probe preserves its original deadline code even while cleanup separately fails.

Linux behavior, installed-package behavior, end-to-end privacy across decoded media from a fresh recorder run, full CLI status reduction, live browser playback, package completeness, and public release readiness remain outside this review's evidence. Root integration and post-fix verification are still required.

## Reviewed source hashes

These SHA-256 values identify the uncommitted snapshot used for all six findings. The finding-bearing module hashes were rechecked after the probes and remained unchanged.

| File | SHA-256 |
|---|---|
| `src/recorder/actions.ts` | `b1e7ac4ead2a6ee915ac8c31d7ea9fa66ad32bcf89dca5456a1ca7b82adc8d57` |
| `src/recorder/images.ts` | `2f5eac070c0e980cc764e68b87e491b86545c9d961c3c428d412830d7860cb3f` |
| `src/recorder/index.ts` | `0e4b3323c100ab5e9582c622b5b7cb5626c7b3fc34bc01111d60b0ccf246f318` |
| `src/composer/capabilities.ts` | `43499084deedad2e4e51fa274797aae38e6e222730d47ca1620d9601935a8a6e` |
| `src/composer/images.ts` | `82c26f1a86505c1840f4a52e70977a4a0ff618d42dbcd3c1b48a6ca8ef276a05` |
| `src/composer/index.ts` | `1b24267966d49a6bb0165d6a22e5ff508448fffd41a050b273584059d9ffee94` |
| `src/composer/presentation.ts` | `669cc50ee82b0763f30425f00ca50a86efd585a4b3745e3f9fd1513ee59ffbe6` |
| `src/composer/probe.ts` | `e77ad26857e5d2903cebd34f33c7a154eb788966913b213b21ec435ac4f4f9bb` |
| `src/composer/process.ts` | `db570a9f09257a9dc94de2bd82dc95b365676b81064590ef6202cc769b4c0587` |
| `src/composer/template.ts` | `6193964edfa7eb25895b38641ddb1bbd8e31926197f2ad0ef02f7a3cd5c1c61f` |
| `test/integration/recorder.test.ts` | `92a9c5c1e21ca043823e75a3a263cb211efd31a76da5958e485d9cc9087794e2` |
| `test/integration/composer-media.test.ts` | `35c939bc5b72d1bee42df78fcd02fdfc6851c17bba06fb9c6fe79613e7834e3b` |
| `test/unit/scenario-states-metrics.test.ts` | `3a89fe069fe0f4bf4fa2342d714fb69ff6a80198dd1d1a176cac6acb669cfe27` |
| `test/unit/timeline-presentation.test.ts` | `c82ab4bb139b7f95460d5097e6ee665f88a3f063623558aa502b1a0dc081ce4d` |
| `spec.md` | `65f604f5ac2acad60e3bec0882b18f1bdc4ebfb3a51d3215f4396b6b1ec13ab8` |
| `docs/architecture/contracts.md` | `ad4137d4f87fa8bea6714f19522f3cbad4bbb88bdf1afd7a3f0191ac70d17c7d` |
