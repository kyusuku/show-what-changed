# Third-party notices

The project's MIT license covers its authored code. Dependencies and assets retain their own licenses.

## Bundled font

Inter Regular is Copyright 2020 The Inter Project Authors, licensed under the SIL Open Font License, Version 1.1. The full license is included at `assets/fonts/OFL.txt`.

The unmodified WOFF2 comes from the official rsms/inter repository, tag v4.1, commit `e3a3d4c57d5ecc01453a575621882a384c1995a3`. Exact source URLs and file hashes are recorded in `assets/fonts/provenance.json`.

## Direct runtime dependencies

The licenses below were read from the pinned installed packages. Their distributions include their own license texts.

| Package | Version | License |
|---|---|---|
| commander | 15.0.0 | MIT |
| pixelmatch | 8.0.0 | ISC |
| playwright | 1.64.1 | Apache-2.0 |
| playwright-core (transitive) | 1.64.1 | Apache-2.0 |
| pngjs | 7.0.0 | MIT |
| semver | 7.8.5 | ISC |
| zod | 4.6.7 | MIT |

Playwright installs its matching Chromium separately. Chromium carries its own third-party notices. FFmpeg is a separately installed system prerequisite and is not bundled in this npm package. FFmpeg distribution terms depend on the user's build.

The release evidence records exact dependency origins, integrity fields, declared licenses, and hashes of installed license and notice files. Development dependencies retain their own MIT, Apache-2.0, BSD-3-Clause, MPL-2.0, or ISC licenses and are excluded from the installed production dependency tree.

## Development-only container profile

`scripts/linux-gate/seccomp.json` is copied without modification from the Microsoft Playwright v1.64.1 Docker seccomp profile. It is copyright Microsoft Corporation under Apache License 2.0. Its full license is in `scripts/linux-gate/PLAYWRIGHT-LICENSE`, and its source URL and digest are recorded in `scripts/linux-gate/README.md`. These development files are excluded from the npm package.
