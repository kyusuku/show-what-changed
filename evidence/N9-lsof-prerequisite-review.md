# N9 lsof prerequisite review

The goal is a complete v0.1 candidate ready for owner review, with no public actions. This review checks the Linux lsof prerequisite and its explicit installation path.

The scoped verdict is **pass**. No unresolved blocking defect was found in the source, installer, or setup documentation identified by the hashes below. This is not proof that the replacement Linux installed CLI or release gate passes.

Throughput checkpoint: n/a, read-only investigation.

## Scope and method

Reviewed the shared lsof capability helper, both callers, focused tests, README, quickstart, CI workflow, shared installer, Dockerfile, runner documentation, and runner image-context hashing. Product and script files were read only. This evidence file is the only authored file.

Used the poteto-mode investigation workflow and native Codex review. The review traced the helper through the callers, process probes, supervisor output capture, and comparison lifecycle. No nested agent or new build was required. The new helper, tests, and installer contain no explanatory comments or suppression directives requiring a comment-review action.

## Behavior and findings

`src/runtime/lsof.ts` returns a supported flag and the parsed upstream revision. Linux requires a recognized numeric revision of at least 4.99.7. Two-component revisions normalize to three components for comparison. The parser rejects unknown output, suffixes, extra numeric components, and an inline example that is not a revision field. macOS keeps its existing system-lsof policy.

Both `doctor` and `compare` join stdout and stderr before parsing. This handles lsof's actual version output on stderr. Both still require a successful executable exit. The supervisor waits for captured probe streams before returning its exit result.

`compareCapabilities` runs before `prepare` and application startup. An unsupported Linux version raises `LSOF_VERSION_UNSUPPORTED` with capability exit 8. The existing listener ownership checks are unchanged. The version requirement does not substitute for ownership or loopback validation.

One low-priority setup defect was reported during review. The `doctor` exception path for missing or unrunnable lsof initially recommended only the operating-system package manager. That instruction could install the unsupported Ubuntu 24.04 version. The integrator changed the exception path to use `LSOF_SETUP` for lsof. The final source at `src/runner/doctor.ts:44` was reread and is included in the hashes below.

README, quickstart, CI, and runner documentation now agree on Linux 4.99.7 or later and the shared installer. They preserve macOS system lsof. README explicitly excludes older distributor backports from the version policy. The unnecessary `groff-base` prerequisite is absent from the final README and CI workflow.

## Installation and provenance

The installer requires an explicit absolute prefix and Linux. It checks its build tools and library metadata before downloading, verifies SHA-256 before extraction, builds the executable, and installs the executable, complete license, and source record. It does not invoke a package manager or alter PATH. The CLI does not run it implicitly.

The upstream [4.99.7 release API](https://api.github.com/repos/lsof-org/lsof/releases/tags/4.99.7) independently reports the archive digest `4a10391aab0b8ce1f539e82a1966693b2a6cf225972a6504ebb7ec4fa71675de`. The installer, runner documentation, and preserved archive all match that digest. The local archive at `evidence/artifacts/linux-final-01/lsof-4.99.7/lsof-4.99.7.tar.gz` was hashed directly during this review.

The official [issue 359](https://github.com/lsof-org/lsof/issues/359) describes the Linux process-name parser defect. Direct inspection of the pinned archive confirms that `lib/dialects/linux/dproc.c` finds the last closing parenthesis with `cp2 = strrchr(cp, ')');`. This supports the selected source version independently of the release-note summary.

The preserved `COPYING` bytes match the archive and the [upstream 4.99.7 license](https://github.com/lsof-org/lsof/blob/4.99.7/COPYING). The file includes the author, Purdue attribution, and full restrictions. Its SHA-256 is `225222ff9bf38abc2cef7205e9b05c60935efa9ec28d1fd01e503c9316088718`. The installer retains the full notice at `share/licenses/lsof/COPYING` and records the unmodified upstream origin. The development image copies those records with the binary. The npm package allowlist excludes the installer and container files, and the npm package does not bundle this lsof executable.

The Dockerfile uses the same installer in a separate build stage and copies its installation tree into the final image. The runtime libraries remain explicit. The runner includes `install-lsof.sh` in both recorded input hashes and the image-context hash, so changing the installer invalidates the cached runner image context.

## Verification performed

| Check | Observed result |
| --- | --- |
| `PATH=/private/tmp/swc-toolchain/node_modules/.bin:$PATH node --version` | Node `v24.22.2`. |
| `PATH=/private/tmp/swc-toolchain/node_modules/.bin:$PATH node node_modules/vitest/vitest.mjs run test/unit/lsof.test.ts --maxWorkers=1` | One test file and all 13 tests passed. |
| `sh -n scripts/linux-gate/install-lsof.sh` | Exit 0. |
| `sh scripts/linux-gate/install-lsof.sh --help` | Exit 0 and the explicit prefix, prerequisites, and installation scope were displayed. |
| Installer invocation without a prefix, with a relative prefix, and with an absolute prefix on this macOS host | Each exited 2 with the corresponding usage or platform explanation. No target installation directory was created. |
| Helper against actual `/usr/sbin/lsof -v` output | macOS system revision 4.91 was recognized and accepted. |
| Helper against the saved Linux ownership probe's actual lsof output | Revision 4.99.7 was recognized and accepted under explicit Linux policy. |
| Archive hash, parser source, and license-byte checks | Passed after correcting one reviewer assertion that initially guessed the upstream variable name as `buf` instead of the observed `cp`. That first assertion failure was in the review check, not the product. |
| Scoped `git diff --check` | Exit 0. |

The retained [ownership probe](artifacts/linux-final-01/lsof-4.99.7/ownership-probe.json) was read directly. It records owned-loopback acceptance, rejection and preservation of an unrelated listener, wildcard rejection, and successful owned cleanup under UID 1001. Its provenance identifies the old C1 source commit. Those observations establish the lsof prerequisite diagnosis, not execution of the new prerequisite branches.

## Verification limits

This reviewer did not compile lsof, rebuild the runner image, change `dist`, or run a replacement Linux CLI. Before accepting the new candidate, its actual installed Linux artifact must demonstrate unsupported-version failure and successful execution with the supported installation. The required immutable Linux release gate remains separate. No hosted CI or public release is claimed.

The Prove It Works principle required direct inspection of the pinned archive, license bytes, actual version output, and focused test execution. It also kept the earlier ownership probe and this source review separate from proof of the replacement Linux CLI.

## Reviewed SHA-256 hashes

| File | SHA-256 |
| --- | --- |
| `src/runtime/lsof.ts` | `b7235dd55d754e18e57ae4be5dbfd4c5caed5e91ac25790a3e3f5a77997b2eb4` |
| `src/runner/doctor.ts` | `0faba3abec66820dc847733116e29be590db63bc4cda17de79ab1468bd172f89` |
| `src/runner/index.ts` | `f908073ed27554e615b42a622dda919c264e0596700b502f19699a161811f63b` |
| `test/unit/lsof.test.ts` | `f1fc3f535698fb037494d19405a200e1b3f586a11af09cbd0eb231acb2fb14fe` |
| `README.md` | `efb0697dd5f1729b646ee82b576455a66a183cd1fce7b78f5c6ed972b9e00fa9` |
| `docs/quickstart.md` | `11acb7ce88ea95089e960b2098d82794365b5e59208e60669031d91bf4678fec` |
| `docs/ci.md` | `3821e4688773f4b09be675b1cc8a7b49fc15d93d4dfd474766bda977db79ec10` |
| `.github/workflows/ci.yml` | `d4680a76590a21a7855d00239edb2d96a28911e0707970c33ca7c44b00af8223` |
| `scripts/linux-gate/install-lsof.sh` | `86d1044304ed6912d125cef12b64a3c3707e30655ee73fc375a5469c97e49c87` |
| `scripts/linux-gate/Dockerfile` | `e0abb6e34d408a7d51b146eac373cd9d7ce71b90b28e1100460b3b866ad66a46` |
| `scripts/linux-gate/README.md` | `2f32e3b6bb989436d3c272a5c0e6326646c4d35a635bbc993c2bf7aa349d193d` |
| `scripts/linux-gate.mjs` | `7dc7b63558a2d05cd6b8e52617908a7cf5446d8d4e2b705eaccffb13d2eda1a9` |
