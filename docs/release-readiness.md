# Revision 0.3 release readiness

Status. Implementation and verification are in progress. This candidate is not ready for publication. Nothing has been published, pushed, deployed, or made public during this run.

The required outcome is a verified experimental 0.1.0 package implementing schema 2 and spec revision 0.3. The authoritative acceptance record is [the revision status ledger](../evidence/revision-0.3-status.json). Every G01 through G24 gate must be accepted for the exact final candidate before the status becomes ready_for_owner_publish.

## Current evidence

The shared schema, general recipe runtime, whole-repository source handling, CLI integration, and motion implementation have development checks and independent reviews. These results are recorded under [the implementation work log](../evidence/revision-0.3/work.md). They do not certify a final package or platform.

The public workspace example passed three navigation comparisons, three validation comparisons, and a subsequent WORKTREE comparison through the selected installed package. Independent review confirmed actual drawer motion, inner scrolling, feedback changes, preservation, and cleanup. The exact package and source association are recorded in [G19 acceptance](../evidence/revision-0.3/G19-public-app-acceptance.json).

The selected package passed the complete macOS and Linux synthetic motion matrix with numerical checks and normal-speed review, recorded in [G10 acceptance](../evidence/revision-0.3/G10-motion-acceptance.json). Docker lifecycle and interruption requirements passed the combined review in [G07 and G15 acceptance](../evidence/revision-0.3/G07-G15-docker-cleanup-acceptance.json). Earlier failed runs retain their original outcomes and unresolved causes.

The ledger currently accepts 21 of 24 gates. G20 remains pending because the complete Linux suite failed a public navigation clock-bound check. A subsequent single diagnostic did not reproduce that failure and does not replace the required full platform verification. G23 and G24 still require the final release audit and exact publishing handoff. The static, npm, pnpm workspace, and Python installed results have separate records in [candidate verification progress](../evidence/revision-0.3/candidate-verification-progress.json).

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
