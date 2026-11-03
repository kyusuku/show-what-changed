# N6 runtime finalization ownership correction

The release goal requires a complete v0.1 whose successful result refers to retained, fully written artifacts. The original lifecycle released the repository lock during resource cleanup, before the runner wrote `pr.md` and the terminal manifest. An external `clean` could delete the run in that interval while compose subsequently returned success.

The independent baseline reproduction is `/private/tmp/n6-finalization-race.mjs`. Its failing report is `/private/tmp/n6-finalization-race-clOxrO/report.json`. N6 integration coverage lives in `test/integration/adversarial-gaps.test.ts`; that owner records the actual CLI result separately.

## Contract and scope

This correction owns `src/runtime/context.ts`, `src/runtime/ownership.ts`, and `test/unit/runtime-finalization.test.ts`. The integrator owns the corresponding runner changes. No changes to runtime file-writing helpers were necessary.

`createRunContext` and `reopenRunContext` accept optional `retainOwnership`. The default preserves the previous direct-caller cleanup behavior. With retention enabled, `cleanupRun` closes contexts and browsers, stops owned process groups, and removes owned workspaces, while the active run marker and repository lock remain held. Automatic cancellation uses the same retained cleanup path.

`releaseRunOwnership` awaits resource cleanup and returns a cached, idempotent outcome with one ownership state:

- `released` means the owned lock directory was successfully removed. No artifact write is permitted afterward.
- `retained` means the same lock directory and run nonce remain verified. The runner can repair terminal metadata to report cleanup failure.
- `uncertain` means ownership cannot be proved. The runner must return a truthful failure without further artifact writes.

A cleanup failure prevents ownership release. Initializer failures before context handoff explicitly release ownership, even when retention was requested. Reopen failures before a complete context restore the previous run marker. Filesystem cleanup failures leave the repository blocked rather than deleting an uncertain lock.

For retained runs, cancellation forwarding and the global deadline remain active during terminal artifact writes. Explicit release detaches those inputs after resource cleanup. The runner checks cancellation at the completion of terminal artifact writes and freezes the terminal decision before release. Its fallback rewrite after a retained release failure preserves that decision and adds cleanup failure.

## Release and clean protocol

Release first verifies the held lock directory device and inode plus the registered nonce. It writes the inactive run marker while holding the lock. It then unlinks the exact `owner.json` entry and calls `rmdir` on the now-empty lock directory. Successful `rmdir` is the final filesystem operation and the release point. A failed release rechecks the original directory identity and run nonce before declaring retention. If owner removal already succeeded, the intermediate incomplete directory still blocks every new run and cleanup command.

The alternative of renaming the lock into a tombstone was rejected. Removing that tombstone afterward would introduce fallible work after ownership had already been surrendered.

`clean` now acquires the same exclusive repository lock before validating current inactivity or deleting workspaces and artifacts. If a lock already exists, it is eligible only when its complete marker identifies the exact registered run and nonce and its owner and recorded process groups are absent. A second exclusive `clean.claim` file serializes cleaners within that existing stale lock. Activity and nonce checks repeat after claim acquisition. An incomplete, live, mismatched, or already claimed lock is never treated as absent. The original directory remains present through deletion, so compose cannot acquire it between the inactivity check and removal.

## Verification

Run with the pinned Node 24 toolchain and permission for real local process inspection:

```sh
PATH=/private/tmp/swc-toolchain/node_modules/.bin:$PATH npm run typecheck
PATH=/private/tmp/swc-toolchain/node_modules/.bin:$PATH npx vitest run test/unit/runtime-finalization.test.ts test/unit/runtime.test.ts
```

Both commands exited 0. The focused gate passed 29 tests in two files. Fifteen new cases cover:

- Retained cleanup, terminal writes, explicit release, and repeated release.
- Cancellation after cleanup and automatic cancellation cleanup.
- A deadline that expires during terminal writes.
- Release waiting for resource disposal and preserving ownership after disposal failure.
- Initializer failures both before and after context registration.
- An incomplete lock with a missing owner file.
- Clean winning the repository lock before compose.
- Compose winning the lock after clean's initial marker read.
- Two cleaners contending for an exact abandoned lock.
- Partial owner-file removal followed by an `rmdir` failure.
- A reported error after actual lock removal, classified as uncertain rather than retained.
- A marker rename that committed before temporary-file cleanup reported an error.
- A changed run nonce that forbids terminal metadata repair.

The unchanged runtime suite also passed its real SIGKILL owner recovery, process-group cleanup, unrelated-process preservation, private artifact containment, and default cleanup compatibility cases.

The tests use actual temporary directories and OS process probes. Narrow filesystem wrappers pause specific operations or inject errors to make concurrency interleavings and post-commit failures deterministic. Actual external CLI finalization and signal results remain separate integration evidence.

The Model the Domain principle shaped the explicit ownership outcome. Make Operations Idempotent shaped the cached cleanup and release promises. Type System Discipline keeps the owner marker derived from its validated schema. Native Codex tools replace unavailable Cursor orchestration helpers. Independent final review and integrated release verification remain the integrator's gates.
