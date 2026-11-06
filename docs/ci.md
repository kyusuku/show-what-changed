# Verification environments

The [verification workflow](../.github/workflows/ci.yml) checks Node 24.22.2 and npm 11.12.1 on Ubuntu 24.04 and macOS 15 Intel. The action revisions are pinned to official checkout v7.0.1 and setup-node v7.1.0 commits, verified on 2 November 2026. Runner labels come from the [official runner image inventory](https://github.com/actions/runner-images).

The [7 November diagnostic run](https://github.com/kyusuku/show-what-changed/actions/runs/42267379310) could not acquire a macOS ARM runner within GitHub's queue limit. Its Mac job was cancelled before any test ran. Hosted verification now uses the standard `macos-15-intel` runner with the same checks. The required local Mac release workload retains its recorded Apple Silicon host and exact archive identity.

Both runners install the package's exact Playwright browser, check types and generated schemas, run source, contract, privacy, and integration tests, then install and exercise the actual npm tarball. Both retain installed host-recipe and release-audit checks. Linux also runs the complete six-case synthetic motion verifier, the seven public-app comparisons, and masked-source and decoded-video repeatability checks. Linux builds lsof 4.99.7 from a checksum-pinned upstream archive with the shared installer. Media prerequisites are system packages, so each run records actual versions through doctor and manifests. The workflow is a validation definition, not evidence that a hosted run has passed.

Hosted macOS skips the entire synthetic motion step and the entire public-app comparison step. Their source and decoded masks, clocks, pulses, scrolling, application feedback, encoding, decoding, preservation, and cleanup checks remain mandatory on local macOS for the exact release archive. The complete verifiers and thresholds are unchanged. Green hosted CI alone does not accept either Mac motion quality or the Mac public-app gate.

Mac regressions in these two workloads are checked at release time. Hosted pull requests do not run those workloads on Mac.

The workflow uses read-only repository permissions and does not retain checkout credentials. It does not publish, upload recordings, change repository visibility, or require production credentials. It runs only synthetic fixtures. Logs report gate status. Generated media stays on the temporary runner; use the local commands below when preparing artifacts for owner review.

Before the 5 November 2026 publication, the private-repository handoff recorded that hosted CI had not started because its included usage allowance could not be verified. That statement is historical. The [5 November hosted run](https://github.com/kyusuku/show-what-changed/actions/runs/42001878199) passed every Linux stage. Its Mac job failed the first synthetic motion case with 42 moving-object positions against the required 60, so its later host-recipe, public-app, and audit steps did not run. A separate [exact-package Mac diagnostic](https://github.com/kyusuku/show-what-changed/actions/runs/42004975241) failed with 54 positions in the required interval and 58 over the whole track. The causes remain unknown. This workflow change does not claim a runtime fix. Read hosted outcomes from their exact runs.

The exact published archive passed a fresh complete local Mac motion matrix on 5 November 2026. All six videos passed full decoding and uninterrupted normal-speed playback. Root inspected 36 chronological samples. The [sanitized verification record](../evidence/revision-0.3/publication-macos-motion.json) binds the archive, installed files, reports, media, actual host, and review limits. This local result does not erase the hosted failures or establish their cause.

During 0.1.1 preparation, [run 42021229429](https://github.com/kyusuku/show-what-changed/actions/runs/42021229429) passed every Linux stage. Its Mac public-app step failed without retaining a detailed report. In [run 42025632325](https://github.com/kyusuku/show-what-changed/actions/runs/42025632325), the Mac public-app step failed with `CAPTURE_CLOCK_DRIFT`. Two recorded browser round trips took about 127 and 137 ms. Their conservative mapping error bounds exceeded the unchanged 40 ms limit. The samples do not prove physical clock drift or explain the slow responses. The caller was preserved and owned cleanup passed. These runs remain failed Mac results. The earlier failure's cause remains unknown.

The exact 0.1.1 archive passed six complete synthetic motion cases and seven public-app comparisons on the recorded shared Apple M5 Mac running macOS 27. All thirteen videos passed decoding and uninterrupted normal-speed playback. Root inspected 78 chronological samples. The release assets retain the archive and report hashes, host details, unchanged-fixture DOM association, and sampled-review limits. This local acceptance does not establish equivalent hosted-runner behavior. The verification allocation changes no recorder behavior or timing bound. A fresh run of the amended hosted workflow must still pass every enabled check, including the Mac release audit.

## Reproduce the Linux gate

Read [the Linux environment instructions](../scripts/linux-gate/README.md) for exact base digests, browser revision, sandbox proof, resource limits, and optional isolated Lima setup. Use an explicit Docker endpoint if the default shared Docker VM is under memory pressure. Do not stop unrelated containers to make a gate pass.

Build and pack the exact candidate commit from the reviewed sanitized public checkout before invoking the gate. The runner's selected execution archive is separate from the complete public source release archive. Keep both identities in the candidate evidence.

```sh
npm ci --no-audit --no-fund
npm run build
mkdir -p /absolute/candidate-directory
npm pack --pack-destination /absolute/candidate-directory
SWC_CANDIDATE_COMMIT="$(git rev-parse HEAD)"
SWC_CANDIDATE_TARBALL=/absolute/candidate-directory/show-what-changed-0.1.2.tgz
SWC_CANDIDATE_SHA256="$(shasum -a 256 "$SWC_CANDIDATE_TARBALL" | cut -d ' ' -f 1)"
node scripts/linux-gate.mjs --release \
  --commit "$SWC_CANDIDATE_COMMIT" \
  --tarball "$SWC_CANDIDATE_TARBALL" \
  --tarball-sha256 "$SWC_CANDIDATE_SHA256" \
  --out /absolute/new-linux-evidence-directory
```

Use `sha256sum` instead of `shasum -a 256` when needed. A complete scripted Linux platform run must have `status: passed` and `platformChecksComplete: true`. Its `releaseGateComplete` stays false because independent G01 through G24 acceptance is separate. An interim snapshot, OOM kill, interrupted container, or missing installed-package test is not a passing platform result.

## Run the mandatory local macOS release gate

Use the exact reviewed tarball on macOS with Node `24.22.2` and npm `11.12.1`. Read its approved SHA-256 from the release identity. Run the [final installed checks](release-readiness.md#final-checks) for the same archive. Both the complete synthetic motion matrix and the complete public-app comparison matrix are mandatory. The following commands bind them to the selected archive and fresh installation.

```sh
set -eu
SWC_CANDIDATE_TARBALL=/absolute/path/show-what-changed-0.1.2.tgz
SWC_CANDIDATE_SHA256='read-approved-package-sha256-from-release-identity'
SWC_MAC_EVIDENCE=/absolute/new-macos-evidence-directory
test "$(shasum -a 256 "$SWC_CANDIDATE_TARBALL" | cut -d ' ' -f 1)" = "$SWC_CANDIDATE_SHA256"
node scripts/release-smoke.mjs "$SWC_CANDIDATE_TARBALL" "$SWC_MAC_EVIDENCE/package-smoke"
SWC_INSTALLED_ROOT="$(node --input-type=module -e 'import assert from "node:assert/strict"; import {readFileSync} from "node:fs"; import {join} from "node:path"; const report = JSON.parse(readFileSync(process.argv[1], "utf8")); assert.equal(report.status, "passed"); assert.equal(report.candidate.sha256, process.argv[2]); process.stdout.write(join(report.root, "installed/node_modules/show-what-changed"));' "$SWC_MAC_EVIDENCE/package-smoke/report.json" "$SWC_CANDIDATE_SHA256")"
node scripts/revision-0.3-motion-check.mjs --installed-root "$SWC_INSTALLED_ROOT" --output-dir "$SWC_MAC_EVIDENCE/installed-motion"
node scripts/real-app-smoke.mjs "$SWC_CANDIDATE_TARBALL" "$SWC_MAC_EVIDENCE/public-app"
node --input-type=module -e 'import assert from "node:assert/strict"; import {readFileSync} from "node:fs"; const report = JSON.parse(readFileSync(process.argv[1], "utf8")); assert.equal(report.status, "passed"); assert.equal(report.candidate.sha256, process.argv[2]); assert.equal(report.runs.length, 7);' "$SWC_MAC_EVIDENCE/public-app/report.json" "$SWC_CANDIDATE_SHA256"
node scripts/release-audit.mjs "$SWC_CANDIDATE_TARBALL" /absolute/new-audit-evidence-directory
```

The motion verifier must report `numeric-passed` and `completeRepetitionMatrix: true`. It runs three repetitions at each viewport, `1280x800` and `390x844`, for six cases. Do not reduce the repetition count. Each case must pass the unchanged source-frame, mask, clock, pulse, native-transition, inner-scroll, full encode and decode, decoded-mask, and owned-cleanup checks. The existing thresholds remain 60 distinct source and decoded moving-object positions per side, a maximum 200 ms known-moving source gap, three source and decoded pulses, 80 ms pulse alignment, and a 40 ms source-clock error bound.

Review every resulting `compare.mp4` at normal speed. Record stalls, invented motion, masking, and perceptual quality separately from numerical success. Retain all results, including failures, with the archive digest, installed-package identity, report and media hashes, and the review result. Include a sanitized summary bound to those hashes in the public release evidence. Record the actual Mac hardware, macOS version, available cores, memory, and concurrent workload. Preserve the verifier's per-case load averages. A pass describes that host and workload. It does not establish an isolated host or guarantee capture cadence on all hardware.

The public-app gate generates a redistributable pnpm workspace and records exact base and candidate commits. It repeats Workshop board navigation and invalid-form feedback comparisons three times each, then verifies a subsequent WORKTREE comparison. Its synthetic form submission exercises the local application's validation response. The report records exact commits, commands, outcomes, artifacts, and limits. Its `acceptanceComplete: false` field leaves independent inner-scroll observations, decoded-media checks, and normal-speed review to the separate [public acceptance contract](web-app-acceptance.md). Bind those observations to the exact fixture and archive. A source-fixture DOM observation remains source-fixture evidence even when its unchanged inputs match the installed runs. Record the separate acceptance in the final release verification manifest.

Final acceptance uses [release readiness](release-readiness.md), the exact candidate identities, and the [revision 0.3 gate ledger](../evidence/revision-0.3-status.json). Platform results remain separate from hosted CI status and publication approval.
