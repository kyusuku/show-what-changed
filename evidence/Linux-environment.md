# Linux gate environment

The pinned Linux environment passes a real nonroot sandboxed browser probe. The complete Linux application gate is not yet passed. Final results require the integrated commit and candidate tarball hash.

## Pinned inputs

| Input | Value |
|---|---|
| Platform | `linux/arm64` |
| Node | `24.22.2` |
| npm | `11.12.1` |
| Playwright | `1.64.1` |
| Chromium | `156.0.8078.4`, revision `1248` |
| Node base digest | `sha256:e80dee4ed3709cf1f8004e34ecfb90df71b7eac8ba0d7d6222ba238a823d1eea` |
| Playwright Ubuntu Noble base digest | `sha256:f609973e8fd93f38a5ddfd706a65805294247dae8d81b2541c0afe2787746197` |
| FFmpeg and ffprobe | Ubuntu `7:6.1.1-3ubuntu5`, with `libx264` |
| Git | Ubuntu `1:2.43.0-1ubuntu7.4` |
| lsof | Ubuntu `4.95.0-1build3` |
| procps | Ubuntu `2:4.0.4-4ubuntu3.3` |
| Docker Desktop | `4.69.0`, engine `29.4.0` |
| Linux kernel | `6.12.76-linuxkit` |
| Engine resources | 10 CPUs, 8,321,712,128 bytes memory |
| Gate resources | 2 CPUs, 3 GiB memory, 512 process limit |
| Retained local image | `swc-v01-linux-gate:node24.22.2-pw1.64.1-arm64-v1` |
| Last built local image digest | `sha256:4862e3c61f2adf4fe7fc3011dd4f11f85127d9c9175eda290256fee2e0d973f5` |

The environment uses the existing local Docker Desktop engine. Its 70 running containers were observed before work. No unrelated container was changed. The runner copies the source allowlist into its own container and installs its own dependencies. It does not mount the shared checkout or Docker socket.

## Interim runs

| Run | Scope | Result |
|---|---|---|
| `/private/tmp/swc-v01-linux-interim-01` | Current source archive with hash in `input.json` | Image built and dependencies installed. The gate probe failed because `playwright-core/browsers.json` is outside the package export map. The probe now reads the adjacent metadata file through the exported package path. No application tests ran. |
| `/private/tmp/swc-v01-linux-interim-02` | Current source archive with hash in `input.json` | Dependencies installed. Sandboxed Chromium failed at namespace-local `chroot` because all container bounding capabilities were dropped. The runner now retains only `SYS_CHROOT`, as required by the official Playwright seccomp profile. No application tests ran. |
| `/private/tmp/swc-v01-linux-interim-03` | Current source archive with hash in `input.json` | Nonroot sandboxed Chromium launched. The image supplied browser `156.0.8078.80`, so the exact expected `156.0.8078.4` assertion failed. The gate now installs through `playwright@1.64.1` into a fresh browser path rather than reusing the image's browser directory. No application tests ran. |
| `/private/tmp/swc-v01-linux-interim-04` | Current source archive with hash in `input.json` | Exact browser and sandbox probe passed. Typecheck, build, and schema checks passed. Unit tests failed on AppleDouble metadata and a combined output-cap/timeout fixture. Integration did not finish. Docker recorded `OOMKilled=true`. The container was stopped after eight minutes without a completed test file. This run is failed and incomplete. |
| `/private/tmp/swc-v01-linux-interim-05` | Metadata-free current source archive with hash in `input.json` | Exact browser and sandbox probe passed. Typecheck failed because the snapshot captured the runtime ownership refactor before its cross-file exports were complete. The first recorder case exceeded 60 seconds. Later cases failed on the incomplete lock exports. Docker recorded `OOMKilled=true`. The integrator requested shutdown and a coherent checkpoint before another run. The container is stopped and removed. This WIP run cannot establish application correctness. |

The first three failures concern the gate environment. Later runs are application-suite evidence with the limits described above. The runner keeps sandboxing enabled and uses no `--no-sandbox` or `SYS_ADMIN` workaround.

The successful sandbox proof at `/private/tmp/swc-v01-linux-interim-04/sandbox.json` records UID 1001, Chromium `156.0.8078.4`, caller user namespace `user:[4026531837]`, renderer user namespace `user:[4026542298]`, renderer seccomp mode 2, and `NoNewPrivs` 1. The launch arguments contain no `--no-sandbox`.

The runner now disables macOS tar metadata, prints individual test results, stops after a failed build prerequisite, and marks OOM or abnormal container exits as failed in `result.json`. The last two safeguards were syntax-checked after the final interim image build and will trigger an automatic image rebuild on the next invocation. The integrator split the output-cap assertion from the short process-timeout assertion. A complete rerun is pending the coherent checkpoint.

The first timed-out integration case in interim-05 was `real Chromium recorder > executes all seven operations with exact locator variants, fragment navigation, hover and live timers`. The captured WIP source and OOM event prevent a reliable application diagnosis from that run. The process that caused the memory peak has not been identified. No gate container remains running.

## Rerun

Use [the Linux runner instructions](../scripts/linux-gate/README.md). Final mode invokes the installed-package smoke and repeatability scripts and records missing scripts as failures. Snapshot mode leaves `releaseGateComplete` false even when the available suite passes.

Build the Lever shaped the rerunnable gate and its explicit input hashes. Model the Domain shaped the input manifest and per-stage result ledger. Prove It Works shaped the real renderer probe and per-command exit evidence. Fix Root Causes shaped the browser-version and tar-metadata corrections.
