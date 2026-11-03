# Terminal cancellation and ownership release

The goal is a 0.1.0 candidate that honors cancellation through terminal finalization and never reports uncommitted public metadata as saved. This change fixes three proven release-boundary defects. It does not establish full release readiness.

The work uses the uncommitted tree over `b792378c5150faf147dd7f3396d2bec28142ab06`. Only `src/runner/index.ts`, `src/runtime/context.ts`, `src/runtime/ownership.ts`, the new CLI regression file, and this report belong to this change. `src/runtime/files.ts` did not need changes.

## Reproductions and results

| Trigger | Before | After |
| --- | --- | --- |
| SIGTERM after the first terminal public write, followed by one injected write failure | CLI returned cancelled 143. The saved manifest and PR summary said ok 0. Returned and saved manifests differed. | The third write commits cancelled 143. Both public files agree with the returned manifest. `OUTPUT_WRITE_FAILED` remains in the error trail. |
| SIGTERM while `releaseRepositoryLock` is paused before touching the lock | CLI and saved manifest returned ok 0. | CLI and saved manifest return cancelled 143. |
| SIGTERM during release after a saved timeline fails its hash check | CLI returned failed 9 with `TIMELINE_HASH_MISMATCH`. | CLI returns cancelled 143 with null data. The rejected run receives no public writes. |

The first two baseline reports are `/private/tmp/swc-n6-final-write-iApTC5/probe.json` and `/private/tmp/swc-n6-release-signal-XWgru6/probe.json`. Passing reports are `/private/tmp/swc-n6-final-write-lMbMNN/probe.json` and `/private/tmp/swc-n6-release-signal-EF3UWb/probe.json`. These passing probes used the final manifest protocol before the separate no-manifest branch change.

The invalid-timeline baseline is `/private/tmp/swc-n6-invalid-release-r6CMij/probe.json`. Its passing report is `/private/tmp/swc-n6-invalid-release-FrpiPN/probe.json`.

The original disposable probe scripts remain at `/private/tmp/swc-n6-final-write-probe.mjs`, `/private/tmp/swc-n6-release-signal-probe.mjs`, and `/private/tmp/swc-n6-invalid-release-probe.mjs`. They invoke the built CLI and send real OS signals. The release loader's function anchor changed to accept the new optional callback parameter. Its scheduling behavior did not change.

## Protocol

`OwnershipCommit` is `(release: () => void) => Promise<void>`. Both ownership-release functions accept it as an optional argument. Existing cleanup callers retain their original behavior.

The runner writes terminal artifacts inside this callback while the repository lock remains held. It samples cancellation after every successful write. A changed cancellation decision requires another write before release. Each persistence pass permits at most three attempts. Any output failure records `OUTPUT_WRITE_FAILED`, even if a later attempt succeeds. An earlier fatal error or cancellation remains primary.

After the last successful write, the callback checks cancellation and invokes a one-shot synchronous release closure. The closure revalidates the lock directory identity, owner nonce, run nonce, canonical paths, and bounded regular marker files. It then removes the lock owner and directory without yielding to the Node event loop. This actual ownership release is the successful terminal cutoff. Signal handlers and deadlines remain attached throughout the preceding asynchronous work.

A failed release permits metadata repair only after ownership has been verified as retained. Uncertain ownership produces null result data and an explicit warning, with no further public writes. Repeated output failure retains the lock and returns null data with `OUTPUT_WRITE_FAILED`. Its warning names the run and states that saved files may show an earlier result. The runner does not unconditionally release this retained ownership from a final block.

If validation rejects a saved run before a manifest becomes eligible for modification, the runner releases ownership before selecting its failure result. It then samples cancellation. This path preserves the rejected run's public files.

## Verification

The final focused command passed all 25 tests, including the unchanged 15 ownership tests and 10 new real-CLI regressions.

```sh
PATH=/private/tmp/swc-toolchain/node_modules/.bin:$PATH npx vitest run test/integration/terminal-cancellation.test.ts test/unit/runtime-finalization.test.ts --reporter=dot
```

The new CLI cases cover transient and persistent output failure, SIGINT and SIGTERM during release, cancellation with failed release, uncertain release, output failure after an earlier fatal error, changed run nonce, and invalid-run cancellation. They assert exit codes, returned JSON, persisted manifests, PR status, lock presence, and absence of writes after release. The saved encoding fixture uses real composed PNGs and actual FFmpeg execution. Narrow loader hooks control interleavings and inject filesystem failures.

The broader runtime and adversarial suites passed all 31 tests during the change. This includes all eight existing real SIGINT and SIGTERM tests across preparation, server startup, recording, and encoding.

```sh
PATH=/private/tmp/swc-toolchain/node_modules/.bin:$PATH npx vitest run test/integration/adversarial-gaps.test.ts test/unit/runtime.test.ts --reporter=dot
```

`npm run typecheck` and `npm run build` pass under Node 24. CLI and process integration tests ran in the authorized local environment with process, browser, and FFmpeg access. These local results do not substitute for the final installed-package or Linux gates.

## Decision trail

The throughput checkpoint used a small saved encoding fixture to exercise ten terminal branches through the real CLI. The original independent probes established the failure before implementation. A callback inside ownership release was chosen because an extra asynchronous cancellation check still leaves a signal window before lock removal.

Model the Domain shaped the explicit persistence states and ownership callback. Fix Root Causes replaced the premature decision boundary and removed unconditional release after failed persistence. Prove It Works required real CLI signals and comparisons between returned data and saved files. Type System Discipline shaped the typed callback and validated owner records. Poteto-mode, unslop, and technical-writing shaped this report. Architecture exploration and independent final review remain coordinated by the root agent.

## Final file hashes

| File | SHA-256 |
| --- | --- |
| `src/runner/index.ts` | `6a646917ce5ee7e27a1cdf1041f384660f88ad87225714eb1b47079416dae1fc` |
| `src/runtime/context.ts` | `a2ca6f78de87cff8a29b1b1172a3e7cb0b4b6cae05eb7d43de33237b1b4e243c` |
| `src/runtime/ownership.ts` | `95b9697b492e0ea21274c4b97ba1fdb1359bbcec2cd4566d54d1b5694b76c8b5` |
| `test/integration/terminal-cancellation.test.ts` | `ff507da7233ad78ba444de9a91bde9fdf60496814a243c82b0385d18ebd1b28e` |
| `dist/runner/index.js` | `fd4608ccd3a31376cfa007e2bc437da06539e98323bc68ab8da443174574a25e` |
| `dist/runtime/context.js` | `6bfc6cdfffd938cfe2f3dc0d5ca709d5e27fe6ec223fd999802630fd89c2046a` |
| `dist/runtime/ownership.js` | `b979e6eaed2cfbd688a5ea993b418bab8b0ff1b37119f6becf1cf617af9dbcae` |
