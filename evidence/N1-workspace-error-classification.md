# Workspace materialization error classification

The v0.1 CLI must report workspace failures as `failed` with exit code 5 under spec section 10. Before this correction, filesystem errors during materialization reached the runner as `INTERNAL_ERROR` with exit code 1. Failed `git worktree add` and `git reset --hard` commands retained the source inspection diagnostic `GIT_FAILED` with exit code 2.

## Correction

`src/workspace/index.ts` owns a local materialization error boundary. It recognizes native filesystem errors by their negative integer `errno`, string `syscall`, and matching `getSystemErrorName(errno)` and `code`. Those errors become `WORKSPACE_FAILED`, phase `preparing`, with the affected side and exit code 5. The boundary covers destination writes, original source reads during copying, and snapshot inventory reads.

The same boundary converts typed `GIT_FAILED` errors only around the two Git mutations that create and populate a detached worktree. Source Git inspection failures remain exit code 2. Missing capabilities, typed stale source and unsupported layout failures, and unexpected programmer errors retain their existing classification. The original cause remains on the local error object. The public message does not expose its path or raw text.

Source inspection before materialization remains outside this boundary. Resource registration and cleanup are unchanged.

## Reproduction

`test/integration/workspace-errors.test.ts` starts the actual source CLI in Node 24 using a loader that resolves the TypeScript source files. It injects one failure at a selected filesystem or Git subprocess operation. It does not modify production files, exhaust disk space, download dependencies, or build `dist`.

The fixture contains a committed file, separate staged and unstaged bytes, an untracked file in a new directory, and existing caller dependencies. Every probe verifies all of the following before asserting its expected classification.

- The caller index, HEAD, source bytes, untracked file, and dependencies are unchanged.
- The Git worktree registry returns to its original contents.
- The owned workspace directory and repository run lock are removed.
- The public result equals the saved manifest and reports successful cleanup.
- The injected private error text is absent from public JSON.

The new probes cover these outcomes.

| Trigger | Expected result |
|---|---|
| `chmod`, `mkdir`, `open`, or `rename` returns `EACCES` | `failed`, exit 5, `WORKSPACE_FAILED` |
| An overlay write returns `ENOSPC` | `failed`, exit 5, `WORKSPACE_FAILED` |
| Snapshot inventory or original-source read returns `EACCES` | `failed`, exit 5, `WORKSPACE_FAILED` |
| Worktree creation or reset subprocess exits nonzero | `failed`, exit 5, `WORKSPACE_FAILED` |
| Git inspection subprocess exits nonzero | `failed`, exit 2, `GIT_FAILED` |
| Git mutation cannot start its executable | `failed`, exit 8, `GIT_UNAVAILABLE` |
| A programmer `TypeError` or an `Error` with only `code: EACCES` occurs | `failed`, exit 1, `INTERNAL_ERROR` |
| The real CLI deadline expires while materialization is delayed | `cancelled`, exit 10, `DEADLINE_EXCEEDED` |
| `SIGINT` or `SIGTERM` arrives during materialization | `cancelled`, exit 130 or 143 |

The existing snapshot tests additionally cover `STALE_PLAN`, concurrent `STALE_SOURCE`, source mutation during installation, unsupported conditional Git filters, independent installs, caller preservation, and cancellation during installation.

## Commands and results

Tests require access to `ps` for the existing ownership checks. The first sandboxed probe stopped before preparation with `MISSING_CAPABILITY`, exit 8. The regression runs below used approved execution outside the sandbox and temporary fixture repositories.

Before the source correction, this command exited 1.

```sh
PATH=/private/tmp/swc-toolchain/node_modules/.bin:$PATH npm test -- test/integration/workspace-errors.test.ts -t 'reports (chmod|writeFile|git-add|git-reset) materialization'
```

The relevant output was:

```text
FAIL reports chmod materialization failure as exit 5 and removes owned worktrees
FAIL reports writeFile materialization failure as exit 5 and removes owned worktrees
AssertionError: expected 1 to be 5

FAIL reports git-add materialization failure as exit 5 and removes owned worktrees
FAIL reports git-reset materialization failure as exit 5 and removes owned worktrees
AssertionError: expected 2 to be 5

Test Files  1 failed (1)
     Tests  4 failed | 12 skipped (16)
```

After the source correction, these commands exited 0.

```sh
PATH=/private/tmp/swc-toolchain/node_modules/.bin:$PATH npm test -- test/integration/workspace-errors.test.ts test/unit/snapshot.test.ts
PATH=/private/tmp/swc-toolchain/node_modules/.bin:$PATH npm run typecheck
```

The focused test output was:

```text
Test Files  2 passed (2)
     Tests  24 passed (24)
```

The typecheck ran `tsc --noEmit` without diagnostics. No build, commit, remote Git operation, or publishing action was performed for this correction.
