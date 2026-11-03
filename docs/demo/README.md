# Synthetic examples

The existing [success](success/compare.mp4) and [partial](partial/compare.mp4) examples are historical keyframe recordings from the earlier candidate identified below. They do not establish revision 0.3 acceptance. All app content is synthetic. The success run executes the six-step example and contains one expected absence and one side exclusion. The partial run fails a required BEFORE action, holds its last safe frame, and blocks later BEFORE steps.

The videos replay settled keyframes. They do not show continuous motion or action latency. Public metadata and the masked source and composed images are included so the declared hashes and timeline can be inspected. Private plans, logs, ownership markers and app workspaces are excluded. These copied public files are evidence; the compose command requires the original owned run directory.

Their candidate SHA-256 is `6b01bd51d5e713b205d734c29ab948458d32635c7e8dbe5b163364f7bc5d6194`, built from implementation commit `927af366c3db101dc5875768432df20dba9e7675`.

The earlier [development motion clip](../../fixtures/motion/r4-worker-development-compare.mp4) and [its observations](../../fixtures/motion/r4-worker-development-result.json) show a synthetic source-build experiment. They do not identify the current release candidate.

See [release readiness](../release-readiness.md) for current candidate identities, reviewed motion recordings, and gate results.
