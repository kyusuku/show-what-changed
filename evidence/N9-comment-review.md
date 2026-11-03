# N9 comment and suppression review

The goal is a verified v0.1 release candidate with no public actions. This review checks comments and suppressions before the implementation commit.

The scoped verdict is clean. There are zero necessary findings.

## Scope and method

- Baseline commit is `b792378`.
- Reviewed the current working tree, including untracked implementation files.
- Scope contains 67 files. There are 34 files under `src/**/*.ts`, 13 files under `scripts/*.mjs` and `scripts/linux-gate/*.mjs`, and 20 files under `test/**/*.ts`.
- Searched every scoped file for comment markers, TypeScript directives, lint and coverage suppressions, workaround markers, and constraint language.
- Read both explanatory comments with their surrounding implementation and relevant existing tests. URL strings, regular expressions, and test input strings were excluded from comment findings.
- Used a native Codex review worker because the Cursor `comment-sicko` agent type is unavailable. No nested agents were used.

The scope content SHA-256 is `9c845a016960aab1bfe07a139a31dd1de279e0906d0bb413d5393991052da9cd`. It hashes each group in the order above, with sorted paths within each directory scope. Each path and its file bytes are followed by a NUL byte.

## Comments retained

| Location | Comment | Evidence and decision |
| --- | --- | --- |
| `src/recorder/index.ts:172` | `Retain only a previously masked frame.` | The failure path starts with the last safe frame or a neutral generated image. A replacement screenshot must pass `maskedFrame`. If that attempt fails, the catch preserves the safe fallback. `src/recorder/images.ts:13` applies masks, and `test/integration/recorder.test.ts:219` checks that invalid mask CSS has no raw screenshot fallback. Keep the non-obvious privacy rationale. |
| `src/runtime/context.ts:88` | `An incomplete or changed lock remains blocked for manual inspection.` | Initialization cleanup verifies lock identity and ownership before releasing it. Uncertain cleanup preserves the original error. `src/runtime/ownership.ts:17` checks directory identity and nonce, and `src/runtime/context.ts:36` refuses an existing lock. Keep the non-obvious ownership rationale. |

Both keeps follow the caller's explicit exception for valid safety rationale. Neither comment claims a pending fix or hides a type or correctness suppression.

## Counts and limits

- Explanatory comments inspected and retained. 2.
- TypeScript, lint, and coverage suppressions found. 0.
- Stale or misleading comments requiring changes. 0.
- Comments hiding a workaround. 0.
- Constraint comments requiring an encoding offer. 0.
- Deletions, restorations, review reruns, application fixes, architecture sketches, encoding offers, and new encodings. 0 each.
- Unenforced constraints and open work from this review. 0.

No application files changed. Tests were inspected but not rerun. The parent reports that the integrated 282-test suite passed. That result is not independent execution evidence from this review.

The Prove It Works principle required checking the current files and fallback behavior directly. The Minimize Reader Load principle kept the two comments that explain why these empty catches intentionally preserve safe state.
