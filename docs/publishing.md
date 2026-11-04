# Publish the reviewed 0.1.0 candidate

> Release status: use this procedure only with the separately delivered accepted release identity and [release readiness](release-readiness.md) for the exact candidate. All required gates must be accepted. This document does not authorize publication.

> Public-history hold: the development history contains private context. Do not push it or change its repository visibility. Use only the separately prepared public checkout named by the final handoff, after its complete intended history, source archive, and package have passed review. Private development originals remain outside that checkout.

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
set -eu
SWC_PUBLIC_ROOT='/absolute/path/from-reviewed-public-handoff'
SWC_RELEASE_COMMIT='read-public-implementation-commit-from-release-identity.json'
SWC_HANDOFF_COMMIT='read-from-separately-delivered-release-identity.json'
SWC_SOURCE_ARCHIVE='/absolute/path/to/final-public-source.tar'
SWC_EXPECTED_SOURCE_SHA256='read-from-separately-delivered-release-identity.json'
SWC_TARBALL='/absolute/path/show-what-changed-0.1.0.tgz'
SWC_EXPECTED_SHA256='replace-with-reviewed-package-sha256'
cd "$SWC_PUBLIC_ROOT"
test "$(node --version)" = 'v24.22.2'
test "$(npm --version)" = '11.12.1'
test "$(git rev-parse HEAD)" = "$SWC_HANDOFF_COMMIT"
test -z "$(git status --porcelain)"
git merge-base --is-ancestor "$SWC_RELEASE_COMMIT" "$SWC_HANDOFF_COMMIT"
git diff --exit-code "$SWC_RELEASE_COMMIT" "$SWC_HANDOFF_COMMIT" -- src package.json package-lock.json tsconfig.json tsconfig.build.json schema skills assets README.md LICENSE THIRD_PARTY_NOTICES.md scripts
node --input-type=module - "$SWC_TARBALL" "$SWC_EXPECTED_SHA256" "$SWC_SOURCE_ARCHIVE" "$SWC_EXPECTED_SOURCE_SHA256" <<'NODE'
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
const [packagePath, packageHash, sourcePath, sourceHash] = process.argv.slice(2);
for (const [path, expected] of [[packagePath, packageHash], [sourcePath, sourceHash]]) {
	assert.match(expected, /^[a-f0-9]{64}$/);
	assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'), expected);
}
NODE
tar -tzf "$SWC_TARBALL"
tar -xOf "$SWC_TARBALL" package/package.json
npm publish "$SWC_TARBALL" --dry-run --ignore-scripts --access public --registry=https://registry.npmjs.org/
```

Check that the package manifest names `show-what-changed` version `0.1.0`. `SWC_RELEASE_COMMIT` identifies the public implementation commit. `SWC_HANDOFF_COMMIT` identifies the final documentation and evidence commit. Read both commits and the final source archive digest from the separately delivered release identity manifest. Keep that manifest outside the archive it hashes. A documentation-only handoff must preserve package inputs and the approved tarball bytes. A dry run does not verify publishing authority.

Privacy sanitation can recreate commit IDs while preserving implementation and package inputs. In that case, review the recorded byte equivalence between the executed candidate and the public implementation commit. Use the public commit for the Git checks above. The original executed commit remains an evidence identity and may be absent from the public history. Do not import development objects to make that original commit available.

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

Use a new empty owner-controlled destination, or independently review every existing destination ref and its hosted content before any visibility change. A clean local checkout does not remove remote branches, tags, pull-request content, releases, or Actions history and logs. GitHub exposes Actions history and logs when a repository becomes public. If the named destination contains private development material, stop and prepare a separately approved clean destination. A different repository URL changes package metadata and requires a new candidate. See [GitHub repository visibility](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/managing-repository-settings/setting-repository-visibility).

```sh
SWC_PUBLIC_ROOT='/absolute/path/from-reviewed-public-handoff'
cd "$SWC_PUBLIC_ROOT"
git remote -v
git log --oneline -3
git status --short
git branch --show-current
git remote add origin https://github.com/kyusuku/show-what-changed.git
git remote get-url origin
git push --no-follow-tags origin "$SWC_HANDOFF_COMMIT:refs/heads/main"
```

The prepared checkout has no remote. Add `origin` only after confirming the owner-controlled destination above. If `origin` already exists, inspect its URL instead of replacing it silently. Confirm that the reviewed handoff is on `main` before the push. A non-fast-forward rejection requires review of the remote history; do not force-push as part of this procedure.

After that review and explicit authorization, the owner can change repository visibility and create the `v0.1.0` release tag at `SWC_HANDOFF_COMMIT`. These public owner actions have not been performed. Recheck the documentation and synthetic demos in the public repository before announcing it. The license, README, contribution guide, security policy, and reproducible verification instructions are already in the candidate source.

## Confirm registry access

The owner must authorize the public release before the publish command. For this interactive local route, verify that the npm account has two-factor authentication enabled, then log in and complete the publish challenge. Direct npm publication requires account 2FA or a granular token with bypass 2FA. This guide uses the interactive account route. Do not paste credentials into repository files, logs, chat, or command arguments. See [npm public package publishing](https://docs.npmjs.com/creating-and-publishing-unscoped-public-packages/).

```sh
npm login --registry=https://registry.npmjs.org/
npm whoami --registry=https://registry.npmjs.org/
npm view show-what-changed name version maintainers --json --registry=https://registry.npmjs.org/
npm view show-what-changed@0.1.0 version --json --registry=https://registry.npmjs.org/
```

An `E404` means no readable registry record at that time. It does not reserve the name or prove publication rights. If the name now exists, run `npm owner ls show-what-changed --registry=https://registry.npmjs.org/` and confirm that the authenticated identity has publishing rights. Treat network or authentication errors as unresolved checks. If `0.1.0` already exists, stop. npm does not permit reuse of a published name and version. See [npm owners](https://docs.npmjs.com/cli/v11/commands/npm-owner/) and [npm publish](https://docs.npmjs.com/cli/v11/commands/npm-publish/).

## Publish the archive from the owner's machine

The prepared handoff uses this local archive route. It publishes the exact reviewed archive without npm provenance. A local shell cannot produce npm's supported CI provenance. The optional hosted route below requires separate setup and approval.

After approval and identity checks, the owner can publish with this command.

```sh
npm publish "$SWC_TARBALL" --ignore-scripts --access public --tag latest --registry=https://registry.npmjs.org/
```

The command makes `show-what-changed@0.1.0` public. It does not change GitHub visibility or create a GitHub release. Those are separate owner actions. Do not describe this route as a provenance-backed publication.

## Set up a provenance-backed publication

npm provenance requires a public source repository that matches `package.json`, a public package, and a supported hosted CI publisher. For GitHub, use a GitHub-hosted runner with `contents: read` and `id-token: write`. A private repository or local Docker gate cannot supply that provenance. See [npm's provenance requirements](https://docs.npmjs.com/generating-provenance-statements/).

This route needs separate owner approval to make `kyusuku/show-what-changed` public. Confirm available hosted-runner usage before starting a job. The build's private-repository verification did not establish an included usage balance.

This handoff does not include a publishing workflow. Add a manually dispatched `.github/workflows/publish.yml` in a later commit and review that exact workflow before use. Bind the later commit and its new source archive to the approved tarball, record any affected checks, and update the owner handoff before dispatch. Preserve the original tested implementation identity. The workflow must perform these steps before publishing.

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
| Allowed actions | Explicitly allow `npm publish` for this direct publication route |

New trusted-publisher configurations default to staging permission. They must complete their first successful publication within two days or be recreated. Dist-tag permission is separate. Do not substitute staged publication without separate approval. Staging an unpublished package can create a public placeholder. See [npm trusted publishers](https://docs.npmjs.com/trusted-publishers/) and [npm staged publication](https://docs.npmjs.com/creating-and-publishing-unscoped-public-packages/#staged-publishing).

Trusted publishing requires a matching existing workflow and npm package configuration. Do not assume an unpublished package already has that configuration. npm automatically adds provenance for trusted publication from a public repository. Node `24.22.2` and npm `11.12.1` meet the documented minimums. See [npm trusted publishers](https://docs.npmjs.com/trusted-publishers/) for setup and current provider restrictions.

No workflow, trusted-publisher connection, public repository, or publishing credential is claimed to be configured by this guide. Record the chosen route in the final readiness handoff. Recheck the linked service requirements before publication.

## Verify the published version

After a successful authorized publish, use a fresh directory and cache to retrieve the exact registry archive. Compare its bytes with the approved package digest and its SHA-512 with registry integrity before running it. Use the reviewed public handoff checkout for the verification scripts and install the prerequisites documented in the quickstart. The public-app check also requires pnpm `11.9.0` on `PATH`.

```sh
set -eu
SWC_VERIFY_DIR="$(mktemp -d)"
SWC_REGISTRY_TARBALL="$SWC_VERIFY_DIR/show-what-changed-0.1.0.tgz"
npm view show-what-changed@0.1.0 --json --cache "$SWC_VERIFY_DIR/npm-cache" --registry=https://registry.npmjs.org/ > "$SWC_VERIFY_DIR/registry.json"
npm pack show-what-changed@0.1.0 --ignore-scripts --json --pack-destination "$SWC_VERIFY_DIR" --cache "$SWC_VERIFY_DIR/npm-cache" --registry=https://registry.npmjs.org/ > "$SWC_VERIFY_DIR/registry-pack.json"
node --input-type=module - "$SWC_REGISTRY_TARBALL" "$SWC_EXPECTED_SHA256" "$SWC_VERIFY_DIR/registry.json" <<'NODE'
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
const [path, approvedHash, metadataPath] = process.argv.slice(2);
const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
const bytes = readFileSync(path);
assert.equal(metadata.name, 'show-what-changed');
assert.equal(metadata.version, '0.1.0');
assert.match(approvedHash, /^[a-f0-9]{64}$/);
assert.equal(createHash('sha256').update(bytes).digest('hex'), approvedHash);
const integrity = 'sha512-' + createHash('sha512').update(bytes).digest('base64');
assert(metadata.dist.integrity.split(/\s+/).includes(integrity));
NODE
mkdir "$SWC_VERIFY_DIR/registry-install"
npm install --prefix "$SWC_VERIFY_DIR/registry-install" --ignore-scripts --no-audit --no-fund --cache "$SWC_VERIFY_DIR/npm-cache" --registry=https://registry.npmjs.org/ show-what-changed@0.1.0
"$SWC_VERIFY_DIR/registry-install/node_modules/.bin/show-what-changed" --version
cd "$SWC_PUBLIC_ROOT"
test "$(git rev-parse HEAD)" = "$SWC_HANDOFF_COMMIT"
test "$(pnpm --version)" = '11.9.0'
node scripts/release-smoke.mjs "$SWC_REGISTRY_TARBALL" "$SWC_VERIFY_DIR/package-smoke"
node scripts/real-app-smoke.mjs "$SWC_REGISTRY_TARBALL" "$SWC_VERIFY_DIR/public-app"
```

Both smoke reports must say `passed` and record the approved package SHA-256. The first script exercises installed CLI behavior, success and partial output, offline composition, and cleanup. The second exercises the public web-app navigation and validation scenarios three times each plus WORKTREE behavior. Inspect its resulting motion videos at normal speed and verify the intended visible changes. These checks do not replace the prepublication platform gates.

Retain the registry metadata, downloaded tarball digest, source and handoff commits, command exits, report hashes, publishing identity, and chosen route. When the route includes provenance, run `npm --prefix "$SWC_VERIFY_DIR/registry-install" audit signatures --registry=https://registry.npmjs.org/`. Inspect the attestation for this package and confirm its source commit and workflow match the approved publication. A successful command or verified dependency signatures alone do not establish this package's provenance. [npm provenance verification](https://docs.npmjs.com/generating-provenance-statements/#verifying-provenance-attestations)

Only after publication can the README's pinned `npx` example resolve the public `0.1.0` package. Update candidate wording and repository visibility claims to match the observed release state.

## Respond to a faulty published release

Pause announcements and retain the exact published archive and incident evidence. A published name/version cannot be overwritten or reused, even after unpublishing. Build and verify a new version for a correction. The owner may deprecate the affected version with a specific explanation and a verified replacement when one exists. These are separate public actions requiring owner authorization. [npm unpublish policy](https://docs.npmjs.com/policies/unpublish/)

```sh
npm deprecate show-what-changed@0.1.0 'This version has a confirmed defect. See the repository release notice before use.' --registry=https://registry.npmjs.org/
```

Deprecation warns consumers but leaves the archive downloadable. For a later release with a previously verified version, the owner can restore the `latest` tag to that version after checking its availability and suitability. The first release has no earlier version to restore. Removing a tag or reverting source does not retract downloaded artifacts. [npm dist-tag](https://docs.npmjs.com/cli/v11/commands/npm-dist-tag/)

For accidental private material, treat publication as disclosure. Revoke any exposed credentials and follow the registry and Git hosting removal procedures. Unpublishing is subject to registry eligibility and cannot remove copies already downloaded. Review the current policy before deciding; never promise a complete rollback. [npm unpublish policy](https://docs.npmjs.com/policies/unpublish/)
