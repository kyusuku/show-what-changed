# Dependency, license and secret review

The v0.1 candidate needs an inspected package and dependency record before owner publication. This checkpoint records interim evidence. The final integrated commit and archive still require their own scan.

The exact lockfile contains 97 dependency entries. [The inventory](security/dependency-inventory.json) records their names, versions, registry origins, integrity values, declared licenses, and hashes of installed license and notice files. Optional packages for other platforms remain identified as not installed on this host. The Linux gate uses the same lockfile.

The declarations comprise 55 MIT, 25 Apache-2.0, two BSD-3-Clause, 12 MPL-2.0, and three ISC entries. The production dependency tree has seven packages. Commander, pngjs and Zod use MIT. Pixelmatch and semver use ISC. Playwright and playwright-core use Apache-2.0. Runtime distributions carry their license files; the project notices identify every runtime package. Development dependencies are omitted from the installed candidate gate.

The bundled Inter font has its full OFL text and exact upstream provenance in `assets/fonts/`. The copied development-only Playwright seccomp profile has its Apache license and source digest in `scripts/linux-gate/`. Neither Chromium nor FFmpeg is bundled in the npm tarball. No dependency license is replaced by the project's MIT label.

The actual npm registry advisory queries returned zero reported vulnerabilities at every severity for both [all dependencies](security/npm-audit-all-interim.json) and [production dependencies](security/npm-audit-runtime-interim.json). These are time-scoped registry results, not a guarantee that dependencies have no defects. No runtime advisory required remediation or an exception at this checkpoint. Rerun the queries before the final handoff and again before publication if delayed.

`node scripts/release-audit.mjs /private/tmp/swc-candidate-02/show-what-changed-0.1.0.tgz /private/tmp/swc-release-audit-interim-02` exited 0. It checked 160 candidate worktree files, 81 Git index objects, all 81 reachable historical blobs, and 117 archive files. The archive SHA-256 was `52c200c65e60c5be6fa11b12261b50ed0f7a0d61f9d4757aa97c7e9d8e3aa37d`. That older archive is not the final candidate.

The sole pattern match was the synthetic masking canary in `test/integration/adversarial-gaps.test.ts`. Its SHA-256 is `3e87fb25cc7a413e4e424f9cae3aa58b42e92af821d88f35f15533269c7ce92a`. The scanner permits only that exact reviewed value. It does not allow every secret-like value in test files. No unresolved pattern match remained. The scan records paths, line numbers and hashes without printing matched credentials. Binary files are hashed, not interpreted. Final media receives separate visual and synthetic masking checks.

The subsequent source-diagnostic regression added one fake credential URL using the reserved host `registry.example.invalid`. Direct source review confirmed it is a rejection/redaction fixture with no usable account. Its exact SHA-256, `a69ede8ec6c0b4d2c8e8f277631e2263c9c386fe44adbbbb4ef9ff7baa4bcb12`, is the second explicit synthetic exception. Independent release-check review also found that blob-only history scanning missed commit and tag messages. The scanner now inspects all reachable blob, commit and annotated-tag objects. An isolated test with token-shaped values only in commit and tag messages now fails the scan as intended.

Reproduce the registry and local checks with Node 24 and the pinned dependencies.

```sh
npm audit --json > evidence/artifacts/npm-audit-all.json
npm audit --omit=dev --json > evidence/artifacts/npm-audit-runtime.json
node scripts/release-audit.mjs /absolute/path/candidate.tgz /absolute/path/audit-output
```

The Prove It Works principle led to scanning the actual archive and Git objects rather than relying on the package allowlist or a clean working-tree claim. Final evidence will be recorded against the reviewed candidate identity.

## Final implementation candidate C2

The final implementation scan exited 0 at commit `927af366c3db101dc5875768432df20dba9e7675` against archive SHA-256 `6b01bd51d5e713b205d734c29ab948458d32635c7e8dbe5b163364f7bc5d6194`. It checked 868 objects, comprising 238 candidate worktree files, 238 index objects, 269 historical blobs, three historical commits, and 120 archive files. There are no annotated tag objects in this history. All seven matches are occurrences of the two specific synthetic fixture values reviewed above. No unresolved match remains.

[The tracked C2 summary](security/final-c2-summary.json) records the exact report digest, candidate, lockfile, dependency licenses, scan scopes, and match dispositions. The complete report is `evidence/artifacts/security-final-02/report.json`. Registry queries refreshed during final verification returned zero advisories at every severity for [all dependencies](security/npm-audit-all-final.json) and [runtime dependencies](security/npm-audit-runtime-final.json). The lockfile remains unchanged. These registry results are time-scoped.

The Linux verification image now builds lsof 4.99.7 from a verified upstream archive. Its reusable installer copies the upstream license and source provenance with the binary. lsof is an external system prerequisite and is not bundled in the npm archive. The upstream archive SHA-256 is `4a10391aab0b8ce1f539e82a1966693b2a6cf225972a6504ebb7ec4fa71675de`. [Independent prerequisite review](N9-lsof-prerequisite-review.md) checked the official digest, corrected parser, and license bytes.

The final documentation and evidence handoff receives a separate history, index, worktree, and unchanged-archive scan at `evidence/artifacts/security-handoff/report.json`. The local candidate identity records the handoff commit and this scan result. No Aikido or other unavailable hosted SAST result is claimed.
