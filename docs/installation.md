# Install show-what-changed

Use Node.js 24 on macOS or Linux. The tool's npm package is separate from your app's dependencies. Your app can use another package manager or runtime.

## Use the published 0.1.1 version

Version `0.1.1` does not include `setup`. These commands install that version and its pinned browser, then check the prerequisites.

```sh
npm install -g show-what-changed@0.1.1
node "$(npm root -g)/show-what-changed/node_modules/playwright/cli.js" install chromium
show-what-changed doctor
```

Continue when `doctor` reports `doctor: ok (exit 0)`. Then [configure your app](app-setup.md).

## Use setup in the next release

The `0.1.2` branch adds `show-what-changed setup`. It is not yet published to npm. Once that release is available, install the tool and run setup.

```sh
npm install -g show-what-changed
show-what-changed setup
```

The setup command installs Chromium through this package's Playwright dependency. It does not select a global or application-local Playwright installation. Run setup again after a tool upgrade to get its matching browser.

For automation, use `show-what-changed setup --json`. The command emits one result on stdout and writes progress to stderr. Exit `0` means required tool checks passed. Missing optional Docker tools do not block host-process recipes.

A browser download alone does not establish readiness. If a system dependency is missing, follow the reported instructions and rerun setup. The command does not run application code, create a recipe, or install operating-system packages.

## Check requirements

| Requirement | Scope |
| --- | --- |
| Node.js | Tool runtime `24.x`. Candidate checks use `24.22.2`. |
| npm | Installs this CLI. Candidate checks use `11.12.1`. Applications may use other tools. |
| Playwright and Chromium | Package dependency `1.64.1`, with Chromium revision `1248` installed separately. |
| Chromium sandbox | Linux must allow the pinned browser to create its sandbox. See the Linux setup note below. |
| FFmpeg and ffprobe | Matching system versions with H.264 `libx264` and the composition filters checked by `doctor`. Development macOS checks use `9.0.2`. |
| Git, `ps`, and `lsof` | Source and listener ownership checks. Linux needs `lsof` `4.99.7` or newer. macOS uses its system `lsof`. |
| Application tools | Declared by the recipe, such as Python, npm, or pnpm. The tool's Node version does not select the application's runtime. |
| Docker Engine and buildx | Required for container recipes. Host-process recipes do not require Docker. |

`setup` installs the browser required by the tool's pinned Playwright version, then runs `doctor`. It does not install system runtimes, FFmpeg, Docker, or your application dependencies. A successful `doctor` checks tool prerequisites. It does not certify an application recipe.

### Linux setup

Older `lsof` versions can omit listeners when Linux truncates a process name. Linux checks reject versions below `4.99.7` or an unidentifiable version. See the [upstream issue](https://github.com/lsof-org/lsof/issues/359).

If your distribution does not provide a supported `lsof`, use a checkout of the [public tool repository](https://github.com/kyusuku/show-what-changed). From that checkout, Ubuntu users can build the pinned version into a private installation directory.

```sh
sudo apt-get update
sudo apt-get install -y build-essential pkg-config libtirpc-dev libselinux1-dev curl ca-certificates ffmpeg git procps
sh scripts/linux-gate/install-lsof.sh "$HOME/.local"
export PATH="$HOME/.local/bin:$PATH"
lsof -v
```

The installer verifies its source hash and does not edit shell configuration.

Ubuntu 23.10 and newer can restrict the user namespaces that Chromium needs. If browser startup reports `No usable sandbox`, use the scoped AppArmor profile described in Option 2 of [Chromium's setup guide](https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md). The CLI keeps Chromium's sandbox enabled.

## Fix missing system tools

On macOS with Homebrew installed, install FFmpeg and its matching ffprobe.

```sh
brew install ffmpeg
```

Git, `ps`, and `lsof` must also be available on `PATH`. Follow the individual result from `doctor` for missing tools. If Git is missing on macOS, install Apple's command line tools with `xcode-select --install`.

On Linux, install FFmpeg, Git, `ps`, and a supported `lsof` using your distribution's package manager. The Linux setup instructions above cover older `lsof` versions and Chromium sandbox restrictions.

If Chromium lacks Linux shared libraries, the pinned Playwright installer can install them with administrator access. Run this yourself only when needed.

```sh
node "$(npm root -g)/show-what-changed/node_modules/playwright/cli.js" install --with-deps chromium
```

Setup never runs this privileged variant. Playwright's own FFmpeg download does not replace the system FFmpeg and ffprobe required for video composition.

## Use a proxy or a custom browser cache

Playwright supports `HTTPS_PROXY`, custom certificate settings, and `PLAYWRIGHT_BROWSERS_PATH`. Use the same browser-cache setting for setup and subsequent comparisons. See [Playwright browser installation](https://playwright.dev/docs/browsers) for supported settings.

## Install without global npm access

If global npm installation reports a permissions error, use an npm installation managed by your Node version manager, or follow [npm's permissions guide](https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally). Do not use `sudo npm install` as the default fix.

For a temporary installation of an unreleased reviewed archive, use a private prefix outside your app's checkout.

```sh
SWC_INSTALL="$(mktemp -d)"
npm install --prefix "$SWC_INSTALL" /absolute/path/to/show-what-changed-0.1.2.tgz
SWC="$SWC_INSTALL/node_modules/.bin/show-what-changed"
"$SWC" setup
```

Replace the archive path with the file you reviewed. Use `"$SWC"` for later tool commands in that shell. The temporary prefix does not modify the app's package manifest or lockfile.
