# N7 documentation and generic agent skill

Prepared on 1 November 2026 at 21:00 UTC, which is 2 November at 04:00 Asia/Bangkok. This evidence covers documentation and structural checks. It does not establish a passed release candidate, installed-package execution, platform gate, or publication.

## Scope

The documentation serves developers who want local visual evidence of an agent's UI change. The smallest supported workflow is a private plan, explicit application-execution consent, a keyframe comparison, and review of local artifacts.

Changed only these assigned files.

- `README.md` starts with a synthetic demo poster linked to an MP4, labels keyframes, pins prerequisites, and distinguishes the candidate tarball from future registry installation.
- `SECURITY.md` describes application execution, network access, masking, private output, ownership checks, and conditional vulnerability-reporting channels.
- `CONTRIBUTING.md` documents the current build commands, fixtures, evidence requirements, and owner publication boundary.
- `docs/quickstart.md` covers candidate installation, exact commits, WORKTREE, interaction scenarios, custom start arguments, masks, consent, result review, re-encoding, and cleanup.
- `docs/limitations.md` states unsupported layouts, bounded coverage, data parity, step semantics, privacy limits, and result codes.
- `docs/publishing.md` provides exact candidate inspection, installation, registry verification, local publication, hosted provenance setup, and post-publication commands.
- `skills/show-what-changed/SKILL.md` is a generic CLI agent workflow. It uses JSON, requires a dry plan, respects existing execution authorization, preserves failure evidence, and requires user approval before uploads through another tool.

No application code, schema, dependency, lockfile, platform script, or shared release record was edited. No commit, upload, repository visibility change, registry login, or publication was performed.

## Sources checked

Local claims were compared with `spec.md`, `docs/build-goal.md`, `src/cli/args.ts`, `src/schema/index.ts`, `src/runner/doctor.ts`, fixture instructions, package metadata, licenses, and prerequisite evidence. Playwright's installed `browsers.json` directly reported Chromium revision `1248` and browser `156.0.8078.4`.

The current [npm publish documentation](https://docs.npmjs.com/cli/v11/commands/npm-publish/), [npm provenance requirements](https://docs.npmjs.com/generating-provenance-statements/), and [trusted-publisher documentation](https://docs.npmjs.com/trusted-publishers/) were read for the publishing guide. Context7 also returned npm's own CLI implementation and publish documentation. The guide does not infer working publication credentials from those sources.

The current repository is private according to the prerequisite record. npm provenance requires public source and a supported hosted publisher. The guide labels local publication as lacking provenance and makes the public hosted route a separate owner-authorized setup. Registry E404 is recorded as an observation, not a name reservation. ENEEDAUTH leaves publishing identity unverified.

## Checks performed

The documentation check used Node `v24.22.2` from `/private/tmp/swc-toolchain/node_modules/.bin`. It exited `0` with these results.

| Check | Result |
| --- | --- |
| JSON examples | Both quickstart JSON blocks passed current runtime Zod schemas and generated JSON Schemas through Ajv. |
| CLI examples | Ten documented argument sets parsed through the built `parseCli`, including doctor, source selections, scenario selection, saved-plan compare, compose, clean, help, and version. |
| Local links | All local links resolved except the three explicitly pending root-owned demo files listed below. |
| Prose structure | All seven user-facing files had no trailing whitespace, long dashes, curly quotes, TODO, or TBD markers. |
| Existing README diff | `git diff --check -- README.md` exited `0`. New-file whitespace was checked directly by the Node check. |
| Skill frontmatter | Ruby's YAML parser validated the required name and description, the exact `show-what-changed` name, and the absence of unexpected frontmatter keys. |
| Package references | `npm pack --dry-run --ignore-scripts --json` included the skill, its linked schemas and README, the font, and required license notices. No tarball was installed by this check. |

The bundled skill validator command was attempted and exited `1` because Python lacked `yaml` from PyYAML. Its frontmatter and file-reference checks were performed with Ruby's YAML parser and the Node link checker instead. This is a tooling substitution, not a passed invocation of that validator.

The first npm dry run exited `255` because the sandbox could not write the default npm cache. It succeeded with a fresh owned temporary cache. No permissions or ownership were changed on the user's npm cache.

The package dry run used this command shape with the pinned toolchain on PATH.

```sh
SWC_DOC_CACHE="$(mktemp -d)"
npm pack --dry-run --ignore-scripts --json --cache "$SWC_DOC_CACHE"
```

The required included paths were `README.md`, `LICENSE`, `THIRD_PARTY_NOTICES.md`, `skills/show-what-changed/SKILL.md`, `schema/scenario.v1.json`, `schema/config.v1.json`, `assets/fonts/Inter-Regular.woff2`, and `assets/fonts/OFL.txt`.

The Prove It Works principle changed validation from a wording review to direct parsing of the documented examples, CLI argument sets, YAML frontmatter, and package file inventory. Technical Writing and Unslop shaped the separate tutorial, reference, security, contribution, publishing, and agent documents. Native Codex skill-authoring guidance replaced the unavailable Cursor-specific authoring helper.

## Integration work still required

The integrator owns the following final evidence and updates.

1. Generate the final packed-CLI success and partial demos. The pending README links are `docs/demo/success/poster.png`, `docs/demo/success/compare.mp4`, and `docs/demo/partial/compare.mp4`. Inspect the videos, then remove the sentence that says the demo links are pending. The integrator also reserved each demo's `manifest.json` and `pr.md`.
2. Execute the README candidate-install and quickstart commands against the final tarball. Confirm the installed Playwright CLI path, doctor, plan, comparison, and artifacts. Parser checks do not prove execution.
3. Verify the packaged skill and its links from a clean tarball installation without the source tree. The dry run proves inclusion only.
4. Complete `docs/release-readiness.md` with the final commit, tarball SHA-256, actual platform results, and complete acceptance evidence. The documentation deliberately links that record instead of claiming unfinished gates passed.
5. Record the owner's chosen publishing path. This change prepares instructions but does not configure a publication workflow, trusted-publisher connection, registry credential, or public repository.

The generic skill received structural and instruction review. No independent agent behavior evaluation or actual upload workflow was run. The skill's upload requirement does not authorize a test upload.
