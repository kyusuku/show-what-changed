# N6 acceptance gap audit

The goal is a complete 0.1.0 release candidate whose artifacts and acceptance claims match observed behavior. This audit covers remaining T01 through T14 gaps after the N1, N23, and N45 reviews. It does not establish package, Linux, repeatability, or real-app release readiness.

The reviewer owns this report and `test/integration/adversarial-gaps.test.ts`. Product code remains read-only for this reviewer. The root integrator and runtime owner implement the accepted fixes. The reviewed tree is uncommitted over `b792378c5150faf147dd7f3396d2bec28142ab06`.

The review uses macOS arm64 and Node 24.22.2 from `/private/tmp/swc-toolchain/node_modules/.bin`. The audit began on 2 November 2026 in Asia/Bangkok. UTC probe timestamps fall on 1 November.

Throughput checkpoint is bounded investigation, reproducible failures, independent retests, and one test file. The Test Behavior, Not Implementation principle changed the assertions to check command results, real files, decoded pixels, and process liveness. The Fix Root Causes principle changed the recommendations to preserve ownership through final writes and give the CLI sole control of signal cleanup. Poteto-mode, unslop, and technical-writing shaped this report. No nested agents ran.

## Findings and disposition

| ID | Acceptance | Proven behavior before the fix | Disposition |
| --- | --- | --- | --- |
| N6-F1 | T13, T14 | Concurrent clean deletes a finalizing run. Compose then returns success and advertises deleted media. | Root and runtime owner fixed ownership lifetime. Both regressions and the original rebuilt external CLI reproduction pass. |
| N6-F2 | T05 | API handlers and private App Router subtrees make an otherwise complete route comparison incomplete. | Root fixed classification. Four route fixtures pass. |
| N6-F3 | T12, T14 | SIGINT during recording or encoding exits 130 without a JSON envelope. SIGTERM during recording can report failed context cleanup. | Root disabled competing Playwright signal handlers. All eight signal and phase cases pass. |
| N6-F4 | T12 | An unrelated listener that binds after allocation can turn an ordinary conflict into SERVER_EXITED, bypassing required retries. | Root moved listener ownership classification before server liveness classification. The real bind race passes. |

## N6-F1. Cleanup released ownership before terminal writes

`cleanupRun` originally marked `.owner.json` inactive and removed `run.lock` before `runner.finalize` wrote `pr.md` and the terminal manifest. A live command therefore became available to `clean` and `compose` while it still wrote public files.

The external reproduction copies a successful disposable N45 run into a fresh temporary Git repository. A Node module loader adds a pause at the entry to `writePublicArtifacts`. The loader changes scheduling only. It does not change output, validation, cleanup, or ownership logic. While the real built `compose --json` waits there, a second real built CLI runs `clean <runId> --json`.

The observed pre-fix result is preserved at `/private/tmp/n6-finalization-race-clOxrO/report.json`.

| Observation | Result |
| --- | --- |
| Owner marker at pause | `inactive` |
| Repository lock at pause | Absent |
| Concurrent clean | Exit 0 and `removed: true` |
| Run directory before resuming compose | Absent |
| Resumed compose | Exit 0 and `status: ok` |
| `compare.mp4`, `poster.png`, `capture.json`, `timeline.json` | Advertised with hashes and sizes but missing on disk |
| `pr.md` and `manifest.json` | Recreated by the paused command |

The scripts are `/private/tmp/n6-finalization-race.mjs` and `/private/tmp/n6-finalization-race-loader.mjs`. They operate only on their disposable copy. The original N45 artifacts are unchanged.

The minimum ownership correction separates resource cleanup from final ownership release. The runner retains its active marker and repository lock while it writes the terminal artifacts. Ownership release happens afterward. If release fails while the command still owns the lock, the runner records the cleanup failure under that lock. It must not write again after successful release.

The new regression pauses the real public writer after a real FFmpeg encode. It attempts both `cleanOwnedRun` and `compose` while the first command finalizes. Both attempts must return `RUN_ACTIVE`. After resuming, the first result must match the persisted manifest, every advertised artifact must exist with the reported size and SHA-256, and the lock must be gone. Both cases passed after integration.

The runtime owner also audits clean versus compose acquisition and uncertain lock recovery. Those additional runtime tests belong to `test/unit/runtime-finalization.test.ts` and are not claimed as independently verified by this report yet.

## N6-F2. Ignored routing inputs counted as coverage gaps

Spec section 6 explicitly ignores `route.*` API handlers and private App Router subtrees. The original selector excluded private pages from route discovery but still put their changed paths into `coverage.unresolved`. API handlers took the same unresolved path.

The new table changes `app/page.tsx` together with each of these paths.

- `app/api/ping/route.ts`.
- `app/_private/helper.ts`.
- `app/shop/_private/layout.tsx`.
- `app/_private/page.tsx`.

Each result must select `/`, have empty unresolved and unsupported buckets, and mark coverage complete. This asserts the explicit ignore contract for a mixed change. It does not invent a new terminal outcome for an API-only change.

All four cases pass after the root fix.

## N6-F3. Playwright signal handlers competed with CLI cleanup

The previous tests exercised typed cancellation and a CLI deadline. They did not send both actual operating-system signals in every phase.

The new matrix starts a real CLI child and waits for observable phase work. Preparation waits for an install script marker. Startup waits for a development process marker. Recording waits for a browser request. Encoding waits for the actual encoder invocation after successful capability probes. The encoder fixture then remains alive until cancellation.

Before the fix, repeated SIGINT probes during recording and encoding exited 130 with empty stdout and stderr. SIGTERM during recording returned a cancellation manifest with two `CLEANUP_FAILED` errors for owned contexts. These failures appeared only after the browser launcher had installed its own default signal handlers.

The root set `handleSIGINT`, `handleSIGTERM`, and `handleSIGHUP` to false on `chromium.launchServer`. The CLI and supervisor retain signal ownership.

After that fix, the eight cases passed in one focused run.

| Phase | SIGINT | SIGTERM |
| --- | --- | --- |
| Preparation | Exit 130, one JSON envelope, cleanup ok | Exit 143, one JSON envelope, cleanup ok |
| Startup | Exit 130, one JSON envelope, cleanup ok | Exit 143, one JSON envelope, cleanup ok |
| Recording | Exit 130, one JSON envelope, cleanup ok | Exit 143, one JSON envelope, cleanup ok |
| Encoding | Exit 130, one JSON envelope, cleanup ok | Exit 143, one JSON envelope, cleanup ok |

Every case also checks the persisted manifest against the returned data, artifact hashes and sizes, empty owned process groups, absence of temporary workspaces and the repository lock, survival of an unrelated child, and preservation of caller HEAD, index bytes, and server source bytes.

The test invokes the source CLI through Node 24 type transformation and a `.js` to `.ts` resolution hook. It changes no product behavior. This prevents stale build output from invalidating the module-level gate. The installed-package CLI gate remains separate. Raw signal results are retained under `tmpdir()/swc-n6-signal-evidence` with the phase, signal, stdout, stderr, persisted manifest, and process records.

## N6-F4. A bind race bypassed startup retries

The original lifecycle suite tested an already occupied port. The new test allows allocation to choose a free port, then binds an unrelated real listener immediately before the owned server launches. The owned server receives an ordinary bind conflict.

`verifyListeners` originally awaited the socket inventory and then checked `process.isAlive()` before determining who owned the socket. If the server exited during that wait, it returned `SERVER_EXITED`. That code is not a retryable conflict. The earlier liveness check in `start` had already passed, so its conflict classification did not run.

The root moved listener ownership classification first. The fixed test starts the comparison servers on other ports, confirms the servers respond, cleans the owned pair, and confirms the unrelated listener survives. The focused retest passed.

## Additional acceptance evidence

The shallow-source test creates two real Git commits and clones the latest commit with depth one over a local file URL. Planning against the absent earlier endpoint returns exit 2 with explicit fetch guidance. The shallow boundary stays unchanged and no output directory is created. This closes the untested shallow missing-ref case in T02 without requiring network access.

The T09 continuity test carries one synthetic secret and a separate fill value through an actual consented comparison. The app puts red-background, blue-text secret content and the input field inside `.secret`. The scenario opens the app, fills the input, fails a required visibility check, and leaves the final step blocked. The result must be partial with two verified pairs, two failed side steps, and two blocked side steps.

The test checks all eight persisted source images. The mask interior must be exactly RGB 16, 16, 16. No exact red or blue sentinel pixels may occur anywhere in those images. It checks all four composed step images in both panels. It then decodes all 54 video frames and checks the mask interior in all 24 frames that contain the app view. Lossy decoding allows at most eight channel levels of deviation from the mask color. The 30 title frames do not contain app screenshots.

`manifest.json`, `capture.json`, `timeline.json`, and `pr.md` must contain neither secret nor fill value. The private plan must contain the fill value, which proves the input was supplied. This is pixel evidence for the exact masked fixture, not an OCR or general secret-detection claim. The focused test passed.

## Commands and evidence scope

All commands use `PATH=/private/tmp/swc-toolchain/node_modules/.bin:$PATH`. Process and loopback access use the authorized escalation because the default sandbox blocks these capabilities.

| Command | Result |
| --- | --- |
| `npm run typecheck` | Passed after the test file was added. |
| `npx vitest run test/integration/adversarial-gaps.test.ts -t 'external CLI signal' --reporter verbose` | Passed all eight selected cases after the browser fix. |
| `npx vitest run test/integration/adversarial-gaps.test.ts -t 'ownership lasts\|bind-after-selection' --reporter verbose` | Passed all three selected cases after the ownership and port fixes. |
| `npx vitest run test/integration/adversarial-gaps.test.ts -t 'T09 keeps one' --reporter verbose` | Passed the full privacy continuity case. |
| `npx vitest run test/integration/adversarial-gaps.test.ts --reporter verbose` | Passed all 17 tests with no skips. Exit 0. |
| `npm run build` | Passed before the final external CLI retest. |
| `node /private/tmp/n6-finalization-race.mjs` | Passed the original external CLI interleaving after rebuilding. |
| `git diff --check` | Passed. |

Focused runs skip unselected cases by design. They are not a full-suite or final-release verdict. T01 through T14 still require the integrator's requirement matrix and combined gate at the final commit. This review adds concrete evidence for previously uncovered behavior and does not mark the 181 requirement rows complete.

## Final verification addendum

The complete 17-case file passed on 2 November 2026 at 04:12 Asia/Bangkok. The reported Vitest duration was 35.94 seconds. No tests were skipped in this run.

The original external CLI reproduction then passed against rebuilt JavaScript. At the finalization pause, `.owner.json` remained active and `run.lock` remained present. Concurrent clean returned exit 2 with `RUN_ACTIVE`. The run directory remained intact. After resuming, compose returned exit 0 with all five advertised artifacts present. Their actual bytes and SHA-256 values matched the returned manifest. The persisted manifest matched the returned data, and the final repository lock was absent.

The final external report is `/private/tmp/n6-finalization-race-NdhMI9/report.json`. The independent hash and persisted-manifest check is `/private/tmp/n6-finalization-race-NdhMI9/verification.json`.

The following hashes identify source and built files at the final external retest cutoff. Other owners continue working in the shared tree. These hashes do not replace the required final-commit release gate.

| File | SHA-256 |
| --- | --- |
| `src/runtime/context.ts` | `426daec4787c6e11225b108b720c04d1dc075275edee8abb03f0eb9591e5047f` |
| `src/runtime/ownership.ts` | `98466ca377acffe8a28aaa3c234f15e085db5cfee90cc2e7767c1905e085105a` |
| `src/runtime/browser.ts` | `97c506885c0f30d04bfa9e4ca101b85c90254a86d214bb5fa139b4d22a25da23` |
| `src/runtime/index.ts` | `9979c2c4e9d8f589f310282277b8dc5d89195cfcdf029e24ca4698e4760d35db` |
| `src/runner/index.ts` | `1bc983212c0229787a713dc4b216a9cee37b65875f454c4cfc2b6d34dccd314f` |
| `src/planner/routes.ts` | `47f440b0b2b4bbf7d6c28254bcf12ce24b74df1ad498627e75d7d9c7335fe6db` |
| `test/integration/adversarial-gaps.test.ts` | `2c075c9cba443c2ca0a28c5b7c5d7c8416e7736026fc6204278a170c29920f9c` |
| `dist/runtime/context.js` | `4f5bad0375cf5ed8689ae4f7540dfb262e442a6bc15433d10edddcfba4f82085` |
| `dist/runtime/ownership.js` | `cceeadbaed0957a6d31aa33f3951ff4f9fd52212668edc20e331049650f31250` |
| `dist/runtime/browser.js` | `f6e1f0b3a16f0b4818af5be358fbdb023b9364e6e9bcdd3c1b895a5b9fdc836b` |
| `dist/runtime/index.js` | `fac153cb51feaf192fcf42cc315ed6f6ec285da9cca131c6e7e59c882d807642` |
| `dist/runner/index.js` | `e74abed63267029c87c6c19e172d324b0b43b15d6a14008de8b58e63af368526` |
| `dist/planner/routes.js` | `7318f2caec63439c7c1974cb62ced2f6ea134a0b38c46e174aa569ba0a34c078` |

All four proven findings from this bounded audit are fixed and independently retested. The report does not claim that all T01 through T17, all 181 matrix rows, or the publication gate are complete.
