# Verification environments

The [verification workflow](../.github/workflows/ci.yml) checks Node 24.22.2 and npm 11.12.1 on Ubuntu 24.04 and macOS 15. The action revisions are pinned to official checkout v7.0.1 and setup-node v7.1.0 commits, verified on 2 November 2026. Runner labels come from the [official runner image inventory](https://github.com/actions/runner-images).

The workflow installs the package's exact Playwright browser, checks types and generated schemas, runs unit and integration tests, then installs and exercises the actual npm tarball. Linux also compares two runs' masked source frames and decoded video frames. Linux builds lsof 4.99.7 from a checksum-pinned upstream archive with the shared installer. Media prerequisites are system packages, so each run records actual versions through doctor and manifests. The workflow is a validation definition, not evidence that a hosted run has passed.

The workflow uses read-only repository permissions and does not retain checkout credentials. It does not publish, upload recordings, change repository visibility, or require production credentials. It runs only synthetic fixtures. Logs report gate status. Generated media stays on the temporary runner; use the local commands below when preparing artifacts for owner review.

During this build, hosted CI was not started because the private repository's included usage allowance could not be verified. The local Linux gate provides separate platform evidence. Changing a repository to public, pushing code, or starting hosted runs remains an owner action subject to the build authorization.

## Reproduce the Linux gate

Read [the Linux environment instructions](../scripts/linux-gate/README.md) for exact base digests, browser revision, sandbox proof, resource limits, and optional isolated Lima setup. Use an explicit Docker endpoint if the default shared Docker VM is under memory pressure. Do not stop unrelated containers to make a gate pass.

Build and pack the exact candidate commit from the reviewed sanitized public checkout before invoking the gate. The runner's selected execution archive is separate from the complete public source release archive. Keep both identities in the candidate evidence.

```sh
npm ci --no-audit --no-fund
npm run build
mkdir -p /absolute/candidate-directory
npm pack --pack-destination /absolute/candidate-directory
SWC_CANDIDATE_COMMIT="$(git rev-parse HEAD)"
SWC_CANDIDATE_TARBALL=/absolute/candidate-directory/show-what-changed-0.1.0.tgz
SWC_CANDIDATE_SHA256="$(shasum -a 256 "$SWC_CANDIDATE_TARBALL" | cut -d ' ' -f 1)"
node scripts/linux-gate.mjs --release \
  --commit "$SWC_CANDIDATE_COMMIT" \
  --tarball "$SWC_CANDIDATE_TARBALL" \
  --tarball-sha256 "$SWC_CANDIDATE_SHA256" \
  --out /absolute/new-linux-evidence-directory
```

Use `sha256sum` instead of `shasum -a 256` when needed. A complete scripted Linux platform run must have `status: passed` and `platformChecksComplete: true`. Its `releaseGateComplete` stays false because independent G01 through G24 acceptance is separate. An interim snapshot, OOM kill, interrupted container, or missing installed-package test is not a passing platform result.

## Reproduce macOS and real-app gates

Use the same tarball digest on macOS. Run the [final installed checks](release-readiness.md#final-checks), including all six motion cases and normal-speed review. The smoke, public-app, and audit commands below are parts of that sequence.

```sh
node scripts/release-smoke.mjs "$SWC_CANDIDATE_TARBALL" /absolute/new-macos-evidence-directory
node scripts/real-app-smoke.mjs "$SWC_CANDIDATE_TARBALL" /absolute/new-real-app-evidence-directory
node scripts/release-audit.mjs "$SWC_CANDIDATE_TARBALL" /absolute/new-audit-evidence-directory
```

The public-app gate generates a redistributable pnpm workspace and records exact base and candidate commits. It repeats Workshop board navigation and invalid-form feedback comparisons three times each, then verifies a subsequent WORKTREE comparison. Its synthetic form submission exercises the local application's validation response. The report records exact commits, commands, outcomes, artifacts, and limits. Independent inner-scroll observations, decoded-media checks, and normal-speed review remain required by the [public acceptance contract](web-app-acceptance.md).

Final acceptance uses [release readiness](release-readiness.md), the exact candidate identities, and the [revision 0.3 gate ledger](../evidence/revision-0.3-status.json). Platform results remain separate from hosted CI status and publication approval.
