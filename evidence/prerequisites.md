# Build prerequisites

This inspection supports the complete v0.1 build requested in `docs/build-goal.md`. It establishes available tools and access. It does not establish a passed platform gate or release readiness.

Observed on 2026-11-01 at 20:07:23 UTC, which is 2026-11-02 at 03:07:23 Asia/Bangkok. The inspected `spec.md` SHA-256 was `65f604f5ac2acad60e3bec0882b18f1bdc4ebfb3a51d3215f4396b6b1ec13ab8`.

`PASS` means the named prerequisite was directly observed. `ISSUES` means a usable path exists but needs setup or verification. `BLOCKED` means the required access was unavailable. These labels apply to each prerequisite separately.

| Prerequisite | Status | Observed evidence | Remaining work |
|---|---|---|---|
| macOS host | PASS | `sw_vers` exited 0. macOS 27.0, build 26A428. `uname -a` exited 0 and reported Darwin arm64. | Run the macOS smoke gate against the final installed tarball with Node 24. |
| Node 24 | ISSUES | `node --version` exited 0 with `v25.9.0` at `/opt/homebrew/bin/node`. No Node 24 was found in the common Homebrew, nvm, fnm, mise, or Volta locations, or a bounded search of local caches. | The integrator owns a project-local pinned Node 24 installation. Do not count Node 25 results as the required Node 24 gate. |
| npm | PASS | `npm --version` exited 0 with `11.12.1`, at `/opt/homebrew/bin/npm`. | Use the pinned Node 24 toolchain for release checks and record its npm version. |
| Git | PASS | `git --version` exited 0 with `2.53.0`, at `/opt/homebrew/bin/git`. | No Git initialization, commits, push, checkout changes, or global configuration changes were performed by this inspection. |
| Chromium cache | ISSUES | Both Chromium revision directories `1228` and `1234` exist. The revision 1234 executable's `--version` exited 0 with `Google Chrome for Testing 151.0.7922.34`. | Match the browser to the pinned Playwright dependency, then prove browser launch/capture. A cached executable alone is insufficient. |
| FFmpeg, ffprobe, H.264 | PASS | Both version commands exited 0 with `9.0.2`. A disposable 30-frame encode through `libx264` and an actual `ffprobe -count_frames` both exited 0. Output was H.264, `yuv420p`, 1280×800, `30/1` FPS, 30 decoded frames, and 1.000000 seconds. | Repeat the media checks against product output. This probe is not the product encoder acceptance test. |
| `lsof` | PASS | `/usr/sbin/lsof` exists and `lsof -v` reported version 4.91. | Exercise port/process ownership in runtime integration tests. |
| `ps` | PASS | `/bin/ps` exists. `ps -p $$ -o pid,ppid,command` exited 0 after a read-only sandbox escalation. | Runtime process tests need an execution context with process inspection permission. |
| Disk | PASS | `df -h . /tmp` exited 0. About 185 GiB was available on the host data volume. | Recheck if large media or image downloads materially consume this space. |
| Agent capacity | PASS | The collaboration host advertises four total concurrency slots. The roster at this check contained the integrator, this inspector, and two completed architecture workers. | The integrator schedules the remaining work. No worker was spawned by this inspection. |
| Local Linux engine | PASS | Escalated `docker version` and `docker info` exited 0. Docker Desktop 4.69.0 provides Linux engine 29.4.0, kernel `6.12.76-linuxkit`, architecture `aarch64`, 10 CPUs, and 8,321,712,128 bytes of configured memory. | Use an isolated disposable container for the Linux gate. Do not change the 70 existing running containers. |
| Pinned Linux Node/browser image | ISSUES | Image-list checks exited 0. Only `node:20-alpine` matched the Node filter. No Playwright or Ubuntu image matched their filters. | Prepare and pin a Node 24 Linux environment with the selected Playwright revision and system prerequisites. No image was pulled or container started by this inspection. |
| Existing GitHub repository | PASS | The `gh` fallback verified `kyusuku/show-what-changed`, owner `kyusuku`, `private: true`, visibility `private`, default branch `main`, size 0, and neither archived nor disabled. The contents endpoint returned the expected 404 message `This repository is empty.` | Recheck current contents before the first push if another actor may have written to it. Do not change visibility. |
| GitHub write access | PASS | The repository response reported current `push`, `maintain`, and `admin` permissions as true. `gh api user --jq '{login,plan:.plan.name}'` reported login `kyusuku`. | This proves available access, not that a push or CI run occurred. |
| GitHub connector access | ISSUES | The connector profile is `kyusuku`, but its `get_repo` call returned 404 for the private repository. The installed `gh` credential successfully read it. | Use `gh` as the verified fallback. No connector installation permissions were changed. |
| Repository Actions permission | PASS | `gh api repos/kyusuku/show-what-changed/actions/permissions` exited 0 with `enabled: true` and `allowed_actions: all`. | Workflow execution and runner billing are separate checks. No workflow was started. |
| Included GitHub CI allowance | BLOCKED | Both `/users/kyusuku/settings/billing/actions` and `/users/kyusuku/settings/billing/usage` returned HTTP 404. `gh` also reported that the operation requires the `user` scope. The accessible profile's plan was null. | Included usage and a zero-spend hosted-runner path are unverified. Do not infer a balance from Actions being enabled. The local Linux engine provides a route that does not require a hosted CI charge. |
| npm package name | PASS | `npm view show-what-changed name version dist-tags maintainers --json --fetch-retries=0 --fetch-timeout=10000` exited 1 with registry `E404` on 2026-11-01. No public package record was found. | Availability is not a reservation or publishing guarantee. Recheck immediately before owner publication. |
| npm publish identity | BLOCKED | `npm whoami --registry=https://registry.npmjs.org/ --fetch-retries=0 --fetch-timeout=10000` exited 1 with `ENEEDAUTH`. No credential value was read or printed. | Registry login and any required second factor remain owner handoff actions. No package was published or reserved. |
| Real-app candidate layout | PASS | The public React Jobs app described below has a committed root npm lockfile, a supported explicit-route/custom-command path, and no workspace or registry-layout exclusions found by static inspection. | Run the actual Node 24 install, startup, and three consecutive product comparisons. |
| T17 execution | ISSUES | Only source inspection and a public clone have occurred. No dependency installation or app server was run by this inspector. | T17 remains unpassed until all three installed-CLI comparisons and their source IDs, commands, platform, artifacts, and limitations are recorded. |

## Reproducible host checks

The initial shell sandbox denied `ps`, Docker socket access, and direct outbound registry/API connections. The read-only probes succeeded through the normal sandbox escalation path. This was a sandbox limitation, not evidence that those tools were missing. No automatic approval rejection occurred.

```sh
uname -a
sw_vers
command -v node npm git ffmpeg ffprobe lsof ps docker gh
node --version
npm --version
git --version
ffmpeg -version
ffprobe -version
lsof -v
ps -p $$ -o pid,ppid,command
df -h . /tmp
docker version --format '{{json .}}'
docker info --format 'server={{.ServerVersion}} os={{.OSType}} arch={{.Architecture}} cpu={{.NCPU}} memory={{.MemTotal}} running={{.ContainersRunning}}'
docker image ls --format '{{.Repository}}:{{.Tag}} {{.ID}}' --filter reference='*node*'
docker image ls --format '{{.Repository}}:{{.Tag}} {{.ID}}' --filter reference='*playwright*'
docker image ls --format '{{.Repository}}:{{.Tag}} {{.ID}}' --filter reference='*ubuntu*'
```

The disposable media probe was `/tmp/swc-prerequisite-h264.mp4`.

```sh
ffmpeg -hide_banner -loglevel error -f lavfi \
  -i color=c=black:s=1280x800:r=30 -frames:v 30 \
  -c:v libx264 -pix_fmt yuv420p -y /tmp/swc-prerequisite-h264.mp4
ffprobe -v error -count_frames -select_streams v:0 \
  -show_entries stream=codec_name,pix_fmt,width,height,r_frame_rate,nb_read_frames,duration \
  -of json /tmp/swc-prerequisite-h264.mp4
```

## Repository and registry checks

The GitHub connector was attempted first. Its private-repository read returned 404. The installed `gh` fallback supplied the verified metadata and access without printing a credential. The repository metadata read exited 0. The empty contents read exited 1 with HTTP 404. The Actions permission read exited 0. The two billing reads exited 1 with HTTP 404.

```sh
gh api repos/kyusuku/show-what-changed \
  --jq '{full_name,private,visibility,default_branch,size,owner:.owner.login,permissions,archived,disabled,html_url}'
gh api user --jq '{login,plan:.plan.name}'
gh api repos/kyusuku/show-what-changed/contents --jq '[.[]|{name,type,sha}]'
gh api repos/kyusuku/show-what-changed/actions/permissions \
  --jq '{enabled,allowed_actions,selected_actions_url}'
gh api users/kyusuku/settings/billing/actions \
  --jq '{total_minutes_used,total_paid_minutes_used,included_minutes,minutes_used_breakdown}'
gh api users/kyusuku/settings/billing/usage --jq '{usageItems,usage_items}'
npm view show-what-changed name version dist-tags maintainers --json \
  --fetch-retries=0 --fetch-timeout=10000
npm whoami --registry=https://registry.npmjs.org/ \
  --fetch-retries=0 --fetch-timeout=10000
```

## T17 candidate

Use the public [React Jobs app](https://github.com/bradtraversy/react-crash-2024) at exact upstream commit [`fd4407ce0c26ede6b59fe11e21e207593629ae9a`](https://github.com/bradtraversy/react-crash-2024/commit/fd4407ce0c26ede6b59fe11e21e207593629ae9a). The disposable clone is `/tmp/swc-prerequisites-real-app`.

```sh
git -c core.hooksPath=/dev/null clone --depth 1 \
  https://github.com/bradtraversy/react-crash-2024.git \
  /tmp/swc-prerequisites-real-app
```

The clone and static inspection exited 0. Its manifest has one root package, no `workspaces`, no `packageManager`, and no root Node engine constraint. The committed `package-lock.json` has lockfile version 3 and 440 package entries. All resolved package URLs use `https://registry.npmjs.org/`. No `file:`, `link:`, or `workspace:` dependency was found. No conflicting root lockfile, `.npmrc`, `.gitattributes`, `.gitmodules`, or nonregular tracked file mode was found. Locked Vite is 5.1.6, whose Node engine `^18.0.0 || >=20.0.0` accepts Node 24. Runtime compatibility still requires execution.

Select only `/add-job`. `src/App.jsx` assigns that route directly to `AddJobPage` without a loader. `AddJobPage`, its layout, and its navigation use local component state and bundled assets. Static inspection found no mount-time fetch, storage API, or external resource URL in those components. The remainder of the app has an API dependency. Submitting the form performs a POST through the `/api` proxy, so the T17 scenario must leave the form unsaved and stay on this route.

Use the explicit dev command below. The dynamic port overrides the Vite config's default 3000 and `--strictPort` prevents a silent fallback.

```json
["npm", "run", "dev", "--", "--host", "127.0.0.1", "--port", "{port}", "--strictPort"]
```

A suitable scenario asserts the `Add Job` heading, fills `#title` with `Disposable QA role`, fills `#description` with synthetic text, and hovers the exact `Home` navigation link without clicking it. Keep the submit button untouched. Use an isolated context for each side and run. Create the AFTER UI edit only inside the disposable clone, then record the resulting exact source identity before running the same comparison three times. Do not include the external app's source or dependency tree in the release package. The source inspection is the candidate-selection evidence. It is not a substitute for T17 execution evidence.

## Verification boundary

The Prove It Works principle shaped two checks. The H.264 prerequisite was tested by encoding and decoding a real disposable file. The remote repository was checked through authenticated metadata and contents reads. Neither installed-tool presence nor repository access was used to claim a completed product gate.
