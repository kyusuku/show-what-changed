# Run the Linux release gate

Run from a checkout with Node 24.22.2, npm 11.12.1, and access to a local Docker engine. The runner builds an isolated Linux arm64 image. It copies source into a disposable container and never mounts the source checkout, host Git configuration, credentials, browser profile, or Docker socket.

For an interim check of current files, use a new absolute output directory.

```sh
node scripts/linux-gate.mjs --snapshot --out /absolute/path/linux-interim
```

For final evidence, supply the complete reviewed commit SHA, candidate tarball, and its SHA-256.

```sh
node scripts/linux-gate.mjs --release \
  --commit "$SWC_CANDIDATE_COMMIT" \
  --tarball /absolute/path/show-what-changed-0.1.0.tgz \
  --tarball-sha256 "$SWC_CANDIDATE_SHA256" \
  --out /absolute/path/linux-release
```

The output directory must not already exist. The final mode reads source with `git archive` at the supplied commit. The interim mode copies the current source allowlist and labels the result as a dirty snapshot. Both modes exclude host dependency trees, Git metadata, local environment files, and private evidence. Each output includes the exact source archive and its hash.

The gate installs dependencies in the container, proves a sandboxed browser launch, and runs the configured typecheck, build, schema check, lint, format check, contract tests, privacy-scanner tests, unit tests, and integration tests. Test files run sequentially. The source allowlist includes the public specification and status ledger required by contract tests. Private evidence directories remain excluded. Final mode also invokes these required scripts. Missing scripts fail their stages.

```sh
node scripts/verify-package-source.mjs /tmp/swc-candidate.tgz /home/pwuser/gate-evidence/package-source-binding
node scripts/release-smoke.mjs /tmp/swc-candidate.tgz /home/pwuser/gate-evidence/package-smoke
node scripts/compatibility-smoke.mjs /tmp/swc-candidate.tgz /home/pwuser/gate-evidence/host-compatibility
node scripts/real-app-smoke.mjs /tmp/swc-candidate.tgz /home/pwuser/gate-evidence/public-app
node scripts/repeatability.mjs /tmp/swc-candidate.tgz /home/pwuser/gate-evidence/repeatability
```

Read `result.json` for each command, exit code, timestamps, and status. Each stage records its cgroup memory counters, lifetime peak memory, and host memory pressure before and after the command. Read the matching stdout and stderr logs for details. The runner stops when a build prerequisite fails or a stage loses a process to OOM. An OOM or abnormal container exit makes the result fail. `platformChecksComplete` can be true only in final mode when every invoked stage passes. `releaseGateComplete` remains false because a scripted platform suite cannot accept all G01 through G24 requirements. Child reports carry their remaining Docker and independent motion-review obligations into `pendingAcceptance`. The final independent review records acceptance in the status ledger.

Package source binding repacks the built source with pinned npm, scripts disabled, and isolated npm state. The supplied and rebuilt archives must match byte for byte. Matching generated schemas alone is insufficient. This check does not replace the public privacy scan or final manual acceptance.

The container runs as `pwuser` with UID 1001. It has two CPUs, 3 GiB of memory, a 512-process limit, private shared memory, and no published ports. It uses `no-new-privileges` and drops every bounding capability except `SYS_CHROOT`. Chromium needs this capability in its own user namespace. It does not receive `SYS_ADMIN`. Chromium launches with `chromiumSandbox: true`, and the probe rejects `--no-sandbox`. The probe renders a real page and checks renderer seccomp and `NoNewPrivs` state.

The runtime bases are pinned by platform-specific digest in the Dockerfile. The Node image provides Node 24.22.2. The Playwright image supplies Ubuntu and browser libraries. The build installs Chromium through `playwright@1.64.1` into a fresh directory, and the gate checks revision 1248 and Chromium 156.0.8078.4. npm is pinned to 11.12.1. FFmpeg, Git, procps, and the lsof runtime libraries have exact Ubuntu package pins. The full package inventory, local image digest, platform, and Docker engine identity are saved with each run. A changed runner image context, including the lsof installer, rebuilds the image. `--build` also requests a rebuild.

Linux requires lsof 4.99.7 or later. Older upstream versions can silently omit processes whose names contain unbalanced parentheses, including the truncated Next.js server name ([upstream issue 359](https://github.com/lsof-org/lsof/issues/359)). The gate builds unmodified [lsof 4.99.7](https://github.com/lsof-org/lsof/releases/tag/4.99.7) in a separate stage. Its source archive SHA-256 is `4a10391aab0b8ce1f539e82a1966693b2a6cf225972a6504ebb7ec4fa71675de`. The final image contains the binary, its Purdue Research Foundation permissive license at `/usr/local/share/licenses/lsof/COPYING`, and source provenance at `/usr/local/share/show-what-changed/lsof-source.txt`. Compilation tools do not enter the final stage.

For an explicit local Linux installation, the same [installer](install-lsof.sh) accepts a writable absolute prefix. It checks prerequisites, verifies the source digest before extraction, and installs the binary, license, and provenance. It does not install system packages or change `PATH`. On Ubuntu, install the build prerequisites and then run it as your ordinary user:

```sh
sudo apt-get update
sudo apt-get install --yes build-essential curl pkg-config libtirpc-dev libselinux1-dev
sh scripts/linux-gate/install-lsof.sh "$HOME/.local"
export PATH="$HOME/.local/bin:$PATH"
lsof -v
```

The installer builds only the executable; it does not require manpage-generation tools. The linked runtime libraries are libtirpc and libselinux, plus their system dependencies. The tool never invokes this installer implicitly.

The vendored [Playwright seccomp profile](https://github.com/microsoft/playwright/blob/v1.64.1/utils/docker/seccomp_profile.json) is copied without modification from Playwright v1.64.1. Its SHA-256 is `cc3e61cabda6bbc1e53e54d27ba4d55a9d3be829b6dd1a596f4a7b31b1cc7849`. It permits the namespace operations Chromium's sandbox needs. Playwright is copyright Microsoft Corporation and licensed under [Apache License 2.0](PLAYWRIGHT-LICENSE). This development-only profile is outside the npm package allowlist.

The runner removes only its own generated `swc-v01-linux-*` container. It retains the image and output directory for inspection and reruns. It never prunes Docker or changes another container.

The Docker engine needs enough free memory for the gate's bounded workload. A shared VM can kill gate processes under global memory pressure even when the gate stays below its own memory limit. Use the recorded `memoryPeak`, `memoryMax`, and `memoryEvents` values to distinguish those cases. A new `oom_kill` event with zero `max` and `oom` events does not justify increasing the container limit.

To use an independent Docker engine, set `DOCKER_HOST` for the runner command. This does not change the default Docker context. For the isolated Lima instance provisioned for this release, use its explicit socket.

```sh
DOCKER_HOST=unix:///private/tmp/swc-lima/swc-v01-gate/sock/docker.sock \
  node scripts/linux-gate.mjs --snapshot --out /absolute/path/linux-interim
```

The [Lima configuration](lima.yaml) pins the Ubuntu guest image and Docker version. It uses four GiB RAM, two CPUs, a 32 GiB sparse disk, no host mounts, and no forwarded SSH agent. Lima 2.2.1 was used for this release. Create that isolated instance with the following command after installing Lima.

```sh
LIMA_HOME=/private/tmp/swc-lima limactl start \
  --name=swc-v01-gate --mount-none --tty=false scripts/linux-gate/lima.yaml
```

Stop only this instance after copying out the gate evidence.

```sh
LIMA_HOME=/private/tmp/swc-lima limactl stop swc-v01-gate
```
