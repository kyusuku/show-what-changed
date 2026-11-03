# Independent N4 and N5 review

The user goal is a complete v0.1 implementation and verified 0.1.0 tarball ready for owner publication approval. This review checks the planner, CLI, runner, and JSON input boundary. It does not establish package or cross-platform release readiness.

Review date is 2 November 2026 in Asia/Bangkok. Runtime was macOS arm64 with Node 24.22.2 from `/private/tmp/swc-toolchain/node_modules/.bin`. The reviewer changed only this evidence file. Disposable probes and fixture artifacts remain outside the implementation checkout.

Throughput checkpoint is n/a for a read-only investigation. The Prove It Works principle determined the verification method. The reviewer executed the built CLI and checked actual artifacts and live process groups instead of relying on unit tests or module-owner reports.

## Verdict at review cutoff

Ordinary success, required-step partial failure, saved-plan checks, browser-free recomposition, and encoding recovery passed. The FIFO input hang was reproduced, fixed by the integrator, and independently retested. The interactive deadline fix also passed a real PTY test.

All three proven findings below were fixed and independently retested before this review finished. The contradictory-manifest repro now fails validation. The unmodified partial run still correctly remains partial after recomposition.

The source was changing during review. Hashes below identify the inspected source and the built JavaScript used at the final probe cutoff. The integrator's later changes require their own final verification.

## Proven findings

### N45-F1. Contradictory comparison metadata can produce false success

Status is fixed and independently verified. The affected paths were `src/runner/index.ts`, `src/runner/outcomes.ts`, and the imported `ManifestSchema` boundary.

Starting from a real partial run, the probe changed only `manifest.comparisonOutcome.status` from `partial` to `ok`. It left `capture: partial`, the original partial scenarios, failed and blocked counts, and `LOCATOR_MISSING` error intact. `compose --json` accepted the document, re-encoded, and returned this contradictory result.

```json
{
  "status": "ok",
  "exitCode": 0,
  "error": null,
  "comparisonOutcome": { "status": "ok", "capture": "partial" },
  "summary": { "failedSteps": 1, "blockedSteps": 3 },
  "errors": [{ "code": "LOCATOR_MISSING", "side": "before" }]
}
```

The original `compose` implementation validated the structural schema and accepted comparison status `ok` or `partial`. `reduceOutcome` then trusted the top-level comparison status. Neither boundary rejected the conflict with the preserved capture outcome. The original public files were restored after the probe.

The integrator added validation of preserved scenario states, comparison outcomes, and summary values before accepting a manifest. The exact repro then returned `INCONSISTENT_MANIFEST`, exit 2, with `data: null`. An intact partial run still recomposed without Chromium, returned exit 3, retained `LOCATOR_MISSING`, and matched all five public artifact hashes and sizes.

The initial observed result is transcribed above. The fixed result is `/private/tmp/n45-manifest-consistency-fixed-result.json`. The rerunnable probe is `/private/tmp/n45-manifest-consistency.mjs`. The probe saves and restores the original manifest, PR text, video, and poster. The final intact recomposition result is `/private/tmp/n45-final-partial-compose.stdout.json`.

### N45-F2. FIFO JSON input bypassed cancellation

Status is fixed and independently verified.

The original `readJsonDocument` called `open(O_RDONLY | O_NOFOLLOW)` before checking whether the file was regular. Opening an external FIFO blocked that promise indefinitely. This real CLI invocation reached neither an input error nor its one-second deadline.

```sh
node dist/cli/index.js compare --route /pricing --config /private/tmp/n45-review-4vLyqp/config.json --timeout 1 --allow-exec --json
```

The initial process remained alive after SIGTERM and required SIGKILL at 4.015 seconds. Stdout was empty. The FIFO was outside the source repository so source inventory validation did not reject it first.

The integrator added `O_NONBLOCK` before the regular-file check. The exact repro then returned one `INVALID_INPUT` JSON envelope, exit 2, in 0.365 seconds. This closed the reproduced failure.

Initial evidence is `/private/tmp/n45-review-4vLyqp/results.json`. The original probe script is `/private/tmp/n45-probes.mjs`.

### N45-F3. Missing compose directory received an internal-defect classification

Status is fixed and independently verified. The original built CLI returned `INTERNAL_ERROR`, exit 1, for `compose /does-not-exist --json`. It still emitted exactly one JSON document.

The integrator added an input classification for filesystem and syntax errors. After rebuilding, the exact invocation returned `INVALID_INPUT`, exit 2, with concrete guidance to supply an intact input file or owned run directory.

## Measured successful checks

### Real CLI comparison and artifact integrity

The synthetic repository was created by `scripts/create-fixture.mjs` at `<synthetic-fixture-repository>`.

| Source | Full OID |
|---|---|
| `fixture-base` | `30c3da70198a3fbabf627532f75b54fd761f1945` |
| `fixture-head` | `a9fee6837d1f57f4fde087a7a21bb95003f9d96a` |

Both comparison commands ran from that fixture with the absolute path to `dist/cli/index.js` and the absolute scenario path from this checkout.

```sh
show-what-changed compare --base fixture-base --head fixture-head --scenario test/fixtures/scenarios/pricing.scenario.json --allow-exec --json
show-what-changed compare --base fixture-base --head fixture-head --scenario test/fixtures/scenarios/required-before-failure.scenario.json --allow-exec --json
```

The first command exited 0. Its JSON contained five verified changed pairs, one expected BEFORE absence, one side exclusion, valid provenance on both sides, and successful cleanup and encoding. The run ID is `20261101T204943474Z-67e2232c705d73b8`.

The second command exited 3. It contained two verified pairs, one failed BEFORE step, and three later blocked BEFORE steps. Every failed or blocked pair had a null change metric. The run ID is `20261101T205142393Z-6b0b4b3eb8ea3343`.

Both stdout files contained exactly one parseable JSON document. Stderr files were empty. Actual bytes and SHA-256 values matched all five manifest artifacts for the successful run. The recovery checks repeated this validation on the partial run.

| Successful run artifact | Bytes | SHA-256 |
|---|---:|---|
| `compare.mp4` | 79976 | `aa6bbd83c587522ef5fff88b4afb73631897aa129528711e6bd3fb7a36256665` |
| `poster.png` | 89691 | `aaa92753f38961fa1def31054930aac73180d57f6b1afcb9c47c345728b2fea3` |
| `capture.json` | 4924 | `28fdb8e91c6ca0e6832b0224ddfb52c2fae5b58c29c4a75ce0871fcb535d0e69` |
| `timeline.json` | 3026 | `512dba35f6936c641963a200372d852a2bc74cacf2110de50dc86316822ef252` |
| `pr.md` | 839 | `c6e45845c70ae31ff4949053ebad42ee6dc351591189ebc8a3d4584e9faad946` |

Raw results are `/private/tmp/n45-full-compare.stdout.json` and `/private/tmp/n45-partial-compare.stdout.json`. Their matching stderr files use `.stderr.log`. Run artifacts remain under the fixture's `.show-what-changed/runs/` directory.

### Compose and recovery preserve partial capture

Successful recomposition ran from `/private/tmp` with `PLAYWRIGHT_BROWSERS_PATH=/private/tmp/n45-no-browser`. It returned exit 0 while preserving comparison metadata and counts. The result is `/private/tmp/n45-compose.stdout.json`.

The following sequence ran against the partial run with Chromium unavailable.

| Probe | Result | Preserved comparison | Artifact hashes and disk manifest |
|---|---|---|---|
| `SWC_FFMPEG` points to nonexistent executable | Failed, exit 8, `MEDIA_CAPABILITY_UNAVAILABLE` | Exact match | All match |
| Restore normal FFmpeg | Partial, exit 3, `LOCATOR_MISSING` | Exact match | All match |
| Change one composed PNG byte | Failed, exit 9, `IMAGE_HASH_MISMATCH` | Exact match | All named public artifacts match |
| Restore the original PNG | Partial, exit 3, `LOCATOR_MISSING` | Exact match | All match |

The returned manifest matched the persisted manifest on every path. Recovered encoding errors moved into `errorHistory`. The original capture failure remained in current `errors`. Evidence is `/private/tmp/n45-compose-recovery-results.json`. The rerunnable script is `/private/tmp/n45-compose-recovery.mjs`.

### Saved plans, consent, and JSON protocol

A separate disposable fixture was used for branch and source mutations. Every listed case returned exactly one JSON envelope.

| Probe | Observed result |
|---|---|
| Unknown flag | Exit 2, `INVALID_ARGUMENT` |
| Plan with explicit route | Exit 0 |
| Noninteractive compare without execution consent | Exit 7, `EXECUTION_CONSENT_REQUIRED` |
| Explicit-ref saved plan after caller HEAD moved to the other fixture commit | Passed plan validation and reached consent denial, exit 7 |
| Raw config bytes changed by one newline | Exit 2, `STALE_PLAN` |
| WORKTREE source bytes changed after planning | Exit 2, `STALE_PLAN` |
| Saved plan changed without a new plan ID | Exit 2, `STALE_PLAN` |
| JSON help and JSON version | Exit 0, one envelope each |

Evidence is `/private/tmp/n45-review-4vLyqp/results.json` and `/private/tmp/n45-stale-4paRis/results.json`. The stale-plan probe is `/private/tmp/n45-stale-probes.mjs`.

### Cancellation and owned-process liveness

An unanswered interactive `compare --route /pricing --timeout 1 --json` ran through a real PTY after the consent signal fix. It displayed the preview, then returned `DEADLINE_EXCEEDED`, exit 10, after 1.135 seconds.

A consented fixture comparison with `--timeout 1` returned exit 10 with a terminal manifest and successful cleanup. Its run ID is `20261101T205421808Z-48ad5521f78e1fcd`. Direct `ps` inspection found no live members in any of its seven recorded process groups. The repository run lock was absent. Evidence is `/private/tmp/n45-cancel.stdout.json`.

### Focused unit gate

```sh
PATH=/private/tmp/swc-toolchain/node_modules/.bin:$PATH npx vitest run test/unit/cli-args.test.ts test/unit/planner-routes.test.ts test/unit/runner-outcomes.test.ts
```

The command exited 0 with 35 tests across three files passing. The initial build also passed. This review did not rerun the entire suite.

## Observations requiring disposition or a separate probe

These observations are not claimed as demonstrated release failures.

- Route handling classifies changed `app/api/ping/route.ts` and `app/_private/helper.ts` as unresolved. A table probe with those paths and `app/page.tsx` selected `/` but set coverage incomplete. Spec section 6 says API route handlers and private subtrees are ignored. The integrator should clarify whether that sentence means ignore as route candidates or omit from change classification entirely. The implementation is conservative and does not report false coverage success.
- `cleanupRun` marks ownership inactive and removes the repository lock before runner finalization writes `pr.md` and the terminal manifest. A concurrent `clean` or `compose` may therefore enter during terminal writes. The code ordering establishes a window, but this review did not reproduce an actual interleaving or data loss. The next lifecycle audit can test slow final writes and concurrent commands.
- The integrator added guarded cleanup finalization after this review began. Unexpected thrown cleanup failures were not independently injected here.

## Scope and evidence limits

The full comparisons used the repository's built CLI. They did not use an installed tarball. This review did not establish Linux behavior, package contents, media visual correctness, source preservation across every adversarial case, every signal phase, or all T01 through T17 gates. The parent integrator owns those checks.

The false-success probe altered metadata deliberately and restored original public files. The image corruption probe restored the original composed PNG. Other fixture repositories and outputs remain available for review. No implementation files, production app, paid provider, remote service, or publication operation were changed.

## Hash record

These source hashes were read before the final N45-F1 fix. The subsequent runner hashes appear in the final addendum.

| File | SHA-256 |
|---|---|
| `src/planner/index.ts` | `1c05a1274fcf21067666ef187388557e685a9e597518f2939d81cfecf004d9ef` |
| `src/planner/persist.ts` | `00e9f3b8cad1079a6f51729d6f09ef4d905febba0a95358b8211bcbac4513e97` |
| `src/planner/routes.ts` | `25604851ced3a7c186ceea0b14bc02eb528fafd6ed7e8767109ef95fd7935092` |
| `src/cli/args.ts` | `7211e1869db2370a5dd294c3a731d654a3cab6352c6aaa417eb98037bca1f8b1` |
| `src/cli/index.ts` | `62028d9927ebfc6ae5bc53d4c77c279bfc34c6a01e6ad9d0a84ded57f854f8d6` |
| `src/runner/artifacts.ts` | `57007feec39d12e2ec77adb017e2834b7649d88570430977f1d664a81ec84fbe` |
| `src/runner/doctor.ts` | `de976b1351ee9f7a99b9b40c6bdc07f11e5d913e20c158b809cb891ffb4b4a8a` |
| `src/runner/index.ts` | `be7cae8c187e0d1a38721d59b5761cd93ce248ad8191fe0f989bf06826727afe` |
| `src/runner/outcomes.ts` | `8fe41a13b6b4004a70e77271e9b4e8d5333fee2c9a402ea9f0693a2d8766a4fd` |
| `src/schema/io.ts` | `fce75b2387aaa7c3dd28060849d3ff76160cd1a5dda03908f34e004d4c376bbe` |

The initial probe snapshot differed in three scoped files. `src/cli/index.ts` was `9a65688cf5e7e6f517f06c25823bcbfb3cc090c30b038ae091c7bfb34153aec1`. `src/runner/index.ts` was `a37c090a25e09964de98ad029091b088945edc6af9cf0645a4f14c9e7ab1eee9`. `src/schema/io.ts` was `61d178a5dfc79de0f1c797486775341c2e197146932fc08be675d4c5e366f470`. The initial snapshot is also in the raw probe result.

The built JavaScript hashes before the final N45-F1 fix were as follows. This built runner also preceded the last error-classification and cleanup edits.

| File | SHA-256 |
|---|---|
| `dist/planner/index.js` | `0e63cb6470643d9d8eee3d6adfb33bc32f395709f5378bb599ce895d96d7dec1` |
| `dist/planner/persist.js` | `c12cf89866222e6d8f1e7f7bd670298c99abc35f842f2e3d306a87b58aae8058` |
| `dist/planner/routes.js` | `a24a29bc7d5cda2d64fc94e8b8e84a2865c6fbbc44316b40b99d68e8ea3a46d0` |
| `dist/cli/args.js` | `bd91a2c5afd9ca43975e2c606e8aea74a07a2bdadb38a9a9ca3e48a432523bb8` |
| `dist/cli/index.js` | `e7839adeabfceaf4e69d7ee35b57ef480acd7ab90d1d9e01275f580f37bd9a71` |
| `dist/runner/artifacts.js` | `86e46c2aae29036b0b99a8f772a3252c98c86051bc59db792c42565b409840b7` |
| `dist/runner/doctor.js` | `89741682bd614a7c5d1455ad0c6c3faa2b82072d625ffb7aaec9246da4c07b0e` |
| `dist/runner/index.js` | `5fcd3f2d73b54a1f0c011f66f3187dd737569af8b00e42c0dd403b6ad1a3576a` |
| `dist/runner/outcomes.js` | `4c9c79b0321450ab9d8c38256a2788254475114a925574320834565736c0a04b` |
| `dist/schema/io.js` | `9cefe7de5969281f103eb364b6ef6e7a5fc6b2423528cb29600ec91a4bdf7d9a` |

### Final addendum

These runner hashes identify the final independent retests of contradictory metadata, intact partial recomposition, and missing input classification.

| File | SHA-256 |
|---|---|
| `src/runner/index.ts` | `53879353552fb93534292e6a2001af44ecb803f63dadffa98390c3e42357d608` |
| `src/runner/outcomes.ts` | `843e62456371409261944e6c394ace4196b3a3a0a08ab2a39bf9f5cd549fda58` |
| `dist/runner/index.js` | `a4d632995c80700adbd5f71be44c79dd513073b40f9290d90d9bc3b3cdd4d4a7` |
| `dist/runner/outcomes.js` | `df00527177326381e500b9fa33b86ce24a96d00828c0628b44fdd9c11002a073` |
