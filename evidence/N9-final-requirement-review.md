# Final requirement acceptance review

The complete show-what-changed 0.1.0 C2 candidate is accepted for owner review before publication. This review checks every mapped requirement and the obligations outside the generated matrix. All 173 substantive requirements pass; eight structural rows are reviewed. There are no open implementation or required release-evidence gaps. Public publication remains an owner action.

The replacement implementation commit is `927af366c3db101dc5875768432df20dba9e7675`. [Its identity record](artifacts/release-0.1.0-c2/identity.json) names the 261,943-byte archive with SHA-256 `6b01bd51d5e713b205d734c29ab948458d32635c7e8dbe5b163364f7bc5d6194`. The reviewer independently hashed that archive and compared all 120 packed regular files byte-for-byte with the current package inputs. There were no mismatches, unsafe paths, or nonregular entries.

The final source reports record typecheck, build, schema freshness, 221 unit tests, and 95 integration tests passing on each platform. Both installed-package gates pass all 18 command cases. The real-app report records three successful runs on the C2 digest. Linux repeatability, exact-candidate security, final media inspection, and the concrete owner handoff also pass. Platform evidence covers Node 24.22.2 on macOS arm64 and Linux arm64; hosted CI and other architectures were not executed.

The initial review identity is implementation commit `2ae52e9f30d0d0024519c76017dadf1dfbfba552`. Its tarball SHA-256 is `d8ab0f4c51dee78a8208b97667690cbcfb38a6955f67a36155608979ad588f86`. The reviewer directly checked both identities. This candidate is superseded for final acceptance because the findings below require product changes. Its passing reports remain evidence for their recorded identity.

The specification SHA-256 remains `65f604f5ac2acad60e3bec0882b18f1bdc4ebfb3a51d3215f4396b6b1ec13ab8`. No requirement, acceptance criterion, or test threshold was reduced. The reviewer owns only this report and `requirements.json` and `requirements.md`. Product files, scripts, fixtures, and other release records remain integrator-owned. No full browser run, Git mutation, public action, or nested agent was launched by this review.

The review used the prior clause-by-clause mapping, direct checks of actual reports and hashes, and lightweight probes of gaps identified in the previous audit. The reviewer read the final Linux, macOS, real-app, security, media, and handoff records. Requirement coverage depends on the mapped assertions and static review, not the aggregate test count alone.

## Evidence already inspected

The current C2 reports are separate from the superseded initial reports below.

| Final candidate record | Observed result |
| --- | --- |
| [macOS source execution](artifacts/release-0.1.0-c2/macos-source/report.json) | Five recorded commands exit 0. Unit log records 221 passing cases in 15 files. Integration log records 95 passing cases in seven files. |
| [macOS installed package](artifacts/release-0.1.0-c2/macos-package/report.json) | All 18 command cases have expected exit codes on Node 24.22.2, macOS arm64, and the C2 archive digest. All 120 package entries were inspected. |
| [Linux full gate](artifacts/linux-final-02/result.json) and [validation](artifacts/linux-final-02/validation.json) | Exact C2 implementation and archive. `releaseGateComplete: true`; all 11 stages exit 0 without signals or OOM. It records 221 unit and 95 integration cases and all 18 installed-package commands. |
| [Linux repeatability](artifacts/linux-final-02/repeatability/report.json) | Two actual compares pass in the same pinned environment. All 14 source-image comparisons meet the 0.001 bound; all 16 decoded-frame comparisons meet the stated lossy tolerance. |
| [Linux capability probes](artifacts/linux-c2-capabilities/report.json) | The installed C2 binary rejects lsof 4.95 with exit 8 before preparation and execution. Source, worktrees, and owned cleanup remain intact. Doctor accepts recognized upstream lsof 4.99.7. |
| [Real app](artifacts/release-0.1.0-c2/real-app/report.json) | Three consecutive successful runs use the C2 digest and exact public source and local synthetic-change commits. |
| [Security and licenses](artifacts/security-final-02/report.json) | Exact C2 commit and archive. It records all 97 dependency entries, notices for each of seven runtime packages, 868 scanned entries, seven matches of two exact synthetic canaries, and no unresolved finding. |
| [All-dependency advisory query](security/npm-audit-all-final.json) and [runtime query](security/npm-audit-runtime-final.json) | Both queries report zero advisories at every severity. The actual lockfile SHA-256 matches the security record. These are time-scoped registry results. |
| [Final decoded media review](N8-media-review.md) | The integrator directly viewed each segment's initial decoded frame and the final frame of both new C2 MP4s. It records 16 actual frame inspections, complete labels, masks, expected absence, hover, and visibly incomplete states. It does not claim continuous playback was watched. |
| [Owner handoff](../docs/release-readiness.md) and [publishing instructions](../docs/publishing.md) | Exact version, implementation commit, archive hash, installation and verification commands, publishing commands, limits, and remaining owner actions are concrete and reviewed. |

The Linux run completed at `2026-11-01T22:16:39.261Z`. Its source archive SHA-256 is `2bb65ad6ea939b3d6ea304484857ad2e69ae6872ea8c75849320b3c402c0388c`. The recorded image is `sha256:c62eeb3aa1502cc9ec7071f8db8f14efdf66ade983e474eb319c14b503423432`. [Sandbox evidence](artifacts/linux-final-02/sandbox.json) records UID 1001, Playwright 1.64.1, Chromium 156.0.8078.4 revision 1248, an enabled Chromium sandbox, a separate renderer user namespace, seccomp mode 2, and no-new-privileges. This is an actual local Linux VM run, not a hosted-CI claim.

The repeatability fixture contains seven steps and produces 14 source-image pairs. Thirteen ratios are zero; the AFTER ready-state pair differs by 182 of 1,024,000 pixels, a ratio of 0.000177734375 below 0.001. This is isolated small variance, with no established systematic cause. Sixteen decoded positions have maximum mean RGB differences of 0.01821398202137998 between runs and 2.036029114026563 against scheduled PNGs, below 3 on a 0–255 scale. MP4 byte equality is not asserted. This fixture's 198-frame timeline is distinct from the six-step quickstart demo's 174 frames.

The 868 scanned entries comprise 238 candidate files, 238 index entries, 269 reachable history blobs, three commits, and 120 tarball files. No annotated tag exists in this history. The scanner's tag-message behavior has a separate negative-control test. Binary content is hashed rather than semantically interpreted, so the scan does not claim to detect every possible secret.

The reviewer separately compared all 25 public files in each `docs/demo/` example with the corresponding C2 installed-package output. Both copies match exactly. Runtime schemas accept the manifests, captures, and timelines. Every public artifact and composed-image hash and byte size matches. Both timelines contain 174 frames. The success example reports four verified pairs, one expected absence, one exclusion, and exit 0. The partial example reports one failed BEFORE step, three blocked steps, null unverified metrics, and exit 3. The inspected MP4 SHA-256 values are `706563d3d54cfc561e35792eb7b79dbd61a59daac6b93e42a339cb4614c6ea4c` and `83d97ed39bee98c57bd5bd594a8a6d9547f74ebfe2aeb3cb3014670efe46f291`.

The following records preserve the initial candidate and focused-review history.

| Evidence | Observed result | Acceptance scope |
| --- | --- | --- |
| `/private/tmp/swc-macos-integrated-04/` | Strict typecheck, build, generated-schema check, and all 282 tests in 20 files passed. | Current source before the final diagnostic corrections. Test bodies and mapped requirement coverage remain separate from the total. |
| `/private/tmp/swc-package-smoke-interim-05/report.json` | Passed on macOS arm64 with Node 24.22.2 and the initial review tarball digest. | Actual installed binary ran 18 command cases. Includes exact quickstart JSON, saved-plan WORKTREE README path, exact commit comparison, actual merge-base rendering, automatic incomplete coverage, missing consent, stale plans, browser-free re-encoding, and encoder recovery that retains partial capture. |
| `/private/tmp/swc-real-app-candidate-04/report.json` | Three consecutive successful runs on the same archive digest. | Public React Jobs app at `fd4407ce0c26ede6b59fe11e21e207593629ae9a`, local presentation-change commit `afa2a41b8c90ed2ec77588f131a4cf90d6525b27`, and unsaved `/add-job` state. Each run records five verified pairs. No submission or jobs backend is claimed. |
| [Terminal review](N6-terminal-final-review.md) | Four independent real-CLI signal and write-failure probes passed. | Returned JSON, saved manifest, local PR text, retained or released ownership, and cleanup were compared directly. Reviewed source hashes match the initial frozen implementation. |
| [Browser deadline correction](N6-browser-deadline.md) | Original failure reproduced, corrected process ownership guard passed focused macOS and Linux checks. | Actual context cleanup completes before the adopted browser is stopped. The corrected implementation also passes the final C2 source suites and full Linux gate. |
| [Release-check review](N9-release-check-review.md) | Negative controls now reject missing schemas, find synthetic Git-message secrets, and detect ignored filesystem mutations. | The full-history scan and package/source-preservation checks are themselves tested. New quickstart and README runtime assertions are present in the inspected package-smoke report. |

The source-preservation helper inventories ignored files, directories, modes, and symlink identities without following links. It excludes only intentional root tool output and Git internals. The package runner requires all seven emitted schemas, executable, skill, README, font provenance, font, and notices. These checks support the meaning of the actual package and real-app reports.

## Corrections identified by this review

### Measured source-size diagnostics, corrected

Specification section 5.2 requires an over-limit snapshot to report the measured count or size. The initial built `readSourceFile` rejects a canonical disposable regular file of 209,715,201 bytes with `UNSUPPORTED_SOURCE_LAYOUT`, but its message only says that `oversized.bin` is not a bounded regular file. The measured size and 209,715,200-byte bound are absent. The WORKTREE aggregate overflow branch also omits the actual accumulated size. The integrator accepted this correction.

The lightweight probe separately verified acceptance at 20,000 inventory entries and 209,715,200 inventory bytes. It verified rejection with measured values at 20,001 entries and 209,715,201 inventory bytes. Those inventory branches already satisfy their diagnostic requirement. The file probe used a sparse temporary file and did not allocate a 200 MiB buffer. Its first noncanonical temporary path hit the expected symlink-ancestor protection. The repeated canonical-path probe established the size-diagnostic finding.

The C2 built-module probe now returns `SOURCE_LIMIT`, exit 2, with both 209,715,201 actual bytes and the 209,715,200-byte limit. [The final source correction record](N1-final-source-diagnostics.md) and its 60 passing source tests also cover actual aggregate disk overflow, a later eligible file, exact boundaries, and escaped committed-entry filenames. Aggregate early-cutoff messages say that at least the reported byte count was measured.

### Unsupported committed source entry diagnostics, corrected

Specification section 5.1 requires the offending file and a supported alternative. The fixed LFS path diagnostic passes a direct built-module probe. The initial `readTree` implementation still rejected a selected commit's symlink, submodule, or nonregular entry with a class-only message. The correction includes the JSON-quoted relative filename. Actual committed-symlink and committed-submodule fixtures with spaces and newlines pass in the full source suite. Malformed tree records retain a separate integrity diagnostic.

### Workspace operational error classification, corrected

Specification section 10 assigns workspace or installation failure exit 5. The initial runner normalizes raw `EACCES`, `ENOSPC`, and `EIO` errors during `preparing` as `INTERNAL_ERROR` exit 1. Direct built-module probes reproduced that result. Source inspection confirms that operational failures from workspace materialization can reach this boundary. A Git worktree operation's typed `GIT_FAILED` likewise retains exit 2. These probes establish the classification behavior, not a full injected workspace execution.

The correction distinguishes operational workspace failures from invalid source, stale input, cancellation, and unexpected programming defects. [The workspace correction](N1-workspace-error-classification.md) records 16 actual source-CLI probes plus eight existing snapshot cases passing. The narrow wrapper maps native filesystem errors and failed worktree mutations to exit 5. Inspection failure remains 2, missing Git remains 8, unexpected defects remain 1, and cancellation retains its code. The reviewer read the implementation and all new case assertions. These are controlled failure injections through a real CLI, not unrestricted real disk-exhaustion tests.

[Independent correction review](N9-final-corrections-review.md) passed all 60 source cases and 16 workspace CLI probes. Its aggregate lower-bound wording finding was corrected and the focused tests rerun. The replacement full macOS source gate includes all 16 CLI probes and the corrected source cases.

Raw baseline lightweight results are in `/private/tmp/swc-final-requirement-probes.json`. Passing exact-C2 lightweight checks are in `/private/tmp/swc-final-c2-probes.json`. Rows `S5.1-36ad9973b4`, `S5.2-97ebc51dc2`, and `S10-b46885f780` pass on the combination of inspected implementation, direct probes, relevant assertions, and successful final platform execution.

## Linux environment finding

[The historical C1 Linux result](artifacts/linux-final-01/result.json) passed 203 unit tests and 79 integration tests, but its installed-package and repeatability stages failed. Its `releaseGateComplete` remains false. The AFTER server reported readiness promptly, while socket ownership inspection did not find its listener. The recorded cgroup counters show no OOM event. [The final platform report](Linux-final.md) distinguishes this failed candidate from passing C2.

The Linux owner reproduced a system `lsof` 4.95.0 process-name parser failure with a minimal listener. The affected Next.js process name contains an unbalanced opening parenthesis after Linux COMM truncation. This diagnosis did not establish platform acceptance; the corrected pinned environment and complete C2 rerun did.

The initial setup documentation did not identify the working Linux prerequisite. C2 now requires recognized upstream Linux lsof 4.99.7 or newer in both doctor and compare before preparation. README, quickstart, CI, and the shared pinned installer agree. [Independent prerequisite review](N9-lsof-prerequisite-review.md) checked the source archive, license, helper and caller behavior, actual version output, and 13 focused tests. Missing lsof uses the same actionable setup guidance. The prerequisite does not replace live ownership and loopback checks. The actual C2 old-version rejection probe and successful full gate are independently recorded above.

## Previously pending findings

C1 application-path controls now reject in both runtime and generated schemas. The reviewer repeated direct checks for U+0085 and U+009B against the frozen built schema. The focused tests also run in the integrated source suite.

The LFS diagnostic now includes the offending relative filename and a supported alternative without printing its contents. The direct probe passed. The selected-commit entry diagnostic was separately corrected and verified above.

The post-capture provenance fixture drives a real CLI action that creates a new source file only in the AFTER workspace. It verifies exit 3, valid media, invalid AFTER provenance, unchanged caller files and index, matching returned and saved manifests, artifact hashes, and no remaining owned process groups. The complete source suite includes this fixture.

The package smoke renders the selected merge base. It compares pinned identities, materialized hashes, three verified pairs, and zero source-image ratios. The automatic mixed-coverage case returns exit 3 despite successful capture, records its unresolved source, and counts coverage omissions. Both final C2 installed gates execute these assertions. Earlier focused saved-plan caller-HEAD movement evidence remains scoped to its original run; the relevant planner code is unchanged in C2, whose installed gate exercises explicit endpoints and saved WORKTREE plans.

## Obligations outside the generated matrix

| Contract | Accepted evidence and scope |
| --- | --- |
| Specification preamble | README, CLI help, generic skill, and manifest describe step-aligned keyframes. Saved media and runtime latency are not described as a continuous recording or performance comparison. |
| Specification section 13 | N0 contract freeze, node reports, independent reviews, reproduced defects, corrected probes, and final integrated reruns exist. [N6](N6.md), [N7](N7.md), [N8](N8.md), and [N9](N9.md) bind final behavior and handoff to C2. Historical reports stay intact. |
| Specification section 14 | Current CLI, schemas, dependency metadata, and source preserve the stated deferred scope. No model client, MCP adapter, uploader, continuous recorder, extra framework adapter, or cache is exposed. |
| Build-goal prerequisites | `build-start.json` records UTC and Bangkok start and deadline, plus the unchanged starting spec hash. Prerequisites were recorded eight minutes after start. Private repository access and a local Linux path were checked without publication. |
| Build-goal checkpoints | Actual success and partial runs, installed-package evidence, and complete final platform checks finished before the mandatory hour-12 and hour-18 checkpoints. The final Linux gate ended about 2 hours 17 minutes after the recorded start. Acceptance rests on completed gates, not elapsed time. |
| Build-goal complete verification | C2 strict typecheck, build, schema determinism, both source suites, both installed-package gates, pinned Linux repeatability, and three real-app runs pass. No lint or formatting command is configured. Actual platform and external-app limits remain explicit. |
| Build-goal media review | The integrator directly inspected all unique displayed segments and final frames of both exact C2 MP4s, 16 decoded images total. [The media record](N8-media-review.md) identifies hashes, visible labels, masks, expected absence, and incomplete states. Frame timing and encoded properties are separately checked. Continuous playback was not claimed. |
| Build-goal security and packaging | C2 worktree, index, complete reachable-history and tarball scans pass with only two exact synthetic canaries. Exact-lockfile all/runtime advisory queries have zero findings. Dependency licenses and all 120 package files are inspected. The integrator's final docs-only handoff scan will additionally cover the completed evidence edits. |
| Build-goal owner handoff | [Release readiness](../docs/release-readiness.md) and [publishing instructions](../docs/publishing.md) name exact version, implementation commit, archive hash, evidence, limits, and concrete install, verify, and publish commands. The readiness status can now reflect this acceptance. Public publication remains unauthorized. |

The publishing guide distinguishes local owner publication without provenance from a separately authorized public hosted provenance path. Final owner approval, registry login, and required publishing second factor may remain owner actions. Missing implementation or release evidence may not.

## Acceptance state

The matrix retains all 181 stable rows and all T01 through T17. Its code and test mappings were reviewed against the unchanged specification and prior full audit. The final disposition is 173 substantive rows `passed`, eight structural rows `reviewed`, and zero blocked or pending rows. The structural rows are table headers or introductory contract text, not eight unexecuted behavioral requirements.

`passed` means the requirement is supported by its mapped implementation, relevant test assertions or static review, and applicable final execution evidence. It does not mean every row is a distinct test or that every historical focused probe was rerun. Final source and installed evidence is attached per row where applicable. Static scope, documentation, and publication-boundary requirements are accepted by inspection. The final JSON and Markdown matrix agree, mapped paths resolve, and regenerated IDs, source lines, and requirement text match the unchanged spec.

C2 is accepted as a complete publishing-ready candidate. The remaining integrator actions are the docs-only handoff commit, final handoff-history scan, and confirmation that a fresh pack remains byte-identical. These cannot change the tested package inputs without reopening acceptance. Registry login, required second factor, repository publication, public upload, and provenance-backed publication remain explicit owner actions.

Prove It Works changed this review from accepting report labels to checking identities, hashes, implementation branches, and actual probe output. Explain the Number kept total test counts separate from requirement coverage and kept earlier candidate results tied to their own bytes. Poteto-mode, Technical Writing, and Unslop shaped this report. Nested delegation and broad execution were omitted under the assigned review scope.
