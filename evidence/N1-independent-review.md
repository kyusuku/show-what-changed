# N1 independent review

The goal is to verify that v0.1 renders the selected source bytes, runs only consented commands, and cleans its owned resources without changing the caller's checkout. This bounded review found two release-blocking defects and two related process-exit follow-ups. The owner fixed all four, and the independent disposable reproductions pass against the final inspected files. No proven material issue remains from this review. This document records the evidence and retests. It is not a release verdict.

Throughput checkpoint is not applicable to this read-only investigation. The reviewer changed only this evidence file. Disposable probes live under `/private/tmp/swc-n1-review/`.

## Scope and method

Reviewed spec sections 3, 5, 10, 11, the T02/T03/T04/T12/T13 requirements, `docs/architecture/contracts.md`, all files under `src/workspace/` and `src/runtime/`, and the source, snapshot, runtime and lifecycle tests. Base commit was `b792378c5150faf147dd7f3396d2bec28142ab06`. The N1 files were untracked and concurrently owned by the N1 implementation worker, so the hashes below identify the inspected version.

The review followed poteto-mode's investigation and Prove It Works guidance. Prove It Works changed the review from inferred edge cases into disposable Git and process reproductions. The requested native no-comments equivalent found no source comments, suppression directives, or constraint comments in the inspected N1 files and tests. There was no literal Comment Sicko capability and no additional agent was spawned. No comment deletions, restorations, encodings or application edits were made.

The initial sandboxed test run was blocked by `ps` and loopback-listener restrictions. It was not counted as product failure. After approved process/socket access, this command passed four files and 40 tests on Node v24.22.2. That run included a newly added SIGKILL recovery test from the concurrent owner.

```sh
PATH=/private/tmp/swc-toolchain/node_modules/.bin:$PATH npm exec vitest run test/unit/source.test.ts test/unit/snapshot.test.ts test/unit/runtime.test.ts test/integration/lifecycle.test.ts
```

The passing tests do not cover the two reproduced defects below.

## Closed P1. An owned descendant survives cleanup after its leader exits between samples

Affected pre-fix code is `src/runtime/supervisor.ts` at lines 31, 45, and 67 through 71. The supervisor marks the leader done on `exit`, samples group members every 150 ms only while the leader remains live, and refuses to signal a remaining group without either the live leader or a previously sampled member. A normal non-detached child created after the initial ownership sample can outlive a fast-exiting leader before any periodic sample sees it.

This breaks the ordinary process-group cleanup promise in spec section 11.3. Cleanup reports failure and retains the lock, but the child remains running. This is not a detached daemon or a PID-reuse simulation.

The executable probe is `/private/tmp/swc-n1-review/probe-orphan.mjs`. Its essential steps are reproducible with the exported runtime API.

```js
const script = `const {spawn}=require('node:child_process');process.stdin.once('data',()=>{const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});process.stdout.write(String(c.pid)+'\\n',()=>process.exit(0));});`;
const owned = await run.supervisor.spawn({
  argv: [process.execPath, '-e', script],
  cwd: disposableRoot,
  purpose: 'probe',
  input: 'pipe',
});
owned.stdin.write('go');
await owned.exited;
const descendant = Number(owned.output().stdout.trim());
const before = await groupMembers(owned.groupId);
const cleanup = await cleanupRun(run);
const after = await groupMembers(owned.groupId);
```

The exact observed values were as follows. The probe killed its explicitly created descendant in `finally` after taking this evidence.

```json
{
  "leader": 229,
  "descendant": 241,
  "before": [{"pid":241,"parent":1,"group":229,"started":"Mon Nov  2 03:40:38 2026"}],
  "cleanup": {"status":"failed","errors":[{"code":"CLEANUP_FAILED","phase":"cleanup","message":"An owned process could not be cleaned up.","hint":"Inspect private diagnostics and remaining owned processes."}]},
  "after": [{"pid":241,"parent":1,"group":229,"started":"Mon Nov  2 03:40:38 2026"}]
}
```

The owner proposes keeping a tool-owned process-group anchor alive through command exit and group cleanup. The regression must assert the descendant disappears, cleanup succeeds, and an unrelated live process survives. A separate limitation remains for deliberately detached daemon processes under the documented no-sandbox trust model. This review did not classify that limitation as another release blocker.

## Closed P1. Conditional Git configuration runs a smudge filter before target preflight

Affected pre-fix code is `src/workspace/index.ts` line 49 and lines 60 through 61, with `src/workspace/source.ts` lines 132 through 141. Preflight evaluates Git configuration in the caller's repository. `git worktree add --detach` then checks out source before the target worktree's effective configuration is inspected. A Git `includeIf gitdir` condition can activate a driver and external attributes file only for linked worktrees.

This violates the explicit section 5.3 requirement to reject custom checkout filters before any operation that can execute them. It is material even though later preparation fails. The custom command has already run.

The executable probe is `/private/tmp/swc-n1-review/probe-filter.mjs`. It creates a disposable npm fixture with no dependencies and a regular `source.txt`, then writes these files after the initial commit.

```ini
# <fixture>/.git/conditional-config
[filter "review"]
 smudge = "touch <fixture>/.git/filter-ran; cat"
[core]
 attributesFile = <fixture>/.git/conditional-attributes
```

```gitattributes
# <fixture>/.git/conditional-attributes
*.txt filter=review
```

The fixture adds `includeIf.gitdir:<fixture>/.git/worktrees/.path` pointing to the conditional configuration. The trailing slash in the Git condition makes it apply beneath the linked-worktree Git directory. It then runs `plan({invocationDir: fixture, routes: ['/']})`, creates a run context, and calls `prepare`.

```text
PLAN_ACCEPTED
{"prepareError":{"code":"UNSUPPORTED_SOURCE_LAYOUT","phase":"source","message":"Configured Git filter drivers are unsupported.","hint":"Use one root npm package with a committed npm lockfile and regular files."}}
{"filterExecuted":true}
{"cleanup":{"status":"ok","errors":[]}}
```

The sentinel and all repository data remained under the disposable fixture and were removed afterward. The owner proposes `worktree add --no-checkout`, inspection of the target's effective configuration and attributes, then explicit materialization only after that inspection passes. The regression must verify the sentinel never exists, not merely that preparation rejects the repository.

## Inspected source identities

These SHA-256 values identify the pre-fix source used for the concrete probes. The temporary executable copies were produced from these TypeScript files with Node's `stripTypeScriptTypes` in transform mode. They retain the source logic and resolve dependencies from the repository's existing `node_modules`.

| File | SHA-256 |
|---|---|
| src/workspace/git.ts | 0be547bc10cc825b72fcecb519b1b66da57ac756ad5004d74db352655c65be50 |
| src/workspace/index.ts | a0ea3b8ee2d4a9e56114979450928665a1a6fa839916d5634806a564f8d02b45 |
| src/workspace/source.ts | fd12ef82cf50fcc154e6fdc696daf168c9cd95467eb519bf73c83a542d2907f7 |
| src/runtime/browser.ts | 7d6e1a2d354af24ecebe6904a601f734735bbbc8cd69ae42b086e980e77dd4bb |
| src/runtime/context.ts | 4923c169b99167a2bc08b2b9eb7c7009d10134abb61a5e663ac3fe22da23f0ed |
| src/runtime/files.ts | 2877ec4004acad91c9d449d675c03eca6953a449efd630d7d3630a5c432db4b1 |
| src/runtime/index.ts | 347431351637b95a8ff80764601fab4725d4428c7c348e1276953072e87264d9 |
| src/runtime/ownership.ts | 24ca79dbdbe6e309cdb198a7f602bd713183c1aec7e27772881c79a7f2cc5497 |
| src/runtime/process-table.ts | a8fcba875ebb09ef78828bffe6252e7fba2a5360661cb3c9ad76429e150d3d6a |
| src/runtime/supervisor.ts | 0b7d4e2856a819d530a199f425c5aefdc28e59d0efac776b56734683cbe894fd |

`ownership.ts` changed during the review as the owner added SIGKILL recovery coverage. Its later observed hash was `49d370900a5cd9cd6158a4dbc4ea6977845d7695582062f44e58c5ae7f4b13f2`. Neither reproduced defect depends on that change.

## Independent fix retest and command-liveness follow-up

The original probes were rerun against fresh transformed copies in `/private/tmp/swc-n1-review-fixed/`. Both now meet their assertions.

```text
Orphan probe: cleanup.status = ok; group 26305 had anchor 26305 and descendant 26318 before cleanup; group was empty afterward.
Filter probe: PLAN_ACCEPTED; preparation rejected the configured filter; filterExecuted = false; cleanup.status = ok.
```

Those retests used these fixed-file hashes.

| File | SHA-256 |
|---|---|
| src/runtime/process-anchor.ts | 16174b7e29fc1e865d5b8e09f18eb663f601621dfaf16f7f56ed543229ad478d |
| src/runtime/supervisor.ts | 6601086e263aeaf80739081f59d524633f12f7b2b32413c7b045a0c7aaabb9d8 |
| src/workspace/index.ts | 8da880ac8a02cf8947a9d92f0c20ce8ff679ad06c8574094ca5462f56b739b3c |

The follow-up probe is `/private/tmp/swc-n1-review-fixed/probe-inherited-stdio.mjs`. Its actual command spawns a non-detached child using inherited stdout/stderr and then exits. The child stays alive without writing. `process-anchor.ts` line 15 sends its only exit IPC message from the command's `close` event. That event waits for the descendant to release the inherited streams. The supervisor therefore reports the actual command as alive after it has exited. Server readiness uses that flag, and server-exit observation uses the unresolved exit promise.

```js
const script = `const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore','inherit','inherit']});console.log(JSON.stringify({command:process.pid,descendant:c.pid}));process.exit(0)`;
```

The exact observation after a 200 ms wait was as follows. Cleanup then succeeded and removed the group.

```json
{
  "isAlive": true,
  "commandOutput": "{\"command\":26466,\"descendant\":26491}",
  "members": [
    {"pid":26434,"parent":26398,"group":26434,"started":"Mon Nov  2 03:45:20 2026"},
    {"pid":26491,"parent":1,"group":26434,"started":"Mon Nov  2 03:45:20 2026"}
  ],
  "exitSettled": false
}
```

The command PID 26466 is absent. The anchor PID and descendant remain, so group ownership is valid while the command-liveness result is false. The owner then added separate actual-exit and streams-closed messages. Server exit settles immediately. Other process purposes wait for drained output.

That change exposed a related timeout defect. The actual-exit message cleared a non-server process's timer even when its result still awaited inherited pipes. `/private/tmp/swc-n1-review-fixed/probe-drain-timeout.mjs` reproduced an unresolved result and a live descendant after 400 ms despite `timeoutMs: 100`. The owner preserved that timer until output-draining completion. This was a concrete per-process deadline violation, not a claim that the global run deadline was absent.

## Final independent retest

All four disposable probes were rerun against the final files on 2026-11-02 at approximately 03:48 local time. All fixture processes and directories were cleaned.

| Probe | Direct observation |
|---|---|
| Non-detached orphan | PGID 68470 contained anchor 68470 and descendant 68507 before cleanup. Cleanup was `ok` and the group was empty afterward. |
| Conditional Git filter | Plan accepted. Preparation rejected the filter before conversion. `filterExecuted` was `false`, and cleanup was `ok`. |
| Server exit with inherited output | Actual command 68275 exited while descendant 68276 remained. `isAlive` was `false`, `exited` was settled, and cleanup was `ok`. |
| Non-server output-drain deadline | With `timeoutMs: 100`, the process result settled, the group was empty at observation, and cleanup was `ok`. |

The final relevant source identities are as follows.

| File | SHA-256 |
|---|---|
| src/runtime/process-anchor.ts | f118ae677040e486cd70f4fec20ee554fa617d36de73af827de325cd8d9a1878 |
| src/runtime/supervisor.ts | b9123cd7815429cad2a5064a062e07aeb632805b12f235c181e787d9f9a4c481 |
| src/workspace/index.ts | 8da880ac8a02cf8947a9d92f0c20ce8ff679ad06c8574094ca5462f56b739b3c |

## Remaining verification

The independent review is complete for these findings. The root requested bounded finalization after the four probes, so the reviewer did not duplicate the owner's final focused-suite run. This review did not independently execute a full packaged compare, every cancellation phase, Linux process behavior, or every T02/T03/T04/T12/T13 row. Snapshot preservation, source mutation, path containment, exact-port checks, and SIGKILL recovery have concrete test evidence in the earlier focused run, but the focused test count is not a release claim.
