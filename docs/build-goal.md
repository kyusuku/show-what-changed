> Historical document sanitized for public distribution. Its content is not a byte-for-byte copy of the original development record. It is not current release evidence.

# Build the complete v0.1 release candidate within 24 hours

Use `poteto-mode` to implement show-what-changed for developers who want to see an agent's UI edits. Deliver the complete v0.1 defined in the current `spec.md`, with a tested npm tarball, demo, documentation, and evidence that I can review before publishing. Execute the build. Do not stop after producing a plan.

Work in `<repository-root>`. Target completion within 24 hours of starting this goal. Record the start and deadline in UTC and Asia/Bangkok. The clock sets priority. Passing the release gates determines readiness.

## Use the current contract

Read these files before implementation:

- `spec.md` defines the required v0.1 behavior and release gates.
- `docs/implementation-graph.md` defines task ownership, dependencies, and checkpoints.
- `docs/implementation-graph.json` provides the task graph as data.
- `docs/audit/report.md` explains decisions and known traps.

Treat the current spec as authoritative over the historical archive. Complete every required behavior in every section, including all CLI commands, schemas, failure paths, source isolation, cleanup, documentation, and packaging. Build the declared keyframe replay. Keep deferred features deferred.

Record the starting spec hash. Maintain a requirement-to-code-to-test evidence matrix. Include every acceptance ID from T01 through T17 and requirements outside that table. A real defect discovered during implementation warrants a documented correction. Fix an ambiguity without reducing scope, record the reason, and update affected plans and tests. Do not remove requirements, loosen tests, or relabel broken behavior to meet the deadline. Preserve the original audit records as historical evidence.

## Start with the build prerequisites

Inspect the workspace and preserve existing files. Initialize Git if it is still absent. Add the project README, Node ignore rules including `.show-what-changed/`, and the planned MIT license. Pin the runtime, dependency versions, and matching Playwright browser revision.

In the first hour, check Node24, npm, Git, Chromium, FFmpeg, ffprobe, lsof, ps, disk space, and available agent capacity. Confirm a real way to run the Linux full gate and macOS smoke gate. Check the proposed package name and release access early, without publishing or reserving the name.

Use the existing private `kyusuku/show-what-changed` repository only after verifying its owner, visibility, and current contents. If it is unavailable, continue local work and look for an available local Linux environment. Report missing access promptly while completing independent tasks. A missing platform run remains an unmet release gate.

Choose a compatible public, stateless real app for T17 early. Use disposable local data. Do not make representative web app, production credentials, private registries, paid providers, or unsupported frameworks prerequisites for this release.

## Execute the dependency graph

Act as integrator. Follow N0 through N9. Convert each node into a concrete implementation plan when its dependencies are understood. Plan the next ready tasks while implementing the current tasks. Do not spend the night writing every plan before creating a working artifact.

Use up to four concurrent owners when available, including the integrator. Follow the accepted pstack model mapping and xhigh reasoning budget. Give each worker its assigned contract, file ownership, inputs, acceptance cases, and evidence requirements. Use separate worktrees or disjoint file ownership. The integrator owns shared schemas, dependencies, the lockfile, integration, and final decisions.

Freeze the shared schemas and a synthetic capture bundle at N0 before the main parallel build. Keep recorder, workspace/runtime, composer, and planner/CLI work independent through those contracts. Review and integrate worker output yourself. Treat a worker's completion message as a request for verification.

Use this loop for each task:

1. Identify the observable behavior and its fixture.
2. Write a focused failing behavior test when a meaningful test applies.
3. Implement the smallest complete solution within the spec.
4. Run the focused checks and drive the real CLI or browser path when applicable.
5. Obtain independent review of consequential code and fix demonstrated defects.
6. Integrate the change and rerun affected checks.
7. Record the commit, commands, exit codes, and artifact evidence before completing the node.

After two unsuccessful repair rounds, stop repeating the same tactic. Reproduce the cause, reassess the premise, and revise the implementation or assign a fresh reviewer. Keep the requirement and its pass condition intact. Rerun broader checks when the fix affects them.

Use the available Codex tools for orchestration. If a Cursor-specific command or helper is unavailable, report the substitution once and use a native equivalent. Do not spend the build installing unrelated workflow plugins or assume an unavailable `/loop` command will resume execution.

## Meet the checkpoints

Use the graph's hour windows as latest checkpoints. Finish sooner when possible.

- By hour 2, freeze contracts and prove masked PNG capture, comparison rendering, and exact-frame encoding.
- By hour 12, the built CLI must produce the complete success example and a truthful partial example end to end.
- By hour 18, install the packed tarball in a clean directory and pass its smoke test without source-tree or development dependencies.
- By hour 20, have the Linux and macOS evidence, real-app evidence, and synthetic-data demo.
- Reserve hours 20 through 24 for required fixes, final verification, and release preparation.

If a checkpoint slips, assign workers to the blocking path and remove optional polish. Do not remove a required check, expand into a deferred feature, or silently redefine success.

Maintain `evidence/progress.md` with completed nodes, active owners, failures, and the next runnable task. Maintain a concise decision trail and per-node evidence. Preserve enough state for another agent to resume after context compaction or interruption. Report meaningful milestones and external blockers without waiting for routine approval. Do not stop voluntarily at a plan, partial implementation, or unverified worker report.

## Prove the release candidate works

Implement and pass all T01 through T17. Include the complete required behavior in the evidence matrix. Do not count skipped tests, mocked subprocess-only checks, or historical audit probes as current end-to-end evidence.

At the final integrated commit, verify these outcomes:

- The installed CLI compares both exact commits and uncommitted source snapshots. The source checkout and unrelated processes remain intact.
- The video, poster, manifest, and local PR text describe the same run. Both success and incomplete comparisons have the specified visible and machine-readable outcomes.
- Source isolation, masking, strict parsing, consent, stale plans, cancellation, process ownership, and cleanup pass their adversarial cases.
- Media has the specified labels, dimensions, codec, frame count, and timing. Inspect the success and partial videos visually. Re-encoding works from saved composed frames without the browser or app servers.
- Typecheck, build, configured lint/format checks, unit tests, integration tests, repeatability tests, and installed-package tests pass.
- Node24 Linux passes the full required gate. macOS passes its smoke gate. The selected real app passes three consecutive runs as specified.
- The packed artifact contains the correct executable, schemas, skill, font, and notices. It contains no secrets, private logs, or unintended files.
- The README quickstart works using the packed artifact. Documentation states the supported platforms, prerequisites, keyframe behavior, and limitations accurately.
- Secret scans, dependency advisory triage, and license checks are complete. Prepare the publish procedure and provenance setup for the actual owner and repository.

Keep final evidence tied to the exact commit and candidate tarball. If code or package inputs change, rebuild and repeat affected checks before claiming readiness. Provide a documented way to rerun the release checks. Record external platform results separately, with their exact commit and run identity.

Do not call the result ready for publishing while a required gate is missing or a material defect remains. Do not describe a fallback prototype as the completed spec. If the deadline arrives first, report the actual state and remaining work. Leave the goal incomplete and continue useful corrective work while the session remains active, unless I ask you to stop.

## Work under this authorization

I authorize implementation changes, ordinary dependency and pinned-browser installation, local development commands, and execution of disposable fixtures. This includes `--allow-exec` for the fixtures created or selected for this build. I authorize Git initialization, local commits, task branches, worktrees, and integration of reviewed worker changes within this project.

I also authorize pushing implementation branches and running CI in my verified existing private `kyusuku/show-what-changed` repository, using existing access and included usage allowances. Check those conditions before the first push. Do not incur new paid-service charges. If remote access is unavailable, preserve local progress and report what access is needed.

Make reversible technical choices and continue without asking me to approve each step. Ask only for unavailable credentials/access, paid spending, a product decision outside the agreed scope, or a destructive or public action not authorized here. Continue independent work while an external decision is pending.

Prepare the public release for my review. Do not publish to npm, change repository visibility, create a public release, deploy, post announcements, force-push a shared branch, or modify unrelated repositories. The finished tool must still enforce its own documented consent and upload rules for its users.

## Deliver the publishing handoff

Write `docs/release-readiness.md` with one explicit status, `ready_for_owner_publish` or `not_ready`. Link the final commit, candidate tarball and SHA-256, platform results, evidence matrix, successful and partial demo artifacts, and remaining limitations.

Provide the exact installation, verification, and owner publishing commands. Identify any remaining access or publication steps and whether they prevent readiness. A final owner approval, registry login or required publishing second factor can remain as an explicit handoff action. Missing implementation, tests, platform evidence, or package verification cannot.

End with a concise report of what works, what passed, the exact artifacts to review, and what I must do to publish. Mark the goal complete only when every required implementation and release-preparation gate passes and the candidate is ready for that owner handoff.
