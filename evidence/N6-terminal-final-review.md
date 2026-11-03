# Independent final terminal and ownership review

The release candidate needs truthful cancellation results and exclusive ownership of run data through terminal writes. This read-only review found no new defect in the tested terminal cancellation, output failure, or clean collision cases. It does not establish full release readiness or prove all possible interleavings. Throughput checkpoint: n/a, read-only investigation.

## Real CLI probes

All successful probes used Node 24.22.2, the current `dist` files, real FFmpeg, a copied saved run, and actual SIGTERM delivery. Loader hooks controlled the interleavings in the disposable runs. No product source was changed. The commands ran with process inspection access outside the managed sandbox. The first sandboxed attempt of the new probe exited 1 before reaching the injected pause; it did not exercise the target behavior.

- A new probe paused `compose` after `pr.md` was written but before `manifest.json` was written. A separate real `clean` returned `RUN_ACTIVE` and exit 2 while the run remained locked. After SIGTERM and resume, compose exited 143. Its JSON data exactly matched the persisted cancelled manifest, `pr.md` reported cancelled 143, and the lock was absent. Command `PATH=/private/tmp/swc-toolchain/node_modules/.bin:$PATH node /private/tmp/swc-n6-independent-final.mjs collision` exited 0. Raw report: `/private/tmp/swc-n6-independent-final-oO02Pk/probe.json`.
- The same probe injected persistent write failure after each `pr.md` write and delivered SIGTERM during the first write. Compose exited 143, returned `data: null` with `OUTPUT_WRITE_FAILED`, and retained the lock. The saved manifest remained in encoding state while `pr.md` reported cancelled. The warning accurately says saved files may show an earlier result. Command `PATH=/private/tmp/swc-toolchain/node_modules/.bin:$PATH node /private/tmp/swc-n6-independent-final.mjs persistent` exited 0. Raw report: `/private/tmp/swc-n6-independent-final-1UxJ0p/probe.json`. After the compose process exited, running `clean 20261101T204943474Z-67e2232c705d73b8 --json` in that disposable repository exited 0 and removed that exact run. This check removed the probe run, while the raw report remains outside it.
- The earlier independent transient rewrite probe was rerun against this build. It delivered SIGTERM after the first public write and failed the next write. Compose exited 143, and the returned manifest, saved manifest, and `pr.md` all reported cancelled 143. Command `PATH=/private/tmp/swc-toolchain/node_modules/.bin:$PATH node /private/tmp/swc-n6-final-write-probe.mjs` exited 0. Raw report: `/private/tmp/swc-n6-final-write-0nhNZ0/probe.json`.
- The earlier independent release-boundary probe was rerun against this build. It paused before lock release, delivered SIGTERM, and resumed. Compose and its persisted manifest both reported cancelled 143. Command `PATH=/private/tmp/swc-toolchain/node_modules/.bin:$PATH node /private/tmp/swc-n6-release-signal-probe.mjs` exited 0. Raw report: `/private/tmp/swc-n6-release-signal-zfmIkb/probe.json`.

The new probe requires the saved fixture identified in its source and the local toolchain. The injection proves the targeted interleavings, not general filesystem behavior or every signal timing. The persistent-failure probe's mismatched files are expected because writes failed. Its null result data, warning, and retained lock avoid claiming that they form a committed terminal result.

## Reviewed file hashes

| File | SHA-256 |
| --- | --- |
| `src/runner/index.ts` | `6a646917ce5ee7e27a1cdf1041f384660f88ad87225714eb1b47079416dae1fc` |
| `src/runtime/context.ts` | `a2ca6f78de87cff8a29b1b1172a3e7cb0b4b6cae05eb7d43de33237b1b4e243c` |
| `src/runtime/ownership.ts` | `95b9697b492e0ea21274c4b97ba1fdb1359bbcec2cd4566d54d1b5694b76c8b5` |
| `src/runner/artifacts.ts` | `57007feec39d12e2ec77adb017e2834b7649d88570430977f1d664a81ec84fbe` |
| `dist/runner/index.js` | `fd4608ccd3a31376cfa007e2bc437da06539e98323bc68ab8da443174574a25e` |
| `dist/runtime/context.js` | `6bfc6cdfffd938cfe2f3dc0d5ca709d5e27fe6ec223fd999802630fd89c2046a` |
| `dist/runtime/ownership.js` | `b979e6eaed2cfbd688a5ea993b418bab8b0ff1b37119f6becf1cf617af9dbcae` |
| `/private/tmp/swc-n6-independent-final.mjs` | `19631364fdd7a953df75656af8b9826b83eda5c6dfe94a89303cab9927879090` |
| `/private/tmp/swc-n6-final-write-loader.mjs` | `b0388700efcef6f99fe0173bb9e568aa765b2773ba378a81efe6afe46cb4afcd` |
| `/private/tmp/swc-n6-release-signal-loader.mjs` | `89cf765289d1783cbd5cbda92408a4c67929fadb531ecf1f43fb332a52197c39` |

Prove It Works led to direct process, JSON, saved-file, and recovery checks. Test Behavior, Not Implementation shaped the assertions around observable results and lock behavior. Poteto-mode, unslop, and technical-writing shaped this report.
