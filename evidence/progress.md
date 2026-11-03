# Build progress

> Historical progress: this record covers the completed revision 0.2 candidate. Revision 0.3 implementation is in progress in the [new graph](../docs/implementation-graph.md) and [gate ledger](revision-0.3-status.json).

The complete v0.1 candidate is ready for owner publishing review. N0 through N9 and all required runtime gates passed. The final requirement matrix has 173 passed substantive rows and eight reviewed structural rows. Last checkpoint 2026-11-01T22:21:21.801006+00:00.

Started 2026-11-01T19:59:52+00:00 UTC. Deadline 2026-11-02T19:59:52+00:00 UTC.
Bangkok start 2026-11-02T02:59:52+07:00. Bangkok deadline 2026-11-03T02:59:52+07:00.
Starting spec SHA-256 `65f604f5ac2acad60e3bec0882b18f1bdc4ebfb3a51d3215f4396b6b1ec13ab8`.

## Workflow checklist

- [x] Read the Principles section of poteto-mode.
- [x] Phase A: Frame. Implement all required spec behavior and verify T01 through T17 plus release requirements against the final commit and tarball.
- [x] Phase B: Design the workflow. Freeze the shared contracts, fixture and media proof at N0. Compare two concrete interface sketches.
- [x] Phase C: Run the loop. Behavior fixture, implementation, focused check, independent review, integration, recorded evidence.
- [x] N0. Contracts, toolchain, fixture and media proof.
- [x] N1. Source isolation and runtime ownership.
- [x] N2. Recorder and masked metrics.
- [x] N3. Composer and encoder.
- [x] N4. Planner and CLI protocol.
- [x] N5. Full CLI integration and success/partial runs.
- [x] N6. Adversarial cases and repeatability.
- [x] N7. Installed tarball and generic skill.
- [x] N8. Linux full gate, macOS smoke and real app.
- [x] N9. Final corrections and owner publishing handoff.
- [x] Phase D: Keep the audit trail. Append each decision and checkpoint as it occurs.
- [x] Phase E: Verify and hand back. Every required gate must have current evidence.

## Current owners

Root owns the final evidence-only handoff commit and its last history scan and pack-identity check. Independent requirement acceptance is complete. Product code and package inputs are frozen at `927af366c3db101dc5875768432df20dba9e7675`.

The exact archive SHA-256 `6b01bd51d5e713b205d734c29ab948458d32635c7e8dbe5b163364f7bc5d6194` passed the full Linux release gate, macOS installed-package checks, three consecutive real-app runs, decoded-media review, and the implementation security scan. Each platform passed all 221 unit and 95 integration tests. Linux repeatability passed all 14 source-frame and 16 decoded-frame comparisons. No source test was skipped. C1 remains historical failed Linux evidence. The owned Linux VM is stopped and its disk and evidence are retained.

## Throughput checkpoint

The dependency bottleneck is the frozen contract, followed by integration. Use three independent module workers after N0. Keep planner and runner integration with root. Use at most four concurrent owners. Reserve the final four hours for required fixes. All file ownership changes are explicit.

## Owner handoff

Review `docs/release-readiness.md`, the exact candidate archive, and both synthetic demos. The owner can then approve the documented publishing steps, authenticate to npm, verify name ownership, publish the repository, and choose the local or hosted provenance route. No public action has been taken.
