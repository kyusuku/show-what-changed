# Package and tested source binding

The release harness must establish that its supplied package candidate is the same implementation as its freshly built and tested source. Schema equality alone cannot establish this identity.

`scripts/verify-package-source.mjs` compares the supplied archive with an independent `npm pack --ignore-scripts` of the source tree. The caller must finish the source build first. The verifier does not build, install, publish, run lifecycle scripts, fetch dependencies, or execute Git commands.

## Contract

```js
const report = await verifyPackageSource(candidate, sourceRoot, outputDir);
```

The output directory must be outside the source tree. The function writes `package-source-binding.json` there and returns its passed report. A comparison failure rejects with `code: 'PACKAGE_SOURCE_MISMATCH'` and the failed report in `error.report`. Invalid candidates and unsupported toolchains also reject. Input validation that occurs before an owned report directory exists does not write a report.

The guarded CLI uses the script's parent directory as the source root.

```sh
node scripts/verify-package-source.mjs candidate.tgz output-directory
```

The check requires Node 24 and npm 11.12.1. Each npm subprocess has a 30 second timeout and a 1 MiB output limit. Packing is offline. The npm cache and empty user and global configuration files live in an owned temporary directory. Inherited Git routing variables, npm configuration variables, and Node preload options are excluded from the subprocess environment. Lifecycle scripts are disabled explicitly.

The comparison requires both equal SHA-256 values and equal archive bytes. There is no payload-only fallback. Repacked metadata differences therefore fail closed. This check does not extract the candidate and cannot accept a different tar representation merely because its schemas or file payloads agree.

The report records the source package name and version, actual and required toolchain versions, supplied and rebuilt archive hashes and byte counts, and the comparison result. It does not record absolute paths or raw subprocess output. The rebuilt archive and owned npm state are removed after comparison and report writing. The supplied archive, source tree, and unrelated output files are preserved. Canonical path checks reject an output directory inside the source, including symlink aliases, and reject replacing the candidate with the report.

Archive privacy remains a separate G23 check. The binding report records `archivePrivacy: 'not-evaluated'`. An exact binding result does not establish that the candidate, source archive, or intended public history passed the private-context scanner.

## Observed checks

The initial deterministic-pack prototype used the same synthetic source twice with Node v24.22.2 and npm 11.12.1. Each archive was 265 bytes and had SHA-256 `331ac72b412053b98736033a2f7970d9263cf28044bc7189fc982ae380a46ded`. Both archives were byte-identical. Synthetic `prepack` and `prepare` scripts would have exited unsuccessfully if executed. Both packs succeeded with those scripts disabled.

Five scoped tests passed with the same toolchain.

```sh
node --check scripts/verify-package-source.mjs
node_modules/.bin/vitest run test/unit/package-source-binding.test.mjs --maxWorkers=1 --no-file-parallelism
```

- Independent packs of one source passed repeatedly and produced the same report. Source files, executable modes, dependency symlink targets, candidate bytes, and an unrelated output file remained unchanged. Hostile inherited Git and npm settings did not redirect the pack or change the parent environment.
- A changed JavaScript executable failed with `PACKAGE_SOURCE_MISMATCH` while its schema remained byte-identical. The failed report included different supplied and rebuilt hashes.
- Direct and symlink-aliased output directories inside the source were rejected before source changes. A report path colliding with the candidate was rejected without overwriting it.
- Missing, directory, and corrupt candidates failed. The corrupt candidate was preserved.
- The actual CLI passed against a temporary synthetic source and rejected missing arguments with exit code 2. Its entry guard was checked through the host's canonical temporary-directory alias.

Model the Domain shaped the report into a single binding result with a status and distinct candidate and rebuilt identities. Prove It Works changed the verification from schema agreement to actual independent npm archives and an executable-only mismatch test.

No real final candidate was selected or approved by this bounded task. No application server, browser, encoder, Docker process, dependency install, network request, full test suite, or publication was run. Independent review and the caller's final source-build integration remain required.
