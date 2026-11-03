# Installed-package Docker compatibility runner

Status. Implemented and checked with pure tests and a local mock daemon. Real installed-package Docker acceptance is pending. This document does not certify G04, the final candidate, or the full release gate.

## Scope and choice

`scripts/compatibility-smoke.mjs` now has three explicit modes.

| Invocation | Selected rows | Matrix rows still pending after success |
| --- | --- | --- |
| `node scripts/compatibility-smoke.mjs candidate.tgz output-directory` | Static, npm, pnpm workspace, Python | Docker |
| `node scripts/compatibility-smoke.mjs --docker candidate.tgz output-directory` | All five rows | None |
| `node scripts/compatibility-smoke.mjs --docker-only candidate.tgz output-directory` | Docker | All four host rows |

Every mode retains `gateComplete: false` and a separate pending release-acceptance statement. Failed rows remain pending. The flags belong to this verification script. They add no product CLI flags.

The named data shape is a compatibility profile. One registry binds the application name, source file, reviewed original text, and replacement text. A single row runner owns planning, comparison, preservation, cleanup inspection, and evidence export. Keeping Docker in this registry preserves the host path and avoids a second acceptance implementation.

## Recorded behavior

The runner installs the supplied tarball into a fresh owned tool directory with `installCandidate`. The installed binary runs doctor, plans the exact fixture commits and scenario, and compares the saved plan with explicit execution consent. Docker mode requires available Docker Engine and buildx capabilities before preparing a comparison.

The Docker profile copies only the redistributable fixture. Its baseline and head differ only in `index.html`, replacing `<h1>Container source</h1>` with `<h1>Updated container source</h1>`. The fixture recipe uses immutable public BusyBox and PostgreSQL image digests. The report records the MIT license digest, source commits, changed-file hashes, raw configuration and scenario hashes, normalized plan digests, runtime versions, actual command exits, and copied media hashes.

Each Docker row generates new synthetic `SWC_FIXTURE_DB_PASSWORD` and `SWC_FIXTURE_LOG_CANARY` values. It passes both values to the installed CLI and `verifyArtifacts`. Caller-supplied values for these two names do not select the fixture credentials. Public evidence records only the variable names. Raw install and CLI results remain inside the owned temporary directory, which has restrictive temporary-directory permissions. The report identifies that directory by its generated basename rather than an absolute path.

The row preserves a staged modification, a separate unstaged modification, an untracked file, and an ignored dependency sentinel. `sourceState` compares the complete caller inventory, file modes, index digest, HEAD, existing dependencies, and Git worktree list before and after execution.

Independent cleanup runs in `finally`, including after comparison or artifact verification fails. It inspects only newly established run directories. `assertNoOwnedActivity` checks both execution and Docker-cleanup process ledgers and calls `assertNoDockerResidue` for exact registered Engine identities. A completed Docker comparison requires two process ledgers and a nonzero Docker identity inspection count. Temporary comparison workspaces must also be absent. No prefix-based deletion or Docker mutation is added by this script.

Public artifacts are copied only after artifact, redaction, preservation, and cleanup checks pass. The output excludes private logs and Docker ledgers. Failures expose fixed stage codes and actual exits without raw exception messages, stacks, environment values, or absolute working directories.

## Focused verification

The following checks passed on 3 November 2026.

| Check | Actual exit | Observed result |
| --- | --- | --- |
| `node --version` | 0 | The default test shell reported `v25.9.0` |
| `node --check scripts/compatibility-smoke.mjs` | 0 | Valid module syntax |
| `node --check test/unit/compatibility-smoke.test.mjs` | 0 | Valid test syntax |
| `node scripts/compatibility-smoke.mjs --invalid candidate.tgz output` | 2 | Rejected the unknown option with the fixed usage text |
| `npx vitest run test/unit/compatibility-smoke.test.mjs test/unit/runtime-docker-fixture.test.ts --maxWorkers=1` | 0 | Two files and 17 tests passed under Vitest 5.0.5 |
| `git diff --check` | 0 | No tracked-diff whitespace errors |

The compatibility suite covers mode selection, the exact committed Docker source change, synthetic bindings, normalized public reports, artifact export, caller mutation, failed comparisons, failed artifact verification, missing cleanup ledgers, empty Docker inspection coverage, and unavailable Docker capabilities. Three cases use the actual release artifact verifier and independent cleanup helper with a local mock UNIX-socket daemon. They prove exact GET-only identity inspection and rejection of either synthetic canary in public metadata. Their minimal schema adapters do not constitute installed-candidate schema acceptance.

The first socket checks could not open a local UNIX socket under the host sandbox. The same focused command passed with local-socket permission. No real Docker daemon, image pull, build, application container, browser, or FFmpeg workload ran for these checks.

The focused tests mock candidate installation. Their test-shell Node version does not satisfy the product's Node 24 prerequisite. The real installed comparison must use a supported Node 24 executable, which `installCandidate` checks before installation.

## Throughput checkpoint

- Blocking first steps were the current execution contract, Docker fixture, installed-package helper, and exact residue inspector.
- Independent workstreams remain with the coordinator. This owner changed only the compatibility script, its focused test, and this evidence file.
- Shared mutable state was avoided through a fresh tool directory, a separate fixture repository per row, generated per-row values, and exact recorded identities.
- The smallest safe decomposition was one row runner and one profile registry. The coordinator owns the real heavy-resource acceptance window and independent review.

Model the Domain shaped the shared profile registry. Build the Lever shaped the repeatable installed-package command. Test Behavior, Not Implementation shaped the observed report, preservation, and failure checks. Prove It Works keeps the passing mock checks separate from pending real acceptance.

## Remaining real acceptance

Run the exact final package during the coordinator's bounded Docker window.

```sh
node scripts/compatibility-smoke.mjs --docker-only candidate.tgz docker-output
```

Use Node 24 and a new output directory. Record the actual final tarball SHA-256. Inspect the declared fixture-only execution bounds and resource ownership during the run. Require a changed motion comparison, distinct backing-service container identities, passing redaction, unchanged caller state, both process ledgers, exact absent Engine identities, and absent temporary workspaces. Review the copied recording at normal playback speed.

Re-run the affected matrix rows after candidate inputs change. Final platform checks, required repeated motion runs, representative public-app scenarios, independent review, privacy and security scans, exact candidate binding, and the publishing handoff remain separate release requirements. The script never marks those requirements complete.
