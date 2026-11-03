# Requirement evidence audit

The goal is a complete show-what-changed 0.1.0 candidate whose implementation, artifacts, and release claims satisfy the current specification. This audit maps the contract to actual source, tests, and evidence. It does not establish final release readiness.

The audit used the working tree over `b792378c5150faf147dd7f3396d2bec28142ab06` on macOS arm64 with Node `24.22.2`. Other owners continued implementation during review. The matrix retains the specification hash and stable requirement IDs. The audit cutoff is 2026-11-01 at 21:29 UTC, or 2026-11-02 at 04:29 Asia/Bangkok. No final commit or tarball was accepted by this audit.

Throughput checkpoint is a bounded contract review, focused reproductions, and generated mapping validation. The reviewer owns only this report and the two requirement matrix files. Disposable helper scripts and probes are under `/private/tmp`. No product implementation, fixture, test, shared release record, or memory file was changed by this reviewer.

## Matrix interpretation

The [JSON matrix](requirements.json) has 181 rows, including every acceptance ID from T01 through T17. Each row has clause-specific implementation paths, relevant tests, evidence links, and a note that describes the proof and its limits. Table headers and introductions remain present because the existing extractor assigns them IDs. Their notes identify them as structural rows.

The [readable matrix](requirements.md) shows the same states and evidence references. `node scripts/requirements.mjs` regenerates it and preserves JSON mappings by stable content ID. The generator stops after specification section 12. Requirements in the preamble, sections 13 and 14, and the build-goal document are accounted for separately below.

The states mean the following.

- `implemented_pending_final` means an implementation and relevant focused evidence exist. It is not a final acceptance pass, and the note may identify a remaining integration coverage limit.
- `pending` means a required correction, disposition, or release-preparation artifact is still being verified or prepared.
- `blocked` means required platform or final release evidence is unavailable at this cutoff. It does not mean the implementation is absent.

At this cutoff, 169 rows are `implemented_pending_final`, eight are `pending`, and four are `blocked`. No row is marked passed. The four blocked rows concern supported-platform proof, T15, T16, and the final release gate.

The paths in `code` identify the implementation or release procedure. A path in `tests` identifies a relevant executable case, not proof that every possible behavior in that file passed at the final candidate. Evidence reports retain their original baseline and limitations. Temporary evidence paths are local review artifacts and must be retained or copied into the final evidence bundle before relying on them for a durable handoff.

## Findings and dispositions

### C1 controls were accepted as application paths

The original `AppPathSchema` rejected C0 controls and DEL but accepted C1 controls. The direct built-schema probe accepted both `/route\u0085` and `/route\u009b`. Specification section 7 requires rejection of control characters. This was a reproduced input-validation mismatch, not an observed origin escape.

The integrator changed the schema exclusion to `\x7f-\x9f` and added runtime and generated-schema negative cases. This reviewer read the change and independently ran the focused suite.

```sh
PATH=/private/tmp/swc-toolchain/node_modules/.bin:$PATH \
  node node_modules/vitest/vitest.mjs run \
  test/unit/schema.test.ts test/unit/schema-json.test.ts --reporter=dot
```

The command exited 0 at 04:27:25 Asia/Bangkok. Both files passed all 50 tests. T01 and the application-path row are `implemented_pending_final`. The final candidate still needs its complete schema, CLI, and installed-package gates.

### Unsupported-source diagnostics omit the offending file

Specification section 5.1 requires an unsupported-source diagnostic to report the file and a supported alternative. A direct `preflightFiles` probe passed a Git LFS pointer at `assets/prohibited-lfs-pointer.txt`. The current built implementation returned exit 2 with this detail.

```json
{
  "code": "UNSUPPORTED_SOURCE_LAYOUT",
  "phase": "source",
  "message": "Git LFS pointer files are unsupported.",
  "hint": "Use one root npm package with a committed npm lockfile and regular files."
}
```

The rejection is safe, but it omits the offending path. Several `unsupported()` branches use the same class-only style. This is a diagnostic completeness finding. It does not establish unsafe execution or source corruption. The integrator received the reproduction. The section 5.1 row remains pending disposition at this cutoff.

### Integration coverage gaps have assigned follow-up

These are missing composed-behavior evidence, not proven bugs. The integrator accepted the following follow-up cases.

| Contract | Existing proof | Missing proof at cutoff | Follow-up owner |
| --- | --- | --- | --- |
| Exact merge-base rendering in T02 | Real Git tests resolve the unique base and reject zero or multiple bases. Materialization uses the pinned base OID. | An installed CLI comparison that actually renders the selected merge base. | Root is adding a packed-CLI smoke case. |
| Source mutation after capture in section 5.2 | Real installs detect changed or newly added source. `verify` detects new files on either side. Reducer/presentation tests represent invalid provenance. | A real CLI action causes a new nonignored source file, then returns partial media and exit 3 while preserving caller files. | Root is adding a provenance-capture integration fixture. |
| Automatic mixed coverage in section 6 | Table fixtures produce unresolved/omitted buckets. Reducer and presentation tests mark incomplete coverage. | A complete automatic CLI run returns partial media with those coverage gaps. | Root is adding a packed-CLI smoke case. |

The suite did not contain focused 20,000-path/200 MiB boundary fixtures, or an injected general workspace I/O failure classification case, at this cutoff. Their implementations are mapped and the limits are stated in the row notes. These are coverage observations, not claims that the guards or classifications fail. The LFS diagnostic above is the separately reproduced behavior finding.

## Existing proof and its limits

The audit read the N0 contracts, N1 isolation/runtime evidence, N2 recorder evidence, N3 media evidence, and their independent review dispositions. It also read the N4/N5, N6 gap, runtime finalization, ownership, and N7 documentation reports. Earlier fixed findings remain historical evidence. They are not converted into current defects merely because their original reproduction appears in a report.

[N6 gap evidence](N6-gap-audit.md) records all 17 cases in its file passing, including eight actual SIGINT/SIGTERM phase cases, the port bind race, terminal-write contention, shallow missing refs, and secret continuity through decoded video. [N6 runtime finalization](N6-runtime-finalization.md) records focused ownership behavior. [The independent ownership review](N6-ownership-independent.md) then found late cancellation and terminal-write failure interactions. The repair owner is actively changing finalization and has added `test/integration/terminal-cancellation.test.ts`. This audit does not accept that work as complete before its independent review and integrated rerun.

Two temporary reports were read directly.

| Report | Observed result | Scope limit |
| --- | --- | --- |
| `/private/tmp/swc-package-smoke-interim-02/report.json` | Passed on macOS with Node 24.22.2. Installed CLI exercised help, doctor, plan, missing consent, exact-commit success, partial comparison, WORKTREE, stale plan, browser-free compose, and encoding recovery. | Older candidate. It predates later ownership, cancellation, alias, schema, and release changes. |
| `/private/tmp/swc-repeatability-macos-interim-01/report.json` | Passed on macOS. It recorded 14 masked source-frame comparisons and 16 decoded-frame checks. | The required repeatability platform is pinned Linux. This report does not satisfy T15. |

Both reports identify tarball SHA-256 `efec9344c40b0830a827572e0ede610fd1d0676a3deee15e44c4225b871fc322`. The package report ran from 21:02:52 through 21:05:47 UTC. The repeatability report ran from 21:10:39 through 21:11:29 UTC. This audit treats those as interim proof only.

T16 remains blocked until the exact final tarball passes Linux full and macOS installed-package gates. [Linux diagnosis](Linux-diagnosis.md) records the failed environment attempt separately. The isolated Linux environment work is in progress. A working Docker definition, a successful build, or a macOS run cannot replace that platform result.

T17 has a concrete [real-app runner](../scripts/real-app-smoke.mjs). It pins `bradtraversy/react-crash-2024` commit `fd4407ce0c26ede6b59fe11e21e207593629ae9a`, uses the `/add-job` form without submission, and creates a disposable local presentation change. The npm alias preflight correction is present. No accepted three-consecutive-run report was available to this reviewer at cutoff.

## Release preparation beyond the acceptance table

The [README](../README.md), [quickstart](../docs/quickstart.md), [limitations](../docs/limitations.md), [security policy](../SECURITY.md), [contributing guide](../CONTRIBUTING.md), [publishing guide](../docs/publishing.md), and [generic skill](../skills/show-what-changed/SKILL.md) exist. [N7 documentation evidence](N7-docs.md) records example/schema/CLI/link/package checks. The final demo and exact tarball quickstart remain root-owned release work.

The initial missing `docs/ci.md` was reported and filled during this audit. The new [CI document](../docs/ci.md) and [workflow](../.github/workflows/ci.yml) define Node24 Linux/macOS checks, read-only repository permissions, nonpersistent checkout credentials, and explicit fixture execution. The workflow has no privileged `pull_request_target` path or publishing/upload step. No hosted execution result is claimed.

The declared repository layout names `test/package/`, while executable package checks live in `scripts/release-smoke.mjs` and `scripts/release-harness.mjs`. The matrix links the actual checks rather than inventing that directory. This is a location difference, not missing installed-package behavior.

The new [release audit script](../scripts/release-audit.mjs) reads exact dependency metadata and license files, scans candidate files, staged/index objects, all reachable Git-history blobs, and tarball entries. It records hashes and explicit dispositions without printing detected values. Its scan is pattern-based and does not interpret binary content. The integrator owns the accepted final report, dependency advisory output and triage, and any synthetic-canary disposition. Their existence was not inferred from a script definition.

MIT authored-code licensing, bundled OFL text, Inter provenance, direct dependency notices, package allowlist, executable entry point, generated schemas, and generic skill paths are present. Interim tarball inspection checks actual inclusion and excludes source, development dependencies, fixtures, and private logs. Final tarball inspection and exact dependency license evidence remain necessary after all package-input changes.

The publishing guide separates candidate preparation from public release and explains provenance requirements for the chosen hosting path. Registry E404 is an availability observation, not reservation. An unauthenticated npm owner check does not establish publishing identity. Final owner approval, login, or publishing second factor can remain handoff actions. Missing implementation, final tests, platform evidence, or tarball verification cannot.

## Requirements outside the generated 181 rows

| Source | Required behavior or process | Evidence and current state |
| --- | --- | --- |
| Spec preamble | Describe step-aligned keyframes in README, CLI help, generic skill, and manifest. | The four surfaces explicitly say keyframes. CLI help and manifest are exercised by the interim package smoke. |
| Spec section 13 | Freeze contracts before module work, use bounded repair loops, obtain independent review, and rerun integrated gates. | N0 contracts, per-node reports, and review dispositions exist. The final integrated gate is pending. Historical audit records remain intact. |
| Spec section 14 | Keep deferred features and architectural choices deferred. | Current CLI/schema/package inspection finds the scoped implementation. No model call, MCP adapter, continuous recorder, upload, or extra framework adapter is exposed. |
| Build goal prerequisites | Record start/deadline/spec hash and verify toolchain, repository/name access, and platform path early. | `evidence/build-start.json`, `evidence/prerequisites.md`, and `evidence/progress.md` exist. Linux result remains an unmet gate. |
| Build goal exact-candidate proof | Tie all final outputs, platform results, scans, and tarball SHA-256 to the final reviewed commit. | No accepted final identity exists at cutoff. Interim reports must not be relabeled as final. |
| Build goal owner handoff | Write an explicit readiness status and reviewable install/verify/publish commands without publishing. | `docs/release-readiness.md` remains `not_ready`; `docs/publishing.md` contains commands. The final concrete handoff is still pending. |

## Audit verification

The reviewer read the current specification and build goal, implementation graph and audit report, source modules, relevant test bodies, release scripts, per-node reports, and the two actual interim JSON reports. The reviewer ran only the two lightweight schema files. No additional full browser/platform run was launched during the environment work.

The matrix helper checked all 181 unique IDs, all T01-T17 IDs, and 1,344 implementation/test/evidence references. Every referenced path existed. The spec SHA-256 was `65f604f5ac2acad60e3bec0882b18f1bdc4ebfb3a51d3215f4396b6b1ec13ab8`. `scripts/requirements.mjs` preserved the exact JSON mappings on regeneration. Every Markdown row agreed with its JSON state. No row claimed a final pass. `git diff --check` passed for the three owned evidence files.

The Prove It Works principle changed this review from accepting module-owner summaries to reading actual tests/reports and reproducing the two schema/diagnostic findings. Poteto-mode, Technical Writing, and Unslop shaped the report. The `how` skill's nested delegation was not used because this was an assigned independent audit with disjoint evidence-file ownership.
