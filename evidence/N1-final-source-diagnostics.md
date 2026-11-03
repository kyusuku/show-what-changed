# Source diagnostic corrections

The final requirement audit identified missing measured sizes and missing offending paths in source errors. The corrective changes keep the source limits and unsupported layouts unchanged.

`readSourceFile` now reports an oversized regular file as `SOURCE_LIMIT`, exit 2, with its filename, measured bytes, and limit before allocating the content buffer. Aggregate disk and tree errors report the bytes measured before the early cutoff as a lower bound. `readTree` reports the JSON-quoted offending path for a committed symlink, submodule, or other unsupported tree entry. Malformed Git output remains a separate `GIT_FAILED` diagnostic.

Five additional source tests cover an oversized sparse file, aggregate overflow with a later eligible file, exact inventory limits and one-over limits, a committed symlink, and a committed submodule. The unsupported-entry filenames include spaces and a newline. Quoting keeps the newline escaped in the diagnostic.

The initial focused regression run failed four cases and passed one before the correction. The full source suite then passed 60 tests. Independent review confirmed those tests and identified the partial-sum wording issue. The integrator changed both aggregate diagnostics to say `at least`, added a later eligible file to the regression, and reran all 60 source tests successfully. Together with the new lsof prerequisite tests, the final focused run passed 73 tests and typecheck.

Run the source checks with Node 24.

```sh
npm test -- test/unit/source.test.ts
npm run typecheck
```

The final integrated source and installed-package gates must use the replacement candidate. C1 evidence predates these diagnostic corrections.
