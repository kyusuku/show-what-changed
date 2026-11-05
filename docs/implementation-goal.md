# Implement revision 0.3 for owner publishing

Use this document as the execution contract when activating the implementation goal. Authoring this file does not start implementation. Target completion within 24 hours of activation. Record the start and target times in UTC and Asia/Bangkok. Elapsed time never counts as passing evidence.

This document preserves the original 0.1.0 implementation goal. The input digests below track the current documents. Updated digests do not transfer historical acceptance to a new package. See [release readiness](release-readiness.md) for the separate 0.1.1 patch status.

## Deliver the usable release

Implement every mandatory requirement in spec.md revision 0.3. Deliver a verified experimental 0.1.0 candidate that compares web applications across stacks, records actual smooth browser motion, works across representative public web applications, and is ready for the owner to publish publicly.

Use the installed poteto-mode skill from the active skill catalog. Treat the specification as normative. Use docs/implementation-graph.md and docs/implementation-graph.json as the existing implementation plan. Follow docs/web-app-acceptance.md for reproducible public compatibility proof. Record acceptance in evidence/revision-0.3-status.json.

Read these contracts in full before changing product code. Preserve the mandatory scope and its documented deferrals. Correct evidenced implementation mistakes autonomously. Document necessary contract clarifications and update affected plans and checks. Do not lower acceptance thresholds or bypass a selected application setup to obtain a pass. The owner-requested privacy correction replaces private-app-specific public gates with redistributable general web-app acceptance.

## Preserve and identify the starting inputs

Work in the current show-what-changed repository root. The observed baseline HEAD is a85f90f3436a14060a8af222c2941d55e8c5bdc5. The revised specification and supporting documents are uncommitted inputs at goal authoring time. Inspect current status and preserve them before creating an isolated implementation branch or worktree. Do not start from the older committed specification by accident. Preserve unrelated user changes.

The owner-requested public privacy correction and the verified delivery-cutoff clarification reconciled the activated input contract. The latter defines delivered-frame accounting and discloses unobserved upstream frames without changing motion thresholds, masking, acknowledgement, or cleanup requirements. The evidenced timing clarification also separates observed events from bounded playback and preserves host/source clock domains without changing the 60-second or 40 ms limits. Earlier input identities remain in the evidence trail. Verify these revised input digests before dependent work:

- spec.md SHA-256 is 1f4d9bd6b79b16fe46aaa4b2f3b9eaf8dca7cb433d6349249ad2abbbf2eaec36.
- docs/implementation-graph.json SHA-256 is e998e4a494d132f3ad4e36b6c12ddfee4e9949cdd70ea01c247b6007c0ed6274.
- docs/web-app-acceptance.md SHA-256 is c7e3fca6f0fbc4fc7c6c56bf662ff9cd3efe3893d31c5909a8887fc93b766a46.

If an identity differs, inspect and reconcile the actual change before proceeding. Preserve legitimate later user edits. Never silently restore old content or claim the old identity describes the new inputs. Record the selected baseline and contract digests in the execution trail.

Use redistributable application source and public recipes for public acceptance. Record source identity and license. Private application names, identifiers, source, selectors, paths, recipes, patches, recordings, and acceptance documents must stay outside the public repository, package, and Git history. Keep separately authorized private owner testing in a stable external directory with restrictive permissions. It is not a dependency of public CI or documentation.

## Use the authorized local scope

Once this goal is activated, proceed with product edits, focused tests, builds, dependency installation in owned directories, local commits, package creation, and clean installed-package verification. Use isolated source snapshots for target applications. Run synthetic and bounded local web applications, browser capture, encoding, and the specified general web-app acceptance flows.

Create isolated candidate worktrees for bounded validation-feedback changes. Use synthetic data and declared local dependencies. Preserve caller checkouts, indexes, installed dependencies, and existing services.

Use available local Docker Engine and buildx for the restricted recipes, isolated backing services, disposable builders, and Linux verification. You may pull declared public images and remove only resources whose ownership is established. Use local macOS for its required checks. Inventory available tools and platform access at kickoff. Do not assume these prerequisites already work or install system runtimes silently.

Public mutations are not authorized. Prepare the release locally. Do not push, merge, publish to npm, create a public release, change repository visibility, deploy, or send messages to others. Production credentials, remote migrations, paid services, real user accounts, and undeclared workers remain outside this goal. Do not share private application material.

Use existing authorization for routine reversible work. Ask only when missing information, permissions, or an unavailable capability actually prevents the dependent work. Continue other independent authorized work. Respect host approval and resource limits.

## Coordinate the four owners

Use one coordinator chat and spawn subagents yourself. Run at most four concurrent owners including the coordinator. Follow the graph's permanent file ownership, dependencies, participant accounting, and independent review assignments. Use isolated worktrees or disjoint files. The integrator owns shared contracts and the lockfile.

Use the operator-approved models with reasoning_effort xhigh. Use gpt-6-astra for coordination and judgment, gpt-6.1-sol for implementation workers, and gpt-6.1-terra for the graph's second independent review. Set model and reasoning effort separately. Use fork_turns="none" when selecting a model override and provide complete task context. Reviewers replace an available owner slot. They are not a fifth worker. All configured models are GPT-family models, so do not claim cross-family review. Report an unavailable configured model and request a supported replacement.

Complete R0 through R16 in dependency order. Reuse the existing implementation and preservation tests. Replace obsolete npm-only rejection behavior with positive cross-stack behavior. Avoid a full rewrite unless concrete evidence requires one.

For each node, establish its contract and focused behavioral checks. Implement, verify, obtain independent review, repair, and integrate. After two failed focused repairs of the same requirement, diagnose the underlying contract or architecture. Do not keep repeating an ineffective patch. Start dependent work only when its prerequisites satisfy their node contracts.

## Drive the checkpoints and retain progress

Use the graph's checkpoints relative to activation:

- By hour 2, prove the full synthetic capture, masking, clock mapping, composition, encoding, and decoded-motion path. Inspect source-volume and Docker ownership feasibility too.
- By hour 10, produce an integrated general-app motion comparison through the CLI.
- By hour 14, run both public web-app normal-route comparisons with the real visible source change.
- By hour 18, create and exercise the clean installed candidate.
- Reserve hours 20 through 24 for final verification, review, and repairs.

Checkpoint failures trigger diagnosis and replanning. Keep mandatory motion, all-frame masking, general web-app use, source preservation, privacy, truthful failures, and owned cleanup. Report blockers when observed. Do not wait until the deadline to disclose them.

Keep evidence/revision-0.3-status.json, per-node evidence under evidence/revision-0.3/, and an append-only decision trail current. Record commands, actual exits, identities, artifacts, review findings, fixes, and remaining work. Keep private evidence outside public artifacts. Leave a clear next action after every completed unit so continuation survives context compaction or session interruption.

Continue execution through implementation and verification. A plan, a worker's completion message, old passing tests, or an elapsed deadline does not complete this goal. If host limits or a missing prerequisite prevent progress, report the exact blocker and preserve a resumable state. At the 24-hour checkpoint, report the observed result and incomplete gates honestly. Continue authorized work while the goal remains active and resources permit.

## Accept only the complete candidate

Set ready_for_owner_publish only when every mandatory requirement and G01 through G24 has current evidence and independent acceptance for the exact final candidate. Bind the implementation commit, source archive, package tarball, and spec digests. Rebuild and rerun affected acceptance checks when package inputs change. Historical revision 0.2 results do not certify this candidate.

Required proof includes the entire specification and, in particular:

- Static, npm, pnpm workspace, Python, and restricted Docker application comparisons through the installed package.
- Real intermediate motion, all-frame masks, source-clock alignment, truthful partial failures, and offline recomposition.
- Three complete final motion runs on each required platform and normal-speed visual review.
- Both representative public web-app scenarios through the final installed package for three consecutive runs, plus a reusable public recipe verified on a subsequent WORKTREE comparison.
- Required Linux and macOS checks, caller preservation, cancellation, resource cleanup, package contents, accurate public docs and agent skill, synthetic demos, and security and license review.
- A reviewed publishing handoff with exact commands, ownership and authentication prerequisites, provenance limits, and independent post-publish verification instructions.

Missing or inconclusive evidence is not a pass. Do not claim perfection. Report the behavior actually verified and the documented limits. Publication itself is a later owner-authorized action.

Finish with the exact candidate identity, gate report, useful synthetic demo links, reproducible public acceptance evidence, a literal repeat command, remaining limitations, and the publishing checklist. Report ready_for_owner_publish only if its full predicate is true. Otherwise name the incomplete gates and next required actions without marking the goal complete.
