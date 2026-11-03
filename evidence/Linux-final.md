# Linux release gate evidence

## Candidate C2: passed

The actual release-mode Linux gate passed for immutable implementation commit `927af366c3db101dc5875768432df20dba9e7675`. All 11 stage exit codes are zero, the container exited zero, and `releaseGateComplete` is `true`. This supersedes the failed C1 candidate documented below; C1 evidence has not been relabeled or overwritten.

- Candidate npm archive: [candidate.tgz](artifacts/linux-final-02/candidate.tgz), SHA-256 `6b01bd51d5e713b205d734c29ab948458d32635c7e8dbe5b163364f7bc5d6194`, 261,943 bytes.
- Exact `git archive` source SHA-256: `2bb65ad6ea939b3d6ea304484857ad2e69ae6872ea8c75849320b3c402c0388c`; `dirtySnapshot: false`.
- Image ID: `sha256:c62eeb3aa1502cc9ec7071f8db8f14efdf66ade983e474eb319c14b503423432`. Image context SHA-256: `5511bca4fa851f4b9ca8b89de7f6f4c922a653a2c32765bbfc6aa7e9f335f42a`.
- Container: `swc-v01-linux-1793571086702-41d0d7`, ID `8acb50785a26e26453f7a5b242961a28ec28f1d4f19eb4d7e7183c96072aed05`.
- Run: `2026-11-01T22:11:27.284Z` through `2026-11-01T22:16:39.261Z`.
- Machine-readable [input](artifacts/linux-final-02/input.json), [result](artifacts/linux-final-02/result.json), [validation summary](artifacts/linux-final-02/validation.json), [container identity](artifacts/linux-final-02/container-identity.json), [exit state](artifacts/linux-final-02/container-state.json), and [console](artifacts/linux-final-02/console.log).

The command was executed with the explicit private Docker endpoint. Source came only from the supplied commit; the installed archive was checked against the supplied digest before use.

```sh
PATH=/private/tmp/swc-toolchain/node_modules/.bin:$PATH \
DOCKER_HOST=unix:///private/tmp/swc-lima/swc-v01-gate/sock/docker.sock \
node scripts/linux-gate.mjs --release \
  --commit 927af366c3db101dc5875768432df20dba9e7675 \
  --tarball <release-evidence>/show-what-changed-0.1.0.tgz \
  --tarball-sha256 6b01bd51d5e713b205d734c29ab948458d32635c7e8dbe5b163364f7bc5d6194 \
  --out <release-evidence>/linux-final-02
```

| Stage | Exit | OOM kill delta |
| --- | ---: | ---: |
| extract | 0 | 0 |
| environment | 0 | 0 |
| install | 0 | 0 |
| sandbox | 0 | 0 |
| typecheck | 0 | 0 |
| build | 0 | 0 |
| schema-check | 0 | 0 |
| unit | 0 | 0 |
| integration | 0 | 0 |
| package-smoke | 0 | 0 |
| repeatability | 0 | 0 |

Tests passed: 221 unit tests across 15 files and 95 integration tests across 7 files. The [installed-package smoke report](artifacts/linux-final-02/package-smoke/report.json) passed 18 CLI commands, including exact README and quickstart flows, explicit and automatic selection, merge-base, WORKTREE and stale-plan rejection, partial comparison, encoding failure/recovery, recomposition without a browser, and caller source/index/dependency-file preservation. Expected nonzero CLI outcomes inside the smoke test were asserted by the harness; the smoke stage itself exited zero.

The [repeatability report](artifacts/linux-final-02/repeatability/report.json) passed two independent installed-package comparisons with identical timeline segments. Across 14 source-image comparisons, the maximum changed-pixel ratio was `0.000177734375` against a `0.001` bound. Across 16 decoded video frames at segment boundaries, the maximum mean RGB error between runs was `0.01821398202137998`, and against the scheduled source PNG was `2.036029114026563`; both are below the strict `< 3` threshold. These are measured tolerance checks, not a claim of byte-identical lossy video.

The runtime remained Linux arm64, Node 24.22.2, npm 11.12.1, Playwright 1.64.1, Chromium 156.0.8078.4 revision 1248, ffmpeg 6.1.1/libx264, and the pinned upstream lsof 4.99.7. [Sandbox evidence](artifacts/linux-final-02/sandbox.json) proves UID 1001, a renderer user namespace distinct from the caller, seccomp mode 2, NoNewPrivs 1, `chromiumSandbox: true`, and no `--no-sandbox` argument.

The isolated Lima VM stayed at 4 GiB/2 CPUs. The gate container kept its approved 3 GiB/2 CPU/512 PID/512 MiB shared-memory bounds, with no host mounts or published ports. Cgroup lifetime peak memory was **3,000,872,960 bytes** against **3,221,225,472 bytes**. All final memory event counters were zero, including `max`, `oom`, and `oom_kill`; every stage's OOM-kill delta was zero and Docker reported `OOMKilled: false`. CPU throttling totaled 3,073 microseconds over four periods. No resource limit or timeout was raised for this run.

The runner removed its completed container after saving evidence. After the root agent directly reviewed and accepted the C2 reports, only the owned Lima VM was stopped. `limactl list --json swc-v01-gate` records `Stopped`; its sparse 32 GiB virtual disk remains present. Docker Desktop services were untouched and the default Docker context remains `desktop-linux`. See [shutdown evidence](artifacts/linux-final-02/shutdown.json), [stopped VM state](artifacts/linux-final-02/lima-after-stop.json), and [stop log](artifacts/linux-final-02/lima-stop.log).

### C2 rejects the actual unsupported prerequisite before app execution

Before the full gate, the exact installed C2 archive was checked using the genuine Ubuntu `lsof 4.95.0-1build3` binary extracted unchanged from the retained diagnostic image. Its binary SHA-256 is `d656285464eb93b18e41ed53667a30ef419405e0269ecfe52c14cce002588c60`. A private PATH entry selected that executable; no output shim or product mutation was used.

- `doctor` returned exit 8, identified version 4.95.0 as unavailable, and supplied explicit Linux 4.99.7-or-newer/README setup guidance.
- `compare --allow-exec` returned exit 8 with `LSOF_VERSION_UNSUPPORTED` in the capability phase after approximately 441 ms. Its manifest contains only validating and cleaning timings; its two private process logs are probes. There were no app install/server logs, app `node_modules`, or preparing/starting/recording phases. Caller files, index, and Git worktree inventory were unchanged, cleanup succeeded, and both owned process groups were absent afterward.
- With the production image's lsof 4.99.7 selected normally, installed `doctor` returned exit 0 with all capabilities available.

The probe container's peak was 315,551,744 bytes with zero memory/PID events. It was removed after collecting [the report](artifacts/linux-c2-capabilities/report.json), [CLI outputs](artifacts/linux-c2-capabilities/), [fixture script](artifacts/linux-c2-capabilities/probe.mjs), and exact binary/source hashes.

## Candidate C1: failed

This is an immutable release-mode run of commit `2ae52e9f30d0d0024519c76017dadf1dfbfba552`. It does not establish release readiness. Its package smoke and repeatability stages failed; `releaseGateComplete` is `false`. C2 supersedes this candidate after source-limit diagnostic and Linux prerequisite corrections; its evidence is recorded separately above.

- Source archive SHA-256: `c27606c70681eca7721c7338b96d77f102e31c4292060b46effac76920f04824`.
- Candidate npm tarball SHA-256: `d8ab0f4c51dee78a8208b97667690cbcfb38a6955f67a36155608979ad588f86` (259,593 bytes).
- Gate output: [linux-final-01](artifacts/linux-final-01/). Machine-readable [input](artifacts/linux-final-01/input.json), [result](artifacts/linux-final-01/result.json), [container state](artifacts/linux-final-01/container-state.json), and [console](artifacts/linux-final-01/console.log).
- Started `2026-11-01T21:49:47.820Z`; ended `2026-11-01T21:56:00.637Z`. Container exit 1, not OOM-killed.
- Container `swc-v01-linux-1793569787405-2f157e`, ID `70894fd52ba9723bd156216343416271dcc4fee2f23bc378660f875cbbf1631c`. Image ID `sha256:1523e47dcfd7a2742b031ca4ef42918620e546646c5d4dc0b910c3fdfafde57b`.

The run used the isolated Lima VZ VM `swc-v01-gate`: 4 GiB RAM, 2 CPUs, sparse 32 GiB disk, no host mounts or agent forwarding. Every Docker command selected `DOCKER_HOST=unix:///private/tmp/swc-lima/swc-v01-gate/sock/docker.sock`. Existing Docker Desktop services were not changed. VM provisioning and earlier environment diagnosis are in [Linux-diagnosis.md](Linux-diagnosis.md).

The gate container ran Linux arm64 as UID 1001, with 3 GiB memory, 2 CPU, 512 PID and 512 MiB shared-memory limits. Runtime versions: Node 24.22.2, npm 11.12.1, Playwright 1.64.1, Chromium 156.0.8078.4 revision 1248, ffmpeg 6.1.1 with libx264, and Ubuntu lsof 4.95.0. [Sandbox proof](artifacts/linux-final-01/sandbox.json) records `chromiumSandbox: true`, no `--no-sandbox`, a renderer in a different user namespace, seccomp mode 2, and NoNewPrivs 1.

| Stage | Exit | OOM kill delta |
| --- | ---: | ---: |
| extract | 0 | 0 |
| environment | 0 | 0 |
| install | 0 | 0 |
| sandbox | 0 | 0 |
| typecheck | 0 | 0 |
| build | 0 | 0 |
| schema-check | 0 | 0 |
| unit | 0 | 0 |
| integration | 0 | 0 |
| package-smoke | 1 | 0 |
| repeatability | 1 | 0 |

Unit tests: 203 passed across 14 files. Integration tests: 79 passed across 6 files. Schema freshness, typecheck, and build passed. Final cgroup memory peak was 1,718,087,680 bytes against a 3,221,225,472-byte limit; all `memory.events` counters remained zero, including `max`, `oom`, and `oom_kill`. CPU throttling counters were zero. These observations exclude the earlier Docker Desktop memory-pressure failure from this run.

Both installed-package stages returned `SERVER_TIMEOUT` after the fixed 120-second server readiness bound, with cleanup successful. In package smoke, both Next.js 16.4.3 servers had logged readiness within 167 ms. The failure happened before browser launch and was not slow application startup. [Private diagnostic logs](artifacts/linux-final-01/diagnostic-private/) preserve the server output.

## Listener inspection diagnosis

A separate minimal Node TCP-listener fixture reproduced the failure under the same non-root permissions. The title `next-server (v16.4.3)` becomes Linux COMM `next-server (v1`, an unbalanced opening parenthesis. lsof 4.95.0 returned exit 1 with empty output for both PID and port inspection even though the process had the matching LISTEN socket. Default, plain, spaced, and balanced-parenthesis process names were detected. See [fixture](artifacts/linux-final-01/lsof-title-probe.mjs) and [4.95 results](artifacts/linux-final-01/lsof-4.95-title-probe.json).

This matches upstream [lsof issue 359](https://github.com/lsof-org/lsof/issues/359): the old `/proc/PID/stat` parser attempted to balance parentheses in COMM. Upstream fixed it by locating the last closing parenthesis. The official [4.99.7 release](https://github.com/lsof-org/lsof/releases/tag/4.99.7) includes the correction. The pinned comparison below passes; the failed C1 output remains unchanged.

### Corrected prerequisite comparison

A separate image built unmodified official lsof 4.99.7 from `https://github.com/lsof-org/lsof/releases/download/4.99.7/lsof-4.99.7.tar.gz`, SHA-256 `4a10391aab0b8ce1f539e82a1966693b2a6cf225972a6504ebb7ec4fa71675de`, matching the digest published by the GitHub release API. Its full Purdue Research Foundation permissive license is preserved in [COPYING](artifacts/linux-final-01/lsof-4.99.7/COPYING). See the exact [build recipe](artifacts/linux-final-01/lsof-4.99.7/Dockerfile), [build log](artifacts/linux-final-01/lsof-4.99.7/build.log), and [provenance](artifacts/linux-final-01/lsof-4.99.7/provenance.json). Compilation uses `--disable-liblsof --with-libtirpc --with-selinux`; the final stage adds only the executable and license to the original gate image.

The unchanged six-title fixture passes for every title under lsof 4.99.7, including the previously omitted truncated Next.js title. The actual C1 application `verifyListeners` and cleanup APIs also pass a focused [ownership probe](artifacts/linux-final-01/lsof-4.99.7/ownership-probe.json):

- Named owned loopback listener accepted, matching its owned process group.
- Named unrelated loopback listener rejected with `UNOWNED_LISTENER`; it continues serving after owned cleanup.
- Named wildcard listener rejected with `NON_LOOPBACK_LISTENER`.
- Both owned groups absent after successful cleanup; the fixture subsequently removes its own unrelated sentinel group.

The probe ran as UID 1001 with all capabilities dropped and NoNewPrivileges, under a 1 GiB/2 CPU/128 PID container bound. Peak memory, including npm install and source build, was 511,938,560 bytes. All memory and PID-limit event counters were zero. Source archive and runtime files remained those of C1; no listener verification, process-title behavior, or product code was changed for the comparison. This establishes the prerequisite correction, not a release gate pass. The isolated VM was retained running for the replacement immutable candidate; C2 shutdown is recorded above.

### Shared installer and final image validation

The reusable `scripts/linux-gate/install-lsof.sh` now builds the pinned executable into an explicit writable prefix. The runner hashes this installer as part of the image context. Docker uses the same script in a builder stage and pins libtirpc and libselinux runtime packages in its final stage. This replaces Ubuntu lsof 4.95.0 without changing process ownership verification or application process titles.

The actual updated gate image passed a repeated title matrix, application ownership/wildcard/unrelated-listener checks, and sandboxed Chromium launch. Every linked runtime library resolved. A separate UID-1001 container also ran the installer successfully into `/home/pwuser/.local`; its complete compile/install peaked at 80,142,336 bytes and recorded zero memory-limit/OOM events. See [validation identities and results](artifacts/linux-final-01/lsof-4.99.7/production/validation.json), [production-image probe](artifacts/linux-final-01/lsof-4.99.7/production/probe.log), and [unprivileged installation](artifacts/linux-final-01/lsof-4.99.7/production/user-install.log). These environment validations are separate from the still-failed C1 release gate.

## Accepted C2 evidence integrity and shutdown

The full copied C2 gate tree is covered by [SHA256SUMS](artifacts/linux-final-02/SHA256SUMS); the capability-probe tree has its own [SHA256SUMS](artifacts/linux-c2-capabilities/SHA256SUMS). These include the source and candidate archives, command logs, sandbox proof, report JSON, media artifacts, container identity/state, and the retained VM shutdown record. The checksum files exclude only themselves. No gate containers remained before the owned VM stopped, and the VM disk is retained for future reproduction.

| Report | SHA-256 |
| --- | --- |
| `result.json` | `d024a1d7343be636d70e122de49fb2e9e7dffb72f5188ccc0e8bec255e11fa26` |
| `validation.json` | `2fc7c7e0ecdecceb2866c13e31310c07a4d220f1e914e8165abebe37d8fd1abd` |
| `input.json` | `c9f2696e393c6f2fa90e190e02fdcc1c25a312f3926512b35482982f1894122d` |
| `sandbox.json` | `755bdfa74a16770e0d0d545442d7498921e48c38ffaf92de9be73fac60376113` |
| `container-state.json` | `25e4cd8b7ba52d430240c2ed343ae08e905ed18c128ab802c2c886d29b71428d` |
| `package-smoke/report.json` | `86e17ab6824a96251ee612f6d6518cd83432e0891b8559c8f1dbbe266ee240f6` |
| `repeatability/report.json` | `a39908449663340ec802a512b238fef5441a2a1c30c5fa3ca18d2a1ac145755a` |
| `shutdown.json` | `b34fd704554ecb0d54f93f13a1a73e5d649947b3a26740de6b36d69ccb97dcc4` |
| `SHA256SUMS` | `b7a577cff62f7261cec28edf80ffc49de4a21971c645220ddc28850669996dd9` |
