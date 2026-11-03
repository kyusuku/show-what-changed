# Revision 0.3 specification work

Status: complete for documentation readiness. Product implementation and release acceptance remain pending.

## Goal and completion predicate

Revise the implementation contract for web applications across stacks, real browser motion, actual representative web app use, and a public open-source release. Completion requires a coherent spec, matching machine-readable and human-readable implementation graphs, explicit acceptance gates, and reviewed examples. Existing runtime code and historical release evidence remain unchanged. No package publication, repository visibility change, or deployment is part of this task.

The 24-hour implementation window is a planning target against the existing code. It is not a promise that unknown capture, environment, or publishing prerequisites have passed.

## Workflow

- [x] Read the Principles section of poteto-mode.
- [x] Phase A: Frame.
- [x] Phase B: Design the workflow.
- [x] Phase C: Run the loop.
- [x] Phase D: Keep the audit trail.
- [x] Phase E: Verify and hand back.

Concrete units:

1. Ground the current contract, installed browser capabilities, and representative web app setup.
2. Compare independent architecture candidates. Prefer a small explicit execution contract over per-framework restrictions.
3. Preserve revision 0.2 as historical evidence. Write revision 0.3 and an incremental implementation graph.
4. Update release-state pointers without attributing old test results to new requirements.
5. Run structural checks and independent design reviews. Resolve evidenced conflicts.
6. Report the revised artifacts, remaining implementation risks, and release gates.

Throughput checkpoint: two independent design candidates and one representative web app investigation run concurrently. Root owns spec integration and shared planning documents. Workers write only to assigned temporary outputs. Implementation, representative web app/application execution, and publishing are out of scope. One bounded synthetic browser capability probe supported the design; its limits are recorded separately.

## Review limitations

The operator configured only GPT-family models and no arena cross-family judge. Independent model reviews are available, but cross-family judging is unavailable. Do not invent a model or claim cross-family agreement.

## Verification

Completed on 2 November 2026 against the current documentation diff. The baseline remains a85f90f3436a14060a8af222c2941d55e8c5bdc5. Runtime checks from revision 0.2 are historical. This task verifies the documents and design, not implementation of revision 0.3.

The earlier structural validator reported 28 checks against the pre-sanitization documentation snapshot. Its exact script, inputs, and output are retained outside the public repository. That result is historical and does not validate the current sanitized documents.

The archived revision 0.2 documents in this repository were subsequently sanitized for public distribution. They no longer retain the original hashes. Earlier archive digests identify only the preserved original development snapshot. Current contracts and generated JSON examples must be checked independently; G01 and all other release gates remain pending until final-candidate acceptance.

## Accepted review corrections

Independent Astra and Terra reviews led to explicit contracts for larger bounded plans, startup-before-auth sequencing, per-consumer ports, hashed helper/seed inputs, source-versus-generated-build provenance, fixed session clock mapping, private versus public digests, disposable Docker build ownership, and image-declared volumes. Final review also corrected the universal UI-readiness claim and clarified decoded masking checks after scaling and lossy encoding.

A targeted final Terra recheck found both remaining blocking findings and the mask clarification textually closed, with no new blocking contradiction in the revised passages or their graph/ledger propagation. The original reports are preserved outside the public repository. This is document review, not empirical proof of the future implementation. No cross-family judgment was available.

## Handoff and remaining work

The normative input is [spec.md](../../spec.md). The [implementation graph](../implementation-graph.md) divides the migration into four owners, 17 tasks, checkpoints, review/repair loops, and 24 acceptance gates. The [general web-app contract](../web-app-acceptance.md) defines reproducible public normal-route scenarios and a reusable recipe. The [new ledger](../../evidence/revision-0.3-status.json) starts entirely pending.

The first implementation checkpoint must prove the sustained sanitized capture/mask/clock/encode/decode path. The earlier local probe established API feasibility only. The representative public application build, generic inert dependency helper, installed-package repeats, Docker lifecycle, and Linux/macOS acceptance still require execution. The 24-hour schedule assumes prepared hosts and tools and does not override failed gates.

README, limitations, publishing, and readiness pointers distinguish the old candidate from the new target. Publication remains separately authorized. No product implementation, representative web app execution, package creation, commit, push, or publication occurred in this revision task.
