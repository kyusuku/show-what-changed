# N0 media capability proof

The synthetic media path passed on macOS arm64 with Node v24.22.2, Playwright 1.64.1, Chromium 156.0.8078.4 revision 1248, and FFmpeg/ffprobe 9.0.2. This proves local capabilities. It is not a product comparison, a Linux release gate, or evidence that the recorder/composer public APIs are complete.

This is a historical capability report. Its original probe has been retired and is not a current rerun command. The maintained [installed motion check](../scripts/revision-0.3-motion-check.mjs) verifies the current capture and composition path. Its required candidate and acceptance sequence are documented in [release readiness](../docs/release-readiness.md).

The managed shell sandbox prevented Chromium from starting. The verified run used the normal execution escalation. Chromium itself launched with `chromiumSandbox: true`; the inspected owned process groups contained no `--no-sandbox` argument. The probe uses the installed browser and dependencies, with no network access needed after font setup. `SWC_FFMPEG` and `SWC_FFPROBE` can override the probe's macOS executable defaults. The product still needs its separate doctor validation.

## Verified outputs

- Two fresh capture contexts produce 1280x800 PNGs at DPR 1. Both use en-US, UTC, light color scheme, reduced motion, blocked service workers, and a fixed clock. Every persisted source image uses the same masked screenshot path. All 29,440 pixels in each synthetic private rectangle are verified as solid RGBA `[15, 23, 42, 255]`.
- A third fresh context renders the trusted fixed HTML template at 1920x686 and DPR 1. The renderer receives masked PNG data URLs and text assigned through `textContent`. The local Inter font loads from a data URL. A restrictive CSP blocks scripts, connections and remote assets. The renderer records zero network route attempts, and an explicit forbidden fetch is rejected.
- Capture cookies and the fixed clock do not reach the renderer. The second capture context also receives no first-context cookie. The `<b>` label and `<img onerror>` caption remain text. The JSON preserves `après`; presentation maps the unsupported glyph to `?` and records `FONT_GLYPH_UNSUPPORTED`.
- The composed layout has a 48 px label row, two 958x598 panels with `object-fit: contain`, a 4 px divider, and a 40 px caption row. The source screenshots keep their aspect ratio. The title and caption visibly identify synthetic keyframes and unverified coverage/provenance.
- The capture schema validates the persisted bundle. Pixelmatch computes source `changeRatio` before composition with threshold 0.1 and `includeAA: false`. The timeline schema validates a 30-frame title followed by a 24-frame step, with cumulative half-open boundaries and hash entries for both images.
- Browser contexts and the first browser are closed before encoding. A second browser exercises `BrowserServer.kill()`. In both cases the browser root PID equals its PGID, every owned group member disappears, and a separate sentinel process and the supervisor remain alive. The sentinel is then terminated by its own recorded PID group in final cleanup. The probe never issues a name-based process kill.
- FFmpeg receives complete persisted PNG buffers over `image2pipe`, repeated exactly 30 and 24 times. Input uses 30 fps. The probe observes 33 backpressure drains in the recorded run and concurrently drains stderr. The encode uses libx264, yuv420p, CFR 30, CRF 23, veryfast, faststart, no audio, and an explicit 54-frame output limit. It does not use drawtext, libass, hstack, or a concat demuxer.
- ffprobe decodes exactly 54 frames, with `h264`, `yuv420p`, 1920x686, `30/1` nominal and average frame rates, one video stream, and 1.800 seconds duration. Validation occurs before the temporary MP4 is renamed.
- Frames 0, 27, 29, 30 and 53 are extracted from the MP4. Their mean absolute RGB error against the scheduled PNG is 0.648 to 0.786 on a 0-255 scale, below the probe's limit of 3. Against the other segment, error exceeds 173. This checks the first frame, midpoint, both sides of the title boundary, and final frame despite lossy H.264 encoding.

## Saved fixtures and evidence

The original run used `artifacts/n0`. That development run directory is not required in the public source checkout. The retained synthetic image inputs are [composer-before.png](../test/fixtures/composer-before.png) and [composer-after.png](../test/fixtures/composer-after.png). Their hashes match the source image rows below. The current [capture schema fixture](../test/fixtures/capture.json) has evolved with the public schema and is not a byte-identical copy of the original capture record.

The historical machine-readable record is [n0-media.json](n0-media.json). It records launch and cleanup observations, rendering isolation checks, command arguments, ffprobe assertions, frame comparisons, and artifact hashes. Paths into the original run identify historical outputs. They are not promises that those outputs are distributed or that current code reproduces their hashes.

| Artifact | SHA-256 |
| --- | --- |
| `capture.json` | `5cdf2f957490e72adfef8b38136c37d6588f79a76ada6e0777ad1a7d88a70572` |
| `timeline.json` | `3f0af14340d7a76f63ec4fa1ee72e23bc404c532d155436b7b81818806cf5c10` |
| `source/before.png` | `9b09ddc88203a49884966f4eca4034885eadfcac51cfb89863eb7cf5d9c837a6` |
| `source/after.png` | `ef90999382829ddce82ca8926afa0630c4d367ec60077d1084e72921a734a7ca` |
| `composed/title.png` | `2f4fabe76cfacecdf6a6ca1bb26beef0293f591b3dc4340072dd8723f2219454` |
| `composed/step.png` | `171e2d9c5b96ff9ef470ec6950cd78683fcc1145e19dae5dcd6a4fae0df2f877` |
| `comparison.mp4` | `c0e2cf7cf5da1d5f564817016627bc5fbb34e128fb8a957ae11e3a89de9d9e39` |

## Font provenance

The bundled font is the unmodified authentic [Inter Regular WOFF2](https://github.com/rsms/inter/blob/e3a3d4c57d5ecc01453a575621882a384c1995a3/docs/font-files/Inter-Regular.woff2). It is pinned to official [rsms/inter v4.1](https://github.com/rsms/inter/tree/v4.1), commit `e3a3d4c57d5ecc01453a575621882a384c1995a3`. The [upstream license](https://github.com/rsms/inter/blob/e3a3d4c57d5ecc01453a575621882a384c1995a3/LICENSE.txt) is copied verbatim to `assets/fonts/OFL.txt`. No conversion, font substitution, subsetting, or renaming of the font family occurred. The distribution filename is `Inter-Regular.woff2`.

| Bundled file | Bytes | SHA-256 |
| --- | ---: | --- |
| `assets/fonts/Inter-Regular.woff2` | 111268 | `e06f6b1bc553aaea4e4668023ed0ab0a147129c3107f511bc7d03d361b0ae085` |
| `assets/fonts/OFL.txt` | 4380 | `262481e844521b326f5ecd053e59b98c8b2da78c8ee1bdbb6e8174305e54935a` |

[`../assets/fonts/provenance.json`](../assets/fonts/provenance.json) records the exact immutable raw download URLs. The original probe rejected asset hash changes before launching Chromium.

## Limits

The source pages are fixed synthetic HTML supplied with `setContent`. This probe exercises no app servers, Git snapshots, scenario executor, provenance validation, public composer API, full timeout/cancellation matrix, malformed-input matrix, or Linux host. Context isolation and process cleanup observations apply to the recorded probe. The sentinel proves that those two cleanup operations did not kill a separate process group; it is not a general proof for every host or cancellation race.

Screenshot and video hashes can vary across browser/host versions. The hash table identifies this recorded run. Product rendering, encoding-only recompose, fixture coverage, package smoke checks, and host platform gates remain separate work.
