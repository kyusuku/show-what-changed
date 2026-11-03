# N1 source diagnostics

The v0.1 publishing goal requires unsupported-source diagnostics to identify the offending file and the supported alternative in spec section 5.1. This change adds known filenames and safe Git configuration context to source failures. It preserves exit code 2, `UNSUPPORTED_SOURCE_LAYOUT`, the `source` phase, and the existing hints.

## Reproduction

The supplied `preflightFiles` input used `assets/prohibited-lfs-pointer.txt` with a Git LFS pointer body. Before the fix, the error was `Git LFS pointer files are unsupported.` The filename was absent.

New regression cases ran before the production edit with this command.

```sh
PATH=/private/tmp/swc-toolchain/node_modules/.bin:$PATH npm test -- test/unit/source.test.ts -t 'actionable unsupported-source diagnostics'
```

The failing output included this comparison.

```text
-     "message": StringContaining "\"assets/prohibited-lfs-pointer.txt\"",
+     "message": "Git LFS pointer files are unsupported.",
```

The run reported `27 failed | 1 passed | 24 skipped (52)`. All 27 failures concerned the absent filename or configuration context. The missing-root-file case already named both required files and passed.

## Change

`src/workspace/source.ts` now reports the source filename for LFS pointers, filter attributes, restricted npm configuration, conflicting lockfiles, workspace markers, nonregular files, tracked generated directories, duplicate paths, and file-to-directory transitions. Valid source paths use `JSON.stringify` so newline filenames remain identifiable without printing terminal controls. Invalid or absolute source paths retain the generic safe-path diagnostic.

Manifest and lockfile failures name `package.json`, `package-lock.json`, or both. `checkDependency` receives a literal manifest-or-lockfile origin and reports that filename. It never interpolates a dependency value, URL, credential, private package name, or lockfile entry key. The previously added public `npm:` alias acceptance and rejection rules remain unchanged.

Git filter failures name the source attributes file or its safe configuration context. External attributes identify `info/attributes`, the default `.config/git/attributes`, or `core.attributesFile` with the configured basename. They do not print the configured absolute path or file contents. Sparse checkout names `core.sparseCheckout` and a full checkout as the supported alternative. Configured filters name Git configuration and removal of custom filters.

Every `unsupported()` call in this file was reviewed. Unmerged index errors retain their repository-level instruction. Malformed Git diff records retain a generic message because they do not guarantee a valid source filename. No source inspection rule was relaxed. Public artifact writing and redaction code were not modified.

## Verification

After the fix and the final privacy assertions, these commands passed.

```sh
PATH=/private/tmp/swc-toolchain/node_modules/.bin:$PATH npm test -- test/unit/source.test.ts
PATH=/private/tmp/swc-toolchain/node_modules/.bin:$PATH npm run typecheck
```

```text
 Test Files  1 passed (1)
      Tests  55 passed (55)

> show-what-changed@0.1.0 typecheck
> tsc --noEmit
```

The 55 cases include existing exact-source, unsupported-layout, cancellation, merge-base, and public npm alias coverage. New checks cover known file origins, every rejected conflicting-lockfile name, external attribute privacy, unsafe source-path privacy, preserved error metadata and hints, and repository configuration context. Existing filesystem preflight cases now also assert the offending filename and absence of the temporary repository root.

No build, commit, provider call, credential access, or public action was performed for this change. Product source was declared stable before the coordinator's candidate build.

## Synthetic secret disposition

A targeted search of the two owned code files found the sensitive-looking values only in `test/unit/source.test.ts` fixtures and assertions. `private-token`, `private-user`, `private-password`, `private-host`, `private-repository`, `secret-dependency`, `private-filter-command`, and `private-source` are deliberately fabricated rejection or redaction inputs. `registry.example.invalid` is a reserved example hostname. These values are not credentials. Tests assert that the corresponding values and temporary absolute roots do not appear in returned diagnostic messages.

The search produced no matching synthetic values in `src/workspace/source.ts`. This was a local text inspection, not a SAST scan. The Aikido MCP server required by the local scan skill was unavailable, and no Aikido scan result is claimed.

## Design decisions

The Laziness Protocol kept the existing failure helper and dependency policy. Model the Domain and Type System Discipline kept the dependency origin to the two supported package filenames. Fix Root Causes placed filename context at the rejecting check. Test Behavior, Not Implementation made assertions about returned errors. Prove It Works required the failing-before run, the passing focused suite, and typecheck.

## File hashes

SHA-256 values after verification.

```text
0ea23d0dccc6943011733ba4bd1ec87b5f317df91528cabd507453b16f1a911d  src/workspace/source.ts
c10e970900dfac0cd73ec77bd16eacdf195b1392ca372afbf5e56309e23dc711  test/unit/source.test.ts
```
