# Release-check review

The goal is a complete show-what-changed 0.1.0 candidate whose installed package, platform results, and release evidence satisfy the current specification before owner publication. This independent review examines the checks themselves. It does not declare the candidate ready.

The reviewed working tree was over `b792378c5150faf147dd7f3396d2bec28142ab06`. The scope was `scripts/release-harness.mjs`, `release-smoke.mjs`, `repeatability.mjs`, `real-app-smoke.mjs`, and `release-audit.mjs`, against specification section 12 and `docs/build-goal.md`. The reviewer also read the README, quickstart, relevant preservation/media tests, and the Linux gate documentation to distinguish missing evidence from checks owned elsewhere.

Throughput checkpoint is not applicable to this read-only investigation. No application source or release script was edited. No browser, full suite, platform gate, public action, or paid service was launched. The Linux cleanup investigation remained with its assigned owner.

## Baseline findings

The integrator accepted the following corrections. The baseline findings concern what the release checks can accept. They do not demonstrate that the application currently corrupts source, omits package files, or contains a secret.

| Finding | Baseline evidence | Required correction |
| --- | --- | --- |
| Caller dependency mutations are invisible to the preservation check. | `release-harness.mjs` lines 42–54 inventories Git-admitted paths and reads only `node_modules/caller-sentinel.txt`. An isolated probe changed another ignored dependency file and received an identical state. A second probe created `node_modules/synthetic-dependency/index.js` where no dependency directory existed and also received an identical state. This affects the meaning of preservation assertions in all three runtime scripts. | Snapshot caller filesystem contents, including ignored files, directories, and symlink identity, while excluding only intentional tool output and Git internals. Do not follow symlinks. Verify creation, removal, content changes, and mode changes. |
| The package content gate accepts missing emitted schemas. | `release-harness.mjs` lines 90–92 requires only `scenario.v1.json`. The probe removed the six other emitted JSON schemas from a copy of the actual interim package. The real `installCandidate` function passed its archive-content checks and reached npm installation. | Require and inspect all seven JSON schemas, plus the documented README, font provenance, notices, license, skill, executable, and font. Validate installed JSON files rather than treating the JavaScript schema module as proof that JSON files shipped. |
| The complete-history secret scan omits commit and annotated-tag messages. | `release-audit.mjs` lines 79–83 scans reachable blobs only. Running the actual audit script in a disposable repository containing synthetic credential-shaped strings only in one commit message and one annotated-tag message returned exit 0, `status: passed`, and zero findings. | Scan reachable commit and annotated-tag object contents as well as blobs. Keep the existing redacted finding format and explicit synthetic-value dispositions. |
| The exact README starting path lacks installed-package evidence. | README lines 43–54 documents default `HEAD` to `WORKTREE` route planning followed by saved-plan comparison. The baseline smoke uses saved explicit-commit scenario plans, direct WORKTREE comparison, and an intentionally stale WORKTREE plan. Its merge-base route comparison does not exercise the documented starting sequence. | Run `plan --route /pricing --json` on a dirty fixture, then `compare --plan .show-what-changed/plan.json --allow-exec --json` through the installed binary. Verify default source identities, generated route steps, artifacts, and caller preservation. |

The schema probe did not complete npm installation. The first attempt reached a sandbox-restricted default cache. The subsequent offline attempt used `/private/tmp/swc-pack-cache` and stopped with `ENOTCACHED` for Commander metadata. This proves that the content gate accepted the incomplete archive. It does not claim a complete installed-package pass for that archive. The downstream function imports `dist/schema/index.js`; the missing JSON schema files have no later check in the reviewed function.

The exact quickstart JSON has six steps. The smoke fixture has those same six steps plus `hover-retained`. Static extraction confirmed that the quickstart scenario parses against the current built schema and is exactly that ordered fixture subset. The baseline smoke therefore covers its actions but does not execute the literal documented snippet. Deriving the initial success scenario from the snippet gives runtime evidence without adding another comparison. Its expected verified-pair count is four. The seven-step repeatability fixture retains the explicit hover-preservation assertion.

## Reproduction evidence

The lightweight probe script is `/private/tmp/swc-release-review-probes.mjs`. Its final baseline artifacts are under `/private/tmp/swc-review-Z7R9JU/`.

- `probe-results.json` records missing-schema acceptance, message-scan false acceptance, invisible ignored-file mutation, invisible new caller dependency files, and decoded-frame negative controls.
- `audit-result/report.json` is the actual audit report with `status: passed` and zero findings despite the synthetic Git-message inputs.
- `audit-repo/` contains the disposable source repository used by the audit and preservation probes. The strings are synthetic. The evidence records finding hashes rather than publishing credential-like values.
- `missing-schemas.tgz` is the deliberately incomplete archive. It was created from the installed package used by the recorded interim package run.
- `static-evidence.json` records hashes of all five reviewed scripts, the review commit, the quickstart extraction result, and calculated interim report ranges.

The final baseline probe command was:

```sh
PATH=/private/tmp/swc-toolchain/node_modules/.bin:$PATH \
  npm_config_cache=/private/tmp/swc-pack-cache \
  node /private/tmp/swc-release-review-probes.mjs
```

It exited 0. The probe intentionally records the package installation cache failure and continues its independent audit, preservation, and image checks. A separate local check added the new caller dependency directory result to the same JSON file. None of these commands executed the application or browser.

## What the existing reports establish

Both reviewed reports identify tarball SHA-256 `efec9344c40b0830a827572e0ede610fd1d0676a3deee15e44c4225b871fc322`. Both ran on macOS arm64 using Node `24.22.2`.

`/private/tmp/swc-package-smoke-interim-02/report.json` passed from 2026-11-01 at 21:02:52 UTC through 21:05:47 UTC. It records an installed binary, help, doctor, strict argument errors, planning, consent refusal, success and partial comparisons, browser-free recomposition, encoder-failure recovery that preserves partial capture, direct WORKTREE comparison, and stale-plan rejection. It does not contain the later merge-base or automatic-incomplete commands now present in the working script. It cannot establish those added checks or final candidate identity.

`/private/tmp/swc-repeatability-macos-interim-01/report.json` passed from 21:10:39 UTC through 21:11:29 UTC. It records two runs, 14 source-frame comparisons, and 16 decoded-frame positions. Every source changed-pixel ratio is zero. Every decoded comparison between runs has zero mean RGB error. Decoded frames differ from their scheduled PNGs by a mean absolute RGB-channel error between `0.768958` and `1.016434`, on the 0–255 channel scale. These are image-error measurements, not performance claims.

That repeatability report is supplemental macOS evidence. T15 requires the same fixture twice in the pinned Linux environment. Linux must supply its own actual report with the final candidate digest and environment identity. The scripts and workflow definitions alone do not establish a platform pass.

Neither interim report proves the final integrated commit. The final handoff must bind the exact commit, candidate digest, script inputs, Linux result, macOS smoke, real-app results, and manual viewing evidence. Package-input changes require rebuilt candidate evidence. A completed final gate must not inherit an earlier report's pass label.

## Bounded limitations and accepted coverage

The decoded-frame comparator uses a full-image mean error below 3. A negative-control calculation using existing decoded frames showed that an `open` frame substituted for `ready` would pass at `1.022579`, and a `toggle` frame substituted for `saving` would pass at `1.355705`. The visually larger `ready` to `toggle` and `saving` to `hover` substitutions fail the threshold. This limits the claim that repeatability alone proves every boundary label. It does not demonstrate a current encoder defect. The separate media integration test checks known first, boundary, and final frames and rejects its wrong title/step alternative with a distinct error threshold. This review does not require a new image metric for T15.

The installed-package runner uses a fresh temporary installation, invokes the actual npm bin, rejects a shipped `src` directory and installed Vitest/TypeScript, and loads package modules from that installation. Creating fixtures with repository-side scripts does not make the CLI depend on source-tree modules. The existing smoke verifies real artifact hashes and saved-manifest agreement. It also verifies that browser-free recomposition preserves comparison outcomes and that a recovered encoder does not convert a partial capture into success.

The real-app script pins public source commit `fd4407ce0c26ede6b59fe11e21e207593629ae9a`, creates a recorded local style-change commit, and repeats the unsaved `/add-job` scenario three times. Its recorded limitations exclude form submission, the jobs backend, and any claim about an upstream release. That design satisfies the intended T17 scope if its final actual runs pass. This review did not run T17 or accept an uninspected real-app report. Copied run summaries retain their original local frame paths, so portable recomposition still needs the original run directories or copied frame directories.

The release audit's dependency inventory is separate from registry advisory queries. The security report documents separate `npm audit` results and requires final refresh. This review does not mistake the inventory's `passed` status for an advisory scan. Pattern-based scanning also explicitly excludes binary interpretation and cannot prove that every possible secret is absent.

## Follow-up verification

The integrator changed the scripts and requested independent reinspection. `/private/tmp/swc-release-review-followup.mjs` exited 0 under Node `24.22.2`. Its report is `/private/tmp/swc-review-fixed-VVpE3F/report.json`. That report also records SHA-256 identities for all five reviewed scripts.

The malformed archive now fails at `Missing packed file package/schema/capture.v1.json` before npm runs. The required-file list includes all seven emitted schemas, README, font provenance, license, notices, skill, executable, and font. The installed-file check parses each JSON schema and checks its object shape and version.

The actual audit script now returns exit 1 and `review-required` for the isolated synthetic-message repository. It reports one `git-history-commit` finding and one `git-history-tag` finding. The existing file-content scan remains active.

The new caller inventory detects an empty ignored dependency directory, dependency-file creation, content mutation, mode mutation, and removal. It records ignored symlink targets without following them and detects a target change. Separate checks confirmed that root tool output and unrelated Git-internal files stay excluded. These are executed negative controls against `sourceState`.

The reviewer inspected the added README command sequence and quickstart extraction. Both literal quickstart JSON examples also parse against the schema module from the previously installed interim candidate. The new runtime smoke uses the six-step scenario, expects four verified pairs, and tests default route planning followed by saved-plan WORKTREE comparison on a dirty fixture. The new browser execution remains integrator-owned and is not claimed by this lightweight review.

Patch inspection found one new integration dependency. `release-smoke.mjs` now reads `docs/quickstart.md`, while `scripts/linux-gate.mjs` initially omitted `docs` from its source archive. That archive would fail at the file read before running the smoke. The integrator corrected the archive list to include top-level `docs`. The reviewer then exercised the actual commit-mode path selection and `git archive` command against a disposable repository. The archive contains the exact quickstart bytes. The same snapshot-copy options also preserve that file. `/private/tmp/swc-review-fixed-VVpE3F/linux-archive-check.json` records both passing checks and the Linux script hash. This proves archive inclusion, not a complete Linux run.

## Review disposition

The three reproduced false acceptances are corrected and pass independent lightweight negative controls. The documentation command coverage is implemented and awaits the integrator's actual package run. The Linux archive dependency is corrected and independently checked. No additional demonstrated blocker remains within this review's scope. Full package/platform runs and final candidate identity remain integrator-owned.

Prove It Works changed this review from accepting green report labels to reading the real archive, Git-object scan, and report contents. Test Behavior, Not Implementation led to malformed-package, synthetic-message, and ignored-file mutation probes against the checks. Explain the Number led to preserving the decoded-image metric's scale and testing its wrong-frame sensitivity. Poteto-mode, Technical Writing, and Unslop shaped this report. The `how` and `no-comments` skills' nested-agent steps were omitted because the assigned review explicitly prohibited nested agents and script edits.
