# Revision 0.3 design decisions

This record explains the specification change for general web applications, motion recordings, and mandatory representative web app use. It is not implementation or release evidence.

## Selected shape

The base is the Astra candidate's explicit recipe, schema 2, separate application runtime, and in-memory browser frame pipeline. The restricted Docker Engine service ownership from the Terra candidate replaces the base candidate's general Compose backend. Both candidates preserve exact source snapshots and honest failures.

| Criterion | Astra candidate | Terra candidate | Selected decision |
| --- | --- | --- | --- |
| Cross-stack execution | Host recipes plus Compose | Host recipes plus bounded containers | Host recipes plus bounded Docker Engine |
| Motion source | Actual screencast frames | Repeated masked screenshots | CDP PNG frame stream |
| Privacy before persistence | Fixed rectangles on decoded frames | Selector masks in every screenshot | Fixed rectangles in motion; selectors only in keyframes |
| Timing | Source clocks with measured mapping | Screenshot completion timing | Source monotonic clocks and explicit uncertainty |
| Migration cost | Schema 2 only | v1/v2 compatibility readers | Schema 2 only for unpublished package |
| Acceptance | Useful normal-route comparisons | Useful normal-route comparisons | Redistributable public flows through the installed package |

The rubric favored source identity, small public configuration, faithful motion, privacy before disk, owned cleanup, and a bounded migration. The scores are qualitative design judgments, not measured performance rankings.

A mandatory container-only design would make Docker a prerequisite even for static sites and existing host workflows. A framework-adapter list would keep compatibility dependent on new product code. A URL-only recorder would not establish that the shown applications came from the requested source snapshots. These alternatives were rejected for this release.

General Compose support adds interpolation, override, external-volume, and resource-ownership cases. The chosen contract supports a web Dockerfile and pinned backing-service images through a constrained adapter. Arbitrary Compose is explicitly deferred. Container builds use a disposable buildx builder so cancellation can stop owned build work and remove its dedicated state, without pruning the owner's existing builder/cache. Both app and service images receive explicit image-volume checks.

## Motion evidence

A throwaway probe used installed Playwright 1.64.1, Chromium revision 1248, Node 24.22.2, and pngjs 7.0.0 on macOS arm64. Two isolated synthetic pages were captured concurrently without application servers or network requests.

The observed CDP path supplied PNG bytes and finite monotonic source timestamps. Six sampled PNGs were decoded, masked in memory, verified pixel-by-pixel, then persisted. The probe did not continuously sanitize every frame and did not compose or encode a final video. It did not run on Linux.

The initial sandbox launch could not register Chromium's Mach port. The same bounded synthetic command succeeded through normal execution escalation. No automatic approval rejection occurred. All owned browser resources closed.

The local probe artifacts and exact rerun script are retained in a development archive outside this repository. The retained report distinguishes one-run API feasibility from the unverified sustained pipeline.

Source timestamps and callback arrival are different observations. The probe found values that make naive wall-clock subtraction negative. Consequently the spec requires a documented common monotonic clock, calibration uncertainty, drift evidence, and source gaps. An exported 30 FPS file cannot alone pass the motion gate.

The chosen privacy contract avoids dynamic selector geometry races. Rectangles cover fixed viewport regions in every frame before persistence. Element-following masks in motion remain unsupported. Keyframe selector masks remain available explicitly.

## General web-app acceptance

The source design streams full repositories with a 1 GiB default limit. Public synthetic volume checks cover large inputs without excluding tracked documentation. Root workspace installation and shared-package builds must work through the generic recipe contract.

The owner clarified that the public repository must contain no private application context. The public contract now uses redistributable web applications and synthetic dependencies. Private validation inputs and original development records were preserved outside the repository. The [acceptance contract](../web-app-acceptance.md) defines repeatable public evidence without depending on private access.

## Scope and evidence migration

The original spec SHA-256 is 65f604f5ac2acad60e3bec0882b18f1bdc4ebfb3a51d3215f4396b6b1ec13ab8. Its sanitized historical reference is [revision 0.2](spec.r02-completed-2026-11-02.md). Archived relative links retain their original location semantics and are historical text, not current navigation.

The current code, schemas, skill, and demos continue to implement revision 0.2. Public-facing runtime instructions must not claim the new schema works before implementation. Current readiness pointers explicitly distinguish the historical candidate from revision 0.3.

The new graph is an incremental migration over that code. Old passing evidence is preserved. All G01–G24 statuses start pending. Changing the spec alone does not satisfy a release gate.

## Principles and review

Redesign From First Principles changed the foundation from npm detection to an explicit execution contract. Experience First made actual motion and useful general web-app comparisons primary acceptance criteria. Prove It Works required a real API probe and future installed-package checks rather than relying on types or existing tests.

Independent architecture candidates used gpt-6-astra and gpt-6.1-terra at xhigh. The configured cross-family judge pool is empty, so no cross-family review occurred. Independent design reviews use those same GPT-family models; agreement is not claimed as cross-family validation.

The decision trail is [spec-revision-0.3-decisions.tsv](spec-revision-0.3-decisions.tsv). Final document validation and accepted review corrections are recorded in the work report.
