# Revision 0.3 release readiness

The `0.1.1` package archive has SHA-256 `ff08c0ee2aec5bd9a344f8f2300260f45c531da504f496cb016239c93de32846`. This identifies its bytes, not release approval. Check [GitHub releases](https://github.com/kyusuku/show-what-changed/releases) and [npm](https://www.npmjs.com/package/show-what-changed) for current publication status. Final approval and verification records accompany the release assets.

The dated records below preserve preparation and verification checkpoints. Their pending states describe those checkpoints, not the current registry or release-page state.

Patch preparation checkpoint, 5 November 2026. A controlled real-browser test found that published `0.1.0` can omit a static page update when an earlier frame is still being masked. The `0.1.1` candidate enables Chromium's retention of the latest pending presentation while preserving one frame in flight. Candidate verification and publication remain pending. The `0.1.0` GitHub release remains a draft. The historical acceptance below does not certify this correction or erase the later failures.

Publication update, 5 November 2026. The owner authorized publication, the [GitHub repository](https://github.com/kyusuku/show-what-changed) is public, and [`show-what-changed@0.1.0`](https://www.npmjs.com/package/show-what-changed/v/0.1.0) is published. A fresh npm download matches the accepted archive SHA-256 and registry SHA-512 integrity. A fresh installation reports version `0.1.0` and passes `doctor`.

The candidate evidence below preserves the prepublication acceptance record. Its `ready_for_owner_publish` status identifies the reviewed handoff and archive, with both final reviews and all 24 specification requirements accepted. Historical statements about pending publication describe that earlier verification run. The published package uses the exact reviewed archive without npm provenance.

The accepted package SHA-256 is `0ca52c4395e27c9282489375ffd5c1924c718f829d65818c2284c367cdb9ed31`. Runtime tests executed implementation `e6934a8161e29f5a74b340ba3c982c92f3c212cc`. The sanitized public implementation `3f32d256cea93798098b8456da99eeb39f9ca9df` rebuilds into exactly that archive. The final documentation commit and public source archive digest are recorded outside the archive in the release identity. [Final requirement acceptance](../evidence/revision-0.3/final-acceptance.json) preserves both reviewers and the limits of the evidence.

The original 24-hour target was missed. The release record describes completed verification, not completion on schedule.

The required outcome is a verified experimental 0.1.0 package implementing schema 2 and spec revision 0.3. The authoritative acceptance record is [the revision status ledger](../evidence/revision-0.3-status.json). Every G01 through G24 gate must be accepted for the exact final candidate before the status becomes ready_for_owner_publish.

## Current evidence

The shared schema, general recipe runtime, whole-repository source handling, CLI integration, and motion implementation have development checks and independent reviews. These results are recorded under [the implementation work log](../evidence/revision-0.3/work.md). They do not certify a final package or platform.

The earlier package passed three navigation comparisons, three validation comparisons, and a subsequent WORKTREE comparison through the installed CLI. Independent review confirmed actual drawer motion, inner scrolling, feedback changes, preservation, and cleanup. The historical package and source association are recorded in [G19 acceptance](../evidence/revision-0.3/G19-public-app-acceptance.json).

The earlier package passed the complete macOS and Linux synthetic motion matrix with numerical checks and normal-speed review, recorded in [G10 acceptance](../evidence/revision-0.3/G10-motion-acceptance.json). Docker lifecycle and interruption requirements passed the combined review in [G07 and G15 acceptance](../evidence/revision-0.3/G07-G15-docker-cleanup-acceptance.json). Those records retain their exact historical identities. They do not independently accept the repaired package. Earlier failed runs retain their original outcomes and unresolved causes.

Before final acceptance, the ledger retained 16 accepted gates. The neighboring-module reviews had reopened G05, G09, G14, and G18 for runtime exit classification, maximum-duration partial motion, and planner coverage. The findings are recorded in [the R6 boundary review](../evidence/revision-0.3/R6-final-boundary-findings.json). A subsequent [Linux recording diagnostic](../evidence/revision-0.3/linux-capture-schema-diagnostic.json) also reopened G12 after reproducing an invalid host/source clock comparison. Earlier successful observations remain historical evidence.

The timing repair passed 205 affected tests and independent exact-frame review. [Scoped timing evidence](../evidence/revision-0.3/timing-repair-progress.json) records the original compiled-source proof. The corrected installed package subsequently passed the same default 60-second timeout and offline composition checks. It retained both timeout failures, encoded 1,830 frames, preserved the caller, and cleaned up successfully. Offline composition with the browser unavailable produced identical capture, timeline, video, and poster bytes.

The corrected package passed all fifteen macOS build, test, packaging, and installed verification stages. The unit results are 839 passed and 11 skipped. Six motion cases passed numerical checks, and all seven public-app comparisons passed. Scoped normal-speed media review is accepted as described below. [Corrected candidate progress](../evidence/revision-0.3/corrected-candidate-verification-progress.json) binds these checks and the installed timeout proof to the new package.

The corrected full Linux suite passed all 17 stages, including 839 unit tests, 103 integration tests, six numerical motion cases, and seven public-app comparisons. The owned container and host process group are absent, the complete Docker inventory matches the baseline, and the VM stopped normally. Both final reviewers accept G20 for the corrected candidate. The previous Linux suite finished with 15 passing stages and two failed stages, integration and public-app comparison. Its evidence remains in [the historical Linux result](../evidence/revision-0.3/linux-retention-candidate-result.json). That run's resources were closed. The earlier clock-bound failure and the later nonreproducing diagnostic retain their original outcomes. Both final reviewers accept the reviewed public history, release audit, and publishing procedure. Their final archive association is recorded externally. The historical media review and refreshed public demos have separate completed records.

Independent review accepts the corrected candidate's scoped G10 and G19 media requirements after inspecting all 26 chronological screenshot sequences acquired during actual uninterrupted 1x playback. Root also inspected every sheet and found no mandatory visible defect in those samples. All 946 collector artifacts were hashed. The method uses timestamp-bracketed samples, not continuous human viewing or visual inspection of every decoded frame. The collector completed 26 clean passes and 26 separate temporal passes, but retains exit 1 and status `collected-with-recorded-failures`. The first clip dropped 12 frames in its clean pass and four in its temporal pass during the static title. Both passes contain callbacks for all 126 post-title motion frames. The cause remains unknown. This is scoped media acceptance, with no broad gate promotion or overall readiness claim.

A separate source-fixture DOM observation directly measured inner `scrollTop` changing from 0 to 560 while `window.scrollY` stayed 0 on both sides. Drawer transitions, real local 422 feedback, caller preservation, and owned cleanup passed. Independent review bound the source fixture to the installed matrices by matching exact generator, verifier, fixture, commit, tree, and scenario identities. The source observation and installed package comparisons remain distinct evidence. The corrected installed host interruption matrix passed all 12 cells and exited zero with preservation and cleanup. Independent review accepts those cells within the combined scoped Docker lifecycle judgment. [Corrected candidate progress](../evidence/revision-0.3/corrected-candidate-verification-progress.json) records the proof hashes and remaining work.

The installed partial demo completed two uninterrupted 1x passes of 267 frames each with zero dropped or corrupted frames. Root inspected all 46 chronological screenshots and found no mandatory visible defect in those samples. The failure labels, fixed masks, and useful continued AFTER footage remain visible. Separate decoded-frame evidence establishes the single failure-boundary frame. The original locator and encoding capability errors remain recorded. This is sampled agent inspection, with no gate promotion or release acceptance.

Independent review accepts the corrected candidate's scoped G07, G15, and G16 lifecycle evidence. It associates unchanged dependencies from the earlier Docker matrix with the current host matrix, current source checks, and a new installed Docker comparison. That comparison exited zero with valid provenance, two verified changed pairs, caller preservation, motion encoding, and cleanup. The explicit timeout was 120 seconds. The original outer wrapper still failed on elapsed display labels. A separate postflight continuation accepted the unchanged exact resource states after the recorded display, mount-ordering, and image tag-time normalizations. No comparison rerun occurred.

Root and independent review rehashed all 3,666 closure proof records and all 698 exported files. The final export matches the original guest inventory, and the original Docker inventory is restored. Product resources were absent before the test controller closed. The new owned guest root is absent, and the VM stopped normally. The first postflight check, both local export-write failures, and the premature audit remain failed. Separate file-only export completion and final physical closure passed. An older failed-setup root remains retained, so this does not claim that every historical temporary directory is absent.

The Docker video completed two uninterrupted 1x passes of 75 frames each with zero dropped or corrupted frames. Root inspected all 14 chronological samples, observed the changed heading and moving orange object, and found no mandatory visible defect in those samples. State parity remains explicitly unverified. The full uncapped probe confirms H.264, yuv420p, 30 FPS, 2.5 seconds, and faststart. The short Docker fixture does not replace the separate full synthetic motion matrix.

All nine public demo files now match their recorded corrected-candidate hashes. The cleaned public implementation was rebuilt and repacked into exactly the tested archive bytes, including all 171 package members. Both independent R16 reviews accept all 24 requirements. The ledger preserves historical commands and failures separately from current acceptance. The accompanying release identity binds the final documentation-only update and its refreshed scans to the exact delivered archive.

A previous schema 1 candidate has [historical release evidence](../evidence/release-candidate.json). Its checks and hashes do not establish readiness of the current implementation.

## Candidate identity and public scope

Freeze the implementation before final acceptance. Record the tested implementation commit, specification digest, tested source archive SHA-256, and npm tarball SHA-256. Record the later documentation-only handoff commit and its complete public source archive digest separately. Deliver those final identities in a release manifest outside the archive it hashes. The final manifest binds the exact intended refs, reviewed document and media hashes, scan reports, advisory triage, and gate dispositions. A manifest cannot contain its own final digest, and an archive cannot contain a record of its own final digest. Source or package changes invalidate affected evidence. Do not substitute a rebuild without verifying its identity.

The public repository, package, demos, and full intended Git history must contain no private application context. The current development history is held from publication. Prepare a separate sanitized public history from the reviewed tree. Keep original private development history and private inputs outside that release repository.

Run the privacy scanner on the exact tree, source archive, package, and intended public history with its deny list stored outside the public repository. Keep deny values and private finding paths out of public reports. Review media, credentials, dependency notices, and unsupported encodings separately. A text scan alone cannot certify them.

## Final checks

Use the exact candidate archive with these installed-package checks. Each output directory must be outside the source tree. Commands below use placeholders rather than a stale candidate identity.

```sh
node scripts/verify-package-source.mjs "$SWC_TARBALL" /absolute/new-source-binding
SWC_PACKAGE_EVIDENCE=/absolute/new-package-check
node scripts/release-smoke.mjs "$SWC_TARBALL" "$SWC_PACKAGE_EVIDENCE"
SWC_INSTALLED_ROOT="$(node --input-type=module -e 'import {readFileSync} from "node:fs"; import {join} from "node:path"; const report = JSON.parse(readFileSync(process.argv[1], "utf8")); if (report.status !== "passed") process.exit(1); process.stdout.write(join(report.root, "installed/node_modules/show-what-changed"));' "$SWC_PACKAGE_EVIDENCE/report.json")"
node scripts/revision-0.3-motion-check.mjs --installed-root "$SWC_INSTALLED_ROOT" --output-dir /absolute/new-motion-check
node scripts/compatibility-smoke.mjs "$SWC_TARBALL" /absolute/new-host-check
node scripts/real-app-smoke.mjs "$SWC_TARBALL" /absolute/new-public-app-check
node scripts/repeatability.mjs "$SWC_TARBALL" /absolute/new-keyframe-check
```

The source-binding check repacks freshly built source with pinned npm and requires byte equality with the supplied candidate. It does not replace the archive privacy check.

The installed motion command defaults to three repetitions at each required viewport. It must report `numeric-passed` and `completeRepetitionMatrix: true`. Review every resulting video at normal speed separately. Reuse the package installation only from the successful smoke report for the selected tarball.

The host matrix does not accept the separate Docker requirement. The public-app script does not accept independent inner-scroll observation or decoded-media and normal-speed review. Explicit keyframe repeatability does not establish motion quality. Retain these distinctions in the final acceptance report.

Run the Linux source/archive runner and the macOS checks for the same candidate. A Linux result may set platformChecksComplete after its scripted checks pass. Its releaseGateComplete remains false because the independent final review owns acceptance across G01 through G24.

## Owner publishing handoff

After all required gates pass, provide exact candidate identities, reviewed demos, reusable public recipes, supported limits, and [the publishing checklist](publishing.md). Report any unresolved requirement instead of calling the candidate ready. Publication, pushing public history, deployment, and repository visibility changes require separate explicit owner authorization.
