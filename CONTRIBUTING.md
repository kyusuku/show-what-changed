# Contribute to show-what-changed

Use [spec.md](spec.md) as the v0.1 behavior contract. The [implementation graph](docs/implementation-graph.md) assigns ownership. The [requirement matrix](evidence/requirements.md) records evidence. A passing unit suite alone is not release approval.

## Set up the pinned toolchain

Use Node `24.22.2` and npm `11.12.1`. Install Git, `lsof`, `ps`, FFmpeg with `libx264`, and ffprobe on your platform. Keep the Playwright package and browser revision paired.

```sh
node --version
npm --version
npm ci
node node_modules/playwright/cli.js install chromium
npm run build
node dist/cli/index.js doctor --json
```

On Linux, use the Playwright installer's `--with-deps` option when system libraries are missing. Candidate evidence must record the actual FFmpeg, browser, operating system, and runtime versions.

## Make a scoped change

Preserve unrelated work in a shared checkout. Coordinate file ownership or use an isolated branch and worktree before editing files that another contributor owns.

Change the source contract before regenerating schemas. JSON input is strict and versioned. Do not add a flag, scenario action, or config field for a deferred feature without changing the release contract.

For a behavior change, add a focused test that observes the failure or outcome. Use disposable fixture repositories and synthetic data. Do not require live accounts, paid providers, production databases, or credentials.

Source isolation, explicit execution consent, truthful partial results, masking, and owned-process cleanup are release requirements. Do not convert a required failure into expected absence to make a test pass.

## Run the relevant checks

Run these checks from the project root.

```sh
npm run typecheck
npm run build
npm run schema:check
npm run test:unit
npm run test:integration
```

There is no configured lint or format command in the current package scripts. Preserve the surrounding style. If a change adds such a command, include it in release verification.

Inspect tests that execute fixtures before running them. Application installation and startup execute code. Use the real CLI for changes to consent, JSON output, startup, capture, encoding, or cleanup.

Generate a disposable two-commit Next.js app for a local comparison with this command.

```sh
node scripts/create-fixture.mjs
```

The result prints the temporary repository path and exact commit IDs. Follow the [fixture instructions](fixtures/next-app-basic/README.md). The original fixture directory is not a Git repository to mutate. Use the pricing scenario for success and the required-before-failure scenario for a partial result.

Run `npm test` for the complete configured suite. Follow [release readiness](docs/release-readiness.md) for the current package and platform check commands. A clean tarball installation must pass without the source checkout or development dependencies.

## Record evidence for review

Describe the observable change and why it is needed. Include the reproduction, relevant test commands and exit codes, and paths to synthetic artifacts when output changes. State what was not tested.

For media changes, inspect success and incomplete videos. Verify both machine-readable outcomes and visible labels. For process changes, check that owned children exit and unrelated processes survive.

For a release candidate, tie results to the exact commit and tarball SHA-256. Rebuild and rerun affected checks after package inputs change. The Linux full gate, macOS smoke gate, and real-app comparisons have separate evidence.

Keep private logs, plans, recordings of private apps, credentials, and temporary fixture repositories out of commits and npm packages. Report security issues through [SECURITY.md](SECURITY.md).

## Prepare a release

Only the owner authorizes public publication, repository visibility changes, or announcements. Preparing a tarball does not grant that authorization. Follow [the publishing guide](docs/publishing.md) after every required release gate passes.

Retain the [MIT license](LICENSE), bundled font license, and [third-party notices](THIRD_PARTY_NOTICES.md). New dependencies and copied assets need exact versions, provenance, and license review.
