# Linux recorder failure diagnosis

The focused recorder test fails because the shared Docker Desktop Linux VM runs out of memory. The diagnostic container does not reach its 3 GiB limit. This run does not establish product correctness or complete the Linux release gate.

## Reproduction

On 2026-11-01 at 21:15:47 UTC, the coherent source snapshot passed typecheck and ran this single integration case in the pinned Linux arm64 image.

```sh
node node_modules/vitest/vitest.mjs run test/integration/recorder.test.ts \
  --testNamePattern='executes all seven' \
  --maxWorkers=1 --no-file-parallelism --reporter=verbose
```

The source archive SHA-256 is `6f30d01a7f1afe56aa98a86dff7e03e95182383023492f7204ccac1ed384fbf5`. The image is `sha256:4862e3c61f2adf4fe7fc3011dd4f11f85127d9c9175eda290256fee2e0d973f5`. The container kept the original two CPU, 3 GiB memory, 512 process, nonroot, and sandbox settings. Product and test source were not modified.

The test completed with a failure after 23.45 seconds. Both sides passed the first six steps. The CSS action's screenshots then returned `STEP_TIMEOUT`, and later steps were blocked. The Playwright log has a 19.7-second gap during those screenshots. The independent resource sampler also stopped progressing during that interval.

## Resource evidence

The diagnostic wrapper sampled cgroup counters and process RSS every 200 milliseconds. The kernel's lifetime peak counter records peaks between samples.

| Measurement | Observed value |
|---|---:|
| Container `memory.max` | 3,221,225,472 bytes |
| Container lifetime `memory.peak` | 556,781,568 bytes |
| Highest sampled `memory.current` | 554,184,704 bytes |
| `memory.events` increase for `max` | 0 |
| `memory.events` increase for `oom` | 0 |
| `memory.events` increase for `oom_kill` | 3 |
| Docker VM `MemAvailable` immediately after failure | 288,492 KiB |
| Docker VM `SwapFree` immediately after failure | 204 KiB of 1,048,572 KiB |
| Docker VM global `oom_kill` after failure | 81 |

Linux defines `max` as attempts to exceed a cgroup's memory maximum. Its `oom` counter records allocations about to fail at the cgroup limit. Its `oom_kill` counter includes processes killed by any OOM killer. The zero limit counters and a lifetime peak below one fifth of the cap rule out this container's own memory maximum. The exhausted VM swap and severe memory pressure support global or ancestor OOM as the cause. See the [Linux cgroup v2 memory documentation](https://docs.kernel.org/admin-guide/cgroup-v2.html#memory).

Immediately before the OOM event, the sampled Chromium GPU process and both renderers were live. Immediately after `oom_kill` increased by three, those same PIDs had zero RSS, one thread, and empty command lines. Their parent browser and Vitest processes remained. Chromium then started a replacement GPU process with `--gpu-recent-crash-count=1`. These observations identify the likely OOM victims. The kernel victim log was not available through the nonprivileged container, so PID-level OOM attribution remains an inference.

This is one diagnostic run. It is not a performance comparison. Resource pressure invalidates its timing as a normal application performance measurement.

## Preserved evidence

Raw artifacts are in `/private/tmp/swc-linux-diagnosis-01`.

- `source.tar` preserves the exact source snapshot.
- `diagnostic.mjs` is the temporary rerunnable instrumentation.
- `recorder-01.resources.jsonl` records the sampled processes and counters.
- `summary.json` reduces those samples to the peak and OOM transitions.
- `recorder-01.stdout.log` contains the test result and step statuses.
- `recorder-01.stderr.log` contains Playwright API and browser logging.
- `recorder-01.result.json` records the command, timestamps, and exit status.
- `host-memory.txt` preserves a follow-up VM memory snapshot.
- `container-stats.txt`, `container-inspect.json`, and `docker-info.json` preserve the environment identity and read-only resource inventory.
- `docker-oom-events.log` preserves Docker Desktop's OOM event notifications near the failed test.

The first immediate VM memory reading appears in the task's tool output. `host-memory.txt` is a later reading, so its free-memory values differ.

## Required environment change

Raising this container's memory limit will not address the measured failure. The existing Docker Desktop VM has 70 unrelated running containers. No unrelated container was stopped or changed. Docker Desktop was not restarted or reconfigured.

The host has 32 GiB RAM, and `memory_pressure -Q` reports 55 percent free. It has 177 GiB available disk space. No Lima, Colima, Podman, QEMU, vfkit, Tart, Multipass, or UTM executable was installed during the inventory. Only Docker Desktop and the default Docker context were available.

An independent, bounded Linux VM now isolates the release gate from the existing VM's memory pressure. Lima's native macOS Virtualization framework driver supports this arrangement, and its mount controls disable host directory sharing. See [Lima's VZ driver](https://lima-vm.io/docs/config/vmtype/vz/) and [mount controls](https://lima-vm.io/docs/usage/).

## Independent Linux environment

Lima 2.2.1 was installed from its official Homebrew formula. The owned `swc-v01-gate` VM uses four GiB RAM, two CPUs, and a 32 GiB sparse disk. Its configuration has no host mounts, no forwarded SSH agent, no imported host SSH public keys, and no propagated proxy environment. It exposes only its private Docker socket, in addition to Lima's own management SSH connection. Wildcard rules disable automatic guest TCP and UDP port forwarding.

The pinned guest image is `https://cloud-images.ubuntu.com/releases/noble/release-20260926/ubuntu-24.04-server-cloudimg-arm64.img`, with SHA-256 `1d6bffe64b848468ac97f821d369a4846d983de1800ccf6b5ec8853e85cefc55`. The running guest reports Ubuntu 24.04.5 LTS and kernel `6.8.0-142-generic`. Docker is `29.4.0`, with `containerd.io` package `2.4.2-3~ubuntu.24.04~noble`. The downloaded official Docker install script had SHA-256 `7f966774378d94acf1817eb1aba213c21b576d01d1ee2f0656fe36e75ffa1258`.

The gate image was exported from Docker Desktop and imported into the isolated engine. Its image ID remains exactly `sha256:4862e3c61f2adf4fe7fc3011dd4f11f85127d9c9175eda290256fee2e0d973f5`. The default Docker context remains `desktop-linux`. Gate commands select `unix:///private/tmp/swc-lima/swc-v01-gate/sock/docker.sock` through a command-local `DOCKER_HOST`.

The guest had 3,661,430,784 bytes of available memory before the environment probe. Its unchanged three GiB container passed the real Chromium sandbox probe at 21:24:17 UTC. That probe records UID 1001, Chromium `156.0.8078.4`, revision `1248`, a separate renderer user namespace, seccomp mode 2, and `NoNewPrivs` 1. It rejects `--no-sandbox`. The new sandbox proof is at `/private/tmp/swc-linux-diagnosis-01/lima-probe/sandbox.json`.

The VM identity, guest package identity, Docker identity, provisioning logs, and effective Lima configuration are preserved in the same evidence directory. [The checked-in Lima configuration](../scripts/linux-gate/lima.yaml) and [runner instructions](../scripts/linux-gate/README.md) reproduce the setup. The diagnostic container in Docker Desktop was removed after its evidence was copied out.

The complete Linux product gate remains pending the coherent integration checkpoint. The runner now records cgroup lifetime peaks, OOM events, and host memory pressure before and after every stage. It stops on a newly observed OOM kill. The modified runner passes Node's syntax check. Its next actual gate invocation must validate the changed reporting behavior.

The updated runner image was built inside the independent VM from the same pinned runtime inputs. Its identity is `sha256:1523e47dcfd7a2742b031ca4ef42918620e546646c5d4dc0b910c3fdfafde57b`, and its runner context hash is `c2076d7603eff6b8a7c6ac723fbb9688a666bd834b0444e4baa191cf41de4829`. After this build, the VM had 3,627,864,064 bytes available and global `oom_kill` remained zero. `lima-runner-image.json`, `runner-context.json`, and `lima-runner-image-build.log` preserve the build identity and evidence.

The completed probe container was removed after evidence collection. The owned VM remains running for the pending product gate. It must be stopped after the final gate evidence has been saved. Docker Desktop and its unrelated containers remain unchanged.

Fix Root Causes shaped the decision to investigate host memory pressure instead of changing recorder deadlines. Explain the Number shaped the use of the kernel lifetime peak and OOM event counters instead of a memory reading after failure.

## Coherent interim run and deadline cleanup race

The next immutable source snapshot has SHA-256 `f3b05c36643ca7c5cf6250b0c4264844cf4161d72c295682ccee22432c3786fa`. It includes the completed terminal-cancellation changes and `provenance-capture.test.ts`. The source archive and all results are under `/private/tmp/swc-linux-interim-06`.

The originally failing all-actions recorder case passes in the isolated VM. Typecheck also passes. The focused case reports one passed test, with the remaining recorder cases intentionally filtered out. Its container lifetime peak is 655,122,432 bytes, and every memory-limit and OOM counter remains zero.

The complete interim stage sequence then ran from the same archive through `container.mjs`. Installation, sandbox verification, typecheck, build, schema check, and all 171 unit tests across 14 files passed. Integration completed with 77 passed tests and one failure across six files. The new provenance-capture case passed. The container lifetime peak reached 1,094,643,712 bytes. No memory limit or OOM event occurred. `result.json` correctly records `status: failed` and `releaseGateComplete: false`.

The single failure is `real Chromium recorder > preserves the real overall deadline cancellation code during a pending action`. Its cancellation assertion succeeds. Its `afterEach` cleanup assertion receives `CLEANUP_FAILED` for an owned context. This is a separate product cleanup race, revealed after removing the environment pressure.

The failure reproduced in the full suite, an unchanged focused rerun, and a focused rerun with instrumentation in a disposable test copy. The instrumentation records this ordering.

| Relative time | Event |
|---|---|
| 0 ms | First `context.close()` starts |
| 1 ms | Second `context.close()` starts |
| 57 ms | The supervisor sends `SIGTERM` to the browser process group |
| 123 ms | Both close promises reject while `browser.isConnected()` remains true |
| 124 ms | Both context `close` events fire, followed by browser `disconnected` |
| 138 ms | The browser process exits with code 143 |

The exact rejection is `Protocol error (Target.disposeBrowserContext): Failed to find context with id ...`. These events show successful resource teardown with an error arriving before closure notifications. They do not show a surviving context. `createSide` in `src/recorder/index.ts` caches the close rejection because its immediate `browser.isConnected()` check still returns true. The supervisor's per-process deadline timer in `src/runtime/supervisor.ts` terminates the adopted browser while the run's cleanup is closing contexts.

`cleanup-ordering.json` contains the complete ordered events. `focused/recorder-deadline-01.stderr.log` preserves the unchanged focused reproduction. `focused/recorder-deadline-probe-01.stderr.log` preserves the instrumented reproduction. `recorder-diagnostic.test.ts` preserves the disposable instrumentation. That test was removed from the container after collection, and no repository product file was edited. The root agent owns the product fix and subsequent immutable candidate.

## Cleanup fix verification

The first fix removed the independent timer for processes with the browser purpose. Its original-deadline and new ordered-cleanup regressions both passed in Linux, followed by all 43 tests in the recorder and lifecycle files. Those results are preserved under `/private/tmp/swc-linux-interim-07`.

Independent scope review found that `SpawnSpec` also permits a spawned browser command with its own explicit timeout. A purpose-based guard would suppress that timeout too. The root agent narrowed the guard to `anchored`, which distinguishes supervisor-spawned commands from adopted browser processes. Spawned commands keep their independent timeout. Adopted browsers rely on the run's bounded cleanup sequence.

The final Linux diagnostic delta is preserved in `/private/tmp/swc-linux-interim-08/input.json`. It starts from the immutable interim-06 archive and changes only these files.

| File | SHA-256 |
|---|---|
| `src/runtime/supervisor.ts` | `d8ed0dc04399b9cedf375192dd41d4dcc392bdc843c315768877acd5c1224953` |
| `test/integration/lifecycle.test.ts` | `b4f446b66bc2803e8981444ec33a42b298558b6ed3cce497012559eb60721baa` |
| `test/unit/runtime.test.ts` | `7eaf1656355667e522360d46f2113f0a659753b29f62e82bf3ed8bc5ebaa1451` |

Typecheck and all four targeted Linux tests pass with the final guard. They cover the original recorder deadline case, context cleanup before browser termination, explicit encoding-process timeout, and explicit spawned-browser timeout. The ordered-cleanup regression checks that Chromium remains connected during the context disposer, then disconnects, and every recorded owned process group is gone.

`recorder-final-guard-08.stdout.log` records four passed tests and 54 deliberately filtered tests. `post-test-resources.txt` shows no Chromium or command children after the run, and every memory-limit and OOM counter remains zero. The reused container's lifetime peak remains 1,094,643,712 bytes. These are diagnostic delta checks. They do not replace the full final gate on the immutable release commit and candidate tarball.
