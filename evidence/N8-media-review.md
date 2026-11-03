# Decoded success and partial media review

The integrator inspected decoded video frames for the C1 installed-package examples. This review covers the actual H.264 output, at each segment start and the last frame. It is a keyframe review, not a claim that continuous playback was watched.

The tested implementation commit is `2ae52e9f30d0d0024519c76017dadf1dfbfba552`. Its npm archive SHA-256 is `d8ab0f4c51dee78a8208b97667690cbcfb38a6955f67a36155608979ad588f86`. This candidate remains superseded pending the final diagnostic corrections and Linux gate.

| Example | Video SHA-256 | Inspected decoded frames |
|---|---|---|
| Success | `2c5da5ce2453ebecb2764b8d0066e3d1687b6834500ce4e23afab3096942e977` | 0, 30, 54, 78, 102, 126, 150, 173 |
| Partial | `8ab31b0953fcd453cf67cdb89db006a7c0cf6e8a100fe1fab5db13af74b494c9` | 0, 30, 54, 78, 102, 126, 150, 173 |

Both files decode to 174 frames at 30 fps, with a 5.8 second duration and 1920 by 686 dimensions. ffprobe reports H.264, yuv420p, and one video stream with no audio. The corresponding reports and extracted images are under `evidence/artifacts/release-0.1.0/visual/`.

The inspected frames show the BEFORE and AFTER labels, source identities, KEYFRAMES label, and coverage caveat. Black privacy masks remain opaque. The success example shows the blue-to-orange style change, the AFTER-only yearly toggle, the price changing from $20 to $16, and the hover tooltip. Expected absence and exclusion steps display their unverified-pair badges.

The partial example preserves the last valid BEFORE state after its required toggle fails. Later BEFORE frames show blocked-step badges. AFTER continues through the yearly price and hover states. The title and footer disclose incomplete capture. Long badge and source text uses visible ellipsis within the fixed header. It does not cover the captured page.

No visual defect was found in these inspected frames. The final candidate must regenerate these examples. A byte-identical video can reuse this visual observation with an explicit hash match. Changed output requires another decoded-frame review.

## Final C2 media

The installed C2 package regenerated both examples at implementation commit `927af366c3db101dc5875768432df20dba9e7675`, archive SHA-256 `6b01bd51d5e713b205d734c29ab948458d32635c7e8dbe5b163364f7bc5d6194`. Their changed hashes required a fresh review. The integrator directly viewed all eight decoded frames listed above for each new video. The final files show the same correct labels, opaque masks, price and hover states, expected-absence and exclusion badges, and failed or blocked BEFORE states described above. No visual defect was found in the inspected final keyframes.

| Final example | Run ID | Video SHA-256 |
|---|---|---|
| Success | `20261101T220738255Z-870ae37f9adfb00e` | `706563d3d54cfc561e35792eb7b79dbd61a59daac6b93e42a339cb4614c6ea4c` |
| Partial | `20261101T220833817Z-948e08c2aacbbcc6` | `83d97ed39bee98c57bd5bd594a8a6d9547f74ebfe2aeb3cb3014670efe46f291` |

Both final files decode to 174 frames at 30 fps, 5.8 seconds, and 1920 by 686 pixels. ffprobe confirms H.264, yuv420p, and no audio. Extraction records and decoded frames are in `evidence/artifacts/release-0.1.0-c2/visual/`. The public examples in `docs/demo/` are byte-for-byte copies of the final macOS installed-package output. The package checks independently validate their manifest hashes and timelines and reproduce encoding without Chromium or application servers.
