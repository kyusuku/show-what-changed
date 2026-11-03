# Publish the reviewed 0.1.0 candidate

> Release hold: the historical candidate does not satisfy [spec revision 0.3](../spec.md). Complete the new gates and replace the active candidate identity before using this publishing procedure. This document does not authorize publication.

> Public-history hold: the current development history contains private context. Do not push it or change its repository visibility. The revision 0.3 handoff must identify a separately prepared, fully scanned public history, source archive, and package. Private development originals are preserved outside the public release repository.

This is the owner handoff for `show-what-changed@0.1.0` and the GitHub repository [kyusuku/show-what-changed](https://github.com/kyusuku/show-what-changed). Preparing these instructions does not authorize publication, a public GitHub release, a visibility change, or an announcement.

The project owner is Tampraphon Lorattanasane. The GitHub owner is `kyusuku`. The npm publishing identity and package ownership are not yet verified. The [prerequisite inspection](../evidence/prerequisites.md) recorded registry `E404` for the name and `ENEEDAUTH` for `npm whoami` on 1 November 2026. Availability is not a reservation.

## Review the release evidence

Proceed only when [release readiness](release-readiness.md) says `ready_for_owner_publish` and identifies the exact commit, tarball, and SHA-256. Review the following evidence at that identity.

- Every required acceptance check and any remaining supported limitations.
- Node24 Linux full gate, macOS smoke, and three consecutive real-app comparisons.
- Installed-tarball help, doctor, planning, comparison, and re-encoding checks.
- Success and partial demo videos, posters, and matching manifests.
- Secret scans of staged files and complete Git history, tarball contents, dependency advisory triage, and licenses.

Missing implementation, platform evidence, or package verification prevents readiness. Final owner approval, npm login, and a publishing second factor can remain handoff actions.

Use Node `24.22.2` and npm `11.12.1`. Set these values from the readiness record, not from an older build.

```sh
SWC_RELEASE_COMMIT='replace-with-reviewed-full-commit-id'
SWC_TARBALL='/absolute/path/show-what-changed-0.1.0.tgz'
SWC_EXPECTED_SHA256='replace-with-reviewed-sha256'
git show --no-patch --format=fuller "$SWC_RELEASE_COMMIT"
git status --short
git diff --exit-code "$SWC_RELEASE_COMMIT" -- src package.json package-lock.json tsconfig.json tsconfig.build.json schema skills assets README.md LICENSE THIRD_PARTY_NOTICES.md scripts
shasum -a 256 "$SWC_TARBALL"
tar -tzf "$SWC_TARBALL"
tar -xOf "$SWC_TARBALL" package/package.json
npm publish "$SWC_TARBALL" --dry-run --ignore-scripts --access public --registry=https://registry.npmjs.org/
```

Use `sha256sum` on Linux if needed. Check that the implementation and package inputs match `SWC_RELEASE_COMMIT`, the archive hash equals `SWC_EXPECTED_SHA256`, and the manifest names `show-what-changed` version `0.1.0`. A later documentation-only handoff commit can follow the tested implementation commit. It must not change package inputs. A dry run does not verify publishing authority.

The package allowlist is `dist`, `schema`, `skills`, `assets`, `README.md`, `LICENSE`, and `THIRD_PARTY_NOTICES.md`, plus npm's package metadata. Reject fixtures, private plans, logs, local configuration, credentials, and audit temp files in the archive.

## Install the exact archive for review

Install the candidate in a fresh directory. This leaves the application checkout's dependencies alone.

```sh
SWC_INSTALL="$(mktemp -d)"
npm install --prefix "$SWC_INSTALL" --no-audit --no-fund "$SWC_TARBALL"
SWC="$SWC_INSTALL/node_modules/.bin/show-what-changed"
"$SWC" --version
"$SWC" --help
node "$SWC_INSTALL/node_modules/playwright/cli.js" install chromium
"$SWC" doctor --json
```

Follow the [quickstart](quickstart.md) against the disposable fixture and compare its results with the recorded package smoke. Follow the exact full verification commands in the readiness record. These setup commands alone do not establish release readiness.

If any package input changes, create a new candidate and repeat affected gates before publishing. A source checkout can rebuild a candidate with these commands.

```sh
npm ci
npm run typecheck
npm run build
npm run schema:check
npm test
npm pack --json
```

Record the new archive hash and rerun the installed-package and platform checks. Do not substitute that archive for the reviewed one silently.

## Publish the open-source repository

After approving the release, use only the sanitized public checkout identified by the final readiness record. Its complete history, refs, source archive, and package must have passed the public privacy review. Do not add the development repository as a remote or transfer its refs, tags, or objects into this checkout. Review the handoff and tested implementation identities there, and confirm the configured remote before pushing.

```sh
SWC_PUBLIC_ROOT='/absolute/path/from-reviewed-public-handoff'
cd "$SWC_PUBLIC_ROOT"
git remote -v
git log --oneline -3
git status --short
git push origin main
```

The owner can then change repository visibility to public in GitHub and create the `v0.1.0` release tag at the reviewed handoff commit. These are public owner actions and have not been performed. Recheck the documentation and synthetic demos in the public repository before announcing it. The license, README, contribution guide, security policy, and reproducible verification instructions are already in the candidate source.

## Confirm registry access

The owner must authorize the public release before the publish command. Authenticate using npm's interactive login and complete any required second factor. Do not paste credentials into repository files, logs, chat, or command arguments.

```sh
npm login --registry=https://registry.npmjs.org/
npm whoami --registry=https://registry.npmjs.org/
npm view show-what-changed name version maintainers --json --registry=https://registry.npmjs.org/
npm view show-what-changed@0.1.0 version --json --registry=https://registry.npmjs.org/
```

An `E404` means no readable registry record at that time. If the name now exists, confirm that the authenticated owner has publishing rights. If `0.1.0` already exists, stop. npm does not permit reuse of a published name and version. See [npm publish](https://docs.npmjs.com/cli/v11/commands/npm-publish/).

## Publish the archive from the owner's machine

This route publishes the exact reviewed archive without npm provenance. A local shell cannot produce npm's supported CI provenance. The current private GitHub repository also prevents provenance generation.

After approval and identity checks, the owner can publish with this command.

```sh
npm publish "$SWC_TARBALL" --ignore-scripts --access public --tag latest --registry=https://registry.npmjs.org/
```

The command makes `show-what-changed@0.1.0` public. It does not change GitHub visibility or create a GitHub release. Those are separate owner actions. Do not describe this route as a provenance-backed publication.

## Set up a provenance-backed publication

npm provenance requires a public source repository that matches `package.json`, a public package, and a supported hosted CI publisher. For GitHub, use a GitHub-hosted runner with `contents: read` and `id-token: write`. A private repository or local Docker gate cannot supply that provenance. See [npm's provenance requirements](https://docs.npmjs.com/generating-provenance-statements/).

This route needs separate owner approval to make `kyusuku/show-what-changed` public. Confirm available hosted-runner usage before starting a job. The build's private-repository verification did not establish an included usage balance.

Prepare a manually dispatched `.github/workflows/publish.yml` at the reviewed commit. It must perform these steps before publishing.

1. Check out the exact approved commit with read-only repository access.
2. Select Node `24.22.2` and npm `11.12.1`. Pin workflow actions to reviewed full commit IDs.
3. Install dependencies, build, run the required checks, and create the tarball without private files.
4. Compare the tarball SHA-256 with the approved candidate. Stop on a mismatch and submit the changed archive for review.
5. Publish only the verified archive after the owner's release approval. Keep publication credentials unavailable to fixture comparisons and pull-request jobs.

The npm repository field is `git+https://github.com/kyusuku/show-what-changed.git`. Preserve its exact owner and repository case. With a publishing credential supplied only to the final step, npm's documented command is:

```sh
npm publish "$SWC_TARBALL" --ignore-scripts --provenance --access public --tag latest --registry=https://registry.npmjs.org/
```

For token-free publishing after package settings are available, configure npm's GitHub trusted publisher with these exact identifiers.

| Setting | Value |
| --- | --- |
| Organization or user | `kyusuku` |
| Repository | `show-what-changed` |
| Workflow filename | `publish.yml` |
| Environment | Match the workflow's environment exactly if one is configured |

Trusted publishing requires a matching existing workflow and npm package configuration. Do not assume an unpublished package already has that configuration. npm automatically adds provenance for trusted publication from a public repository. Node `24.22.2` and npm `11.12.1` meet the documented minimums. See [npm trusted publishers](https://docs.npmjs.com/trusted-publishers/) for setup and current provider restrictions.

No workflow, trusted-publisher connection, public repository, or publishing credential is claimed to be configured by this guide. Record the chosen route in the final readiness handoff. Recheck the linked service requirements before publication.

## Verify the published version

After a successful authorized publish, inspect the exact version and install it in a fresh directory.

```sh
npm view show-what-changed@0.1.0 version dist.integrity dist.tarball repository --json --registry=https://registry.npmjs.org/
SWC_VERIFY_DIR="$(mktemp -d)"
npm install --prefix "$SWC_VERIFY_DIR" --no-audit --no-fund show-what-changed@0.1.0
"$SWC_VERIFY_DIR/node_modules/.bin/show-what-changed" --version
```

Record the registry integrity, release commit, original candidate SHA-256, publishing identity, and chosen provenance route. When published with provenance, inspect the package's attestation and use `npm audit signatures` in the fresh installation directory. Do not claim provenance from the presence of a successful publish alone.

Only after publication can the README's pinned `npx` example resolve the public `0.1.0` package. Update candidate wording and repository visibility claims to match the observed release state.

## Respond to a faulty published release

Pause announcements and retain the exact published archive and incident evidence. A published name/version cannot be overwritten or reused, even after unpublishing. Build and verify a new version for a correction. The owner may deprecate the affected version with a specific explanation and a verified replacement when one exists. These are separate public actions requiring owner authorization. [npm unpublish policy](https://docs.npmjs.com/policies/unpublish/)

```sh
npm deprecate show-what-changed@0.1.0 'This version has a confirmed defect. See the repository release notice before use.' --registry=https://registry.npmjs.org/
```

Deprecation warns consumers but leaves the archive downloadable. For a later release with a previously verified version, the owner can restore the `latest` tag to that version after checking its availability and suitability. The first release has no earlier version to restore. Removing a tag or reverting source does not retract downloaded artifacts. [npm dist-tag](https://docs.npmjs.com/cli/v11/commands/npm-dist-tag/)

For accidental private material, treat publication as disclosure. Revoke any exposed credentials and follow the registry and Git hosting removal procedures. Unpublishing is subject to registry eligibility and cannot remove copies already downloaded. Review the current policy before deciding; never promise a complete rollback. [npm unpublish policy](https://docs.npmjs.com/policies/unpublish/)
