> Historical document sanitized for public distribution. Its content is not a byte-for-byte copy of the original development record. It is not current release evidence.

# Specification audit — show-what-changed

**Date:** 2 November 2026. **Reviewed input:** original 1,049-line draft, preserved verbatim in [spec.original-2026-11-01.md](spec.original-2026-11-01.md). **Revised contract:** [spec.md](../../spec.md). **Build decomposition:** [graph](../implementation-graph.md).

## Verdict and limits

The original is a useful product roadmap, but it is not a consistent 24-hour implementation contract. It combines multi-release features with first-release promises, leaves key semantics open, and can produce misleading evidence when BEFORE fails. The recommended replacement keeps the defining outcome—one labeled paired video from a scenario on two source versions—while explicitly calling it a **keyframe replay** and removing integrations that need their own isolation/state/lifecycle work.

The audit is design work. No application exists in this workspace, no product test suite has run, and no package/repository has been published. Local probes validate specific Git/FFmpeg assumptions only. The new acceptance matrix and hour gates must still be implemented and passed before public readiness can be claimed. A 24-hour build is a reasonable attempt with the stated four-owner allocation, not a measured delivery promise.

There is no provable state in which software has no conceivable improvement. The audit stopping rule is narrower and useful: every in-scope input/output/failure/lifecycle contract is specified; accepted findings have a disposition and acceptance test; independent reviewers find no remaining blocking contradiction; remaining ideas are explicitly deferred or release-time evidence gates. Feature expansion cannot continue indefinitely under a one-day deadline.

## Architectural alternatives considered

| Option | Advantage | Cost / reason |
|---|---|---|
| Full original roadmap in one release | Maximum automation: many adapters, MCP sessions, auth/HAR, continuous capture, caching | Too many coupled lifecycle, security and compatibility problems for 24 hours; rejected for initial release |
| **Isolated Git snapshots + explicit/keyframe scenarios + CLI skill** | Keeps the core value, one truthful paired artifact, testable module contracts, agents can call CLI | Requires setup and npm-only/simple-app scope; motion and integrations deferred; recommended |
| Compare two caller-managed URLs only | Fastest browser/media spike | Cannot establish Git/dirty-source provenance or automatic version startup; useful fallback demo, not equivalent to this release |

The main architectural improvement is a **persisted capture/timeline seam**. Browser actions, presentation and encoding no longer depend on one another's live objects. A failed encode can be retried without running the app again. A pure plan never owns servers. One runner owns all resource cleanup and reduces status once.

A second important improvement came from a local capability check: the installed FFmpeg has no `drawtext`. A trusted isolated Chromium template now renders labels/captions into PNGs; FFmpeg only encodes them. This uses a dependency already required by capture and removes font/filter-string interpolation and static-binary distribution from the critical path.

## Findings and dispositions

Severity here is design priority: **P0** blocks safe/honest planning of the original release; **P1** changes correctness or implementation contracts; **P2** improves reliability or launch clarity. Original references refer to the preserved archive, not the rewritten spec's line numbers. Each row is resolved by a replacement contract or explicit deferral; the implementation tests listed are required future evidence.

| ID | Priority | Gap in original | Original evidence | Decision in revised spec | Tests |
|---|---|---|---|---|---|
| A01 | P0 | No 24-hour cutline; milestones explicitly have no dates | §21, lines959–969 | One public experimental 0.1 scope, four owners, timed gates and repair buffer | T16–17, graph |
| A02 | P0 | Primary flow requires MCP while MVP is CLI-only; late flags advertised early | §4.1/6/21 | Required CLI + generic skill; MCP and all late flags deferred | T01,T14,T16 |
| A03 | P1 | HEAD/default merge-base semantics change by example and dirty state | §6.2/22.2 | HEAD exact default; explicit merge-base switch; pinned full OIDs | T02 |
| A04 | P1 | Triple-dot diff does not describe rendered arbitrary endpoints | §9.1 line396 | Exact endpoint tree comparison; inventory comparison for WORKTREE | T02 |
| A05 | P1 | Staged, unstaged, ignored retained tracked files and untracked state unspecified | §9.1/11.1 | Final filesystem inventory, not patch union/index intent; filenames NUL-delimited | T02–03 |
| A06 | P0 | Live AFTER checkout can mutate or change during recording | §11.1 line457 | Copy to isolated snapshot, validate source and destination inventories, pin identities | T03–04 |
| A07 | P0 | TS config import can execute before trust | §7 line219/§15 | JSON-only config/scenarios; pure plan; consent before repo execution | T01,T04 |
| A08 | P0 | Trust hash misses referenced code/old ref scripts and Git hooks/filters | §15/11.1 | Explicit per-run consent, hooks disabled, custom filters rejected before conversion | T04 |
| A09 | P1 | SHA/lockfile caches and shared node_modules violate source isolation | §11.1 lines460–469 | Fresh per-run/side workspaces and independent npm installs | T03–04 |
| A10 | P0 | Env copying lacks collision, containment and crash ownership policy | §7/11.1/15 | Env copying deferred; private owned output, no automatic credential propagation | T04,T13–14 |
| A11 | P1 | Port bind probe cannot prove serving process; silent fallback/races | §11.2 | Bounded retry, lsof/ps ownership and loopback verification, exact port | T12 |
| A12 | P0 | PID files can kill unrelated recycled PIDs; cleanup excludes some children | §11.2/6.1 | Live supervisor owns all subprocesses; bounded cleanup; no automatic orphan killing | T12–13 |
| A13 | P1 | Plan file has no CLI consumption/freshness contract; retained server has no CLI lifetime | §6.1/8.3/13 | Pure immutable Plan, `compare --plan`, config/source freshness, no server leases | T01,T14 |
| A14 | P1 | Route mappings conflict; imports/dynamic omissions look like no change | §9/16 | Conservative direct/scoped mapping; explicit unresolved/omitted/unsupported buckets | T05 |
| A15 | P1 | Removed pages, unsupported slots, cap/rank and explicit override unclear | §9 | Both endpoint inventories; deterministic selection and honest coverage/exit rules | T05 |
| A16 | P1 | Broad step list has no actual operand schema | §8.1 | Seven discriminated ops, exact locators, strict bounds/unknown-field rejection | T01,T06 |
| A17 | P0 | Required BEFORE failure can still return success; fuzzy fallback may act on wrong element | §11.5/16 | Freeze failed side, partial exit3, no fuzzy actions, held images never verified | T06–07 |
| A18 | P1 | Optional/side semantics are undefined on AFTER; missing differs from disabled/ambiguous | §8.1/11.5 | Explicit `only`/`allowMissing` matrix; all failure kinds distinguished | T06–07 |
| A19 | P1 | Paused clock plus animation-frame settle can hang | §8.1/10 | setFixedTime with real timers and monotonic operation deadline | T08 |
| A20 | P1 | Network-idle/scroll heuristics do not define stable data or paired step count | §8.1/8.2 | Explicit visibility readiness, bounded fonts/RAF, fixed shared scroll offsets | T06,T08 |
| A21 | P1 | Parking pointer removes hover before the named hover screenshot | §8.1 example/10 | Preserve pointer/focus through checks and captures | T08 |
| A22 | P1 | Deterministic randomUUID changes app semantics; determinism overclaimed | §10 | No crypto/random rewriting; fixed browser Date only; data parity unverified | T08,T15 |
| A23 | P1 | Identical auth storage is not portable across local origins | §7/11.3 | Auth deferred; fresh anonymous contexts and stateless/disposable fixture | T08,T17 |
| A24 | P0 | Sequential DB resets do not isolate parallel mutations; “dry run” executes actions | §11.2/13 | Hooks/validation command/backend modes deferred; disclose action side effects | T06, docs |
| A25 | P1 | HAR from AFTER port misses BEFORE URLs; fallback silently uses live data | §10.1 | HAR deferred; later origin mapping and strict misses need own fixture | scope |
| A26 | P0 | Screenshot mask is not blur and does not protect native/CDP video | §11.3/15 | Every artifact derives from masked screenshot path; all other capture deferred | T09 |
| A27 | P1 | Burst frames lack timestamps and defined lengths; exact timeline/recompose impossible | §11.3–11.6 | One settled keyframe per step; integer frame schedule; persisted capture/timeline | T10–11 |
| A28 | P1 | Mixed viewport/layouts, rounded durations and scaled boxes lack geometry contract | §6.2/11.4 | Fixed letterboxed canvas, no boxes/device changes, exact frame counts | T10–11 |
| A29 | P1 | Inline drawtext escaping and system/static-build capabilities vary | §11.4 | Isolated trusted HTML→PNG; no input HTML, zero renderer network, simple FFmpeg pipe | T10–11 |
| A30 | P1 | `--json` plan/error/manifest outputs are incompatible undocumented shapes | §6/12/13/16 | One typed result envelope, stdout discipline, versioned schema family | T01,T14 |
| A31 | P1 | Minute+SHA run IDs collide; output/cleanup path trust and retention unclear | §12/11.2 | Random exclusive IDs, canonical containment, owned cleanup, no auto-pruning | T13 |
| A32 | P0 | “No egress” conflicts with installs/live APIs; redaction guarantees too broad | §12.3/15 | No telemetry/upload promise only; code retains account/network privileges | T09,T14, docs |
| A33 | P1 | Node20 assumed supported; latest browser installer can mismatch package | §6/18 | Node24 tested, pinned Playwright installer/browser, explicit prerequisites | T16 |
| A34 | P1 | Source tests do not prove packed package/bin/font/schema/skill works | §19–20 | Clean installed-tarball gate plus Linux/macOS evidence | T16 |
| A35 | P2 | `gh` attachments, third-party compatibility, size promises unverified | §12.3 | Local pr.md only, no fake playable URLs or compatibility claims | T14,T16 |
| A36 | P1 | representative web app success depends on auth/env/monorepo features scheduled later | §20–23 | Synthetic fixture mandatory; compatible real app smoke; representative web app conditional | T17 |
| A37 | P2 | Registry checks/market uniqueness/trademark confidence treated as settled | §0/1/3 | Historical research retained, claims removed; availability/license checks at release | release gate |
| A38 | P1 | Public release lacks one measurable complete artifact/gate record | §23 | Package allowlist, history secret scan, advisory/license review, digest and owner release action | T16–17 |

## Second-pass corrections

The first rewrite underwent fresh independent capture, workspace/security and scope/contract reviews. Those reviews identified further interactions between otherwise reasonable decisions:

- Git's WORKTREE diff uses index state: a removed-from-index file retained and ignored on disk may be rendered but reported deleted. WORKTREE changedFiles now comes from the actual final inventory.
- Working-tree Git diff can invoke clean filters before consent. Filter preflight is explicit and that diff is no longer necessary for the planner.
- WORKTREE workspaces now use the pinned plan OID; a moved HEAD invalidates a saved WORKTREE plan.
- Source validation re-enumerates newly created files on both sides, checks destination content/modes too, and rejects file↔directory overlays rather than implementing partial semantics.
- External custom config freshness now records its original private path/raw-byte hash.
- Automatic mixed coverage (a valid route plus an unresolved component/unsupported route) yields partial; explicit bounded selection remains success with a coverage limitation.
- App dependency installation may download only under consent; automatic tool prerequisite installation remains absent.
- lsof/ps are explicit prerequisites; all listener addresses must be loopback and belong to the live owned process group.
- The source image is contained/letterboxed into an integer rectangle; it is not stretched to an inconsistent aspect ratio. Font/image readiness is verified, captions cannot resize the canvas, and metadata text has a deterministic supported-character fallback.
- Exact `image2pipe` repetitions replace ambiguous image-concat duration/last-frame rules.
- Browser-free `compose` checks only its phase's prerequisites and updates all terminal metadata/hashes/pr.md after encoding recovery.
- Capture/coverage/provenance incompleteness gets a visual badge. A cleanup-only failure discovered later is an operational partial in the manifest/CLI/pr.md, avoiding an encode→cleanup→re-encode loop.
- Same-document fragment navigation handles Playwright's null navigation response narrowly, rather than treating every null as success or failure.

The final contract pass also limited HEAD freshness checks to WORKTREE plans, assigned source-frame metric computation solely to recorder, and corrected the hour-12 graph gate to built CLI (installed tarball remains hour18). These corrections are incorporated into the current spec and relevant acceptance cases. The decomposition graph keeps the agreed schema boundary ahead of parallel work and reserves integration/failure tests before package and release tasks.

## Actual verification performed

[validation.json](validation.json) records disposable local probes:

1. **Git diverged refs:** exact endpoint diff reports the base-only file deletion and after-only addition; triple-dot misses the base-only difference.
2. **Index-only deletion:** `git rm --cached` plus an ignored retained disk file reports deletion through Git diff and no untracked replacement. This reproduces the provenance/planning mismatch and supports inventory-derived WORKTREE semantics.
3. **FFmpeg capability:** this local binary has no drawtext filter.
4. **Integer PNG pipe:** streamed 24 red PNG frames plus 24 blue PNG frames. H.264/yuv420p at 30 fps decoded to exactly 48 frames / 1.6 seconds; frames 0/23 are red and 24/47 blue, including the final boundary. This verifies a small media primitive, not the product, HD performance or packaging.
5. **Document checks:** local Markdown links, JSON examples, graph acyclicity/dependencies, test-ID coverage and source archive hash are checked in the audit session. The result is recorded in `document-checks.json`.

Current upstream facts were checked against primary documentation: [Git semantics](https://git-scm.com/docs/git-diff), [Playwright fixed time](https://playwright.dev/docs/clock), [screenshot masking](https://playwright.dev/docs/api/class-page#page-screenshot), [auth](https://playwright.dev/docs/auth), [HAR](https://playwright.dev/docs/mock#replaying-from-har), [Node releases](https://nodejs.org/en/about/previous-releases), and [GitHub CI guidance](https://docs.github.com/en/actions/reference/security/secure-use). These substantiate the relevant technical corrections, not a claim of a completed application.

## Final review disposition

After the findings were incorporated, three independent reviewers checked the revised contracts and then verified the final corrective edits. Capture/composition, workspace/security, and scope/graph reviews each reported **no remaining blocking findings for the scoped v0.1 specification**. These are design-review conclusions, not runtime or public-release approval. The document/graph check passed with 10 acyclic task nodes and coverage of all 17 acceptance IDs. [Review record](review-disposition.json).

## Remaining build risks and fixed responses

| Risk | Build gate / response |
|---|---|
| Node/browser/Next/tool APIs differ at chosen patch versions | N0 pin-and-spike; update exact dependency lock and fixtures together |
| Safe snapshots and process supervision take longer than expected | N1/N5 checkpoints; no cache/monorepo/auth expansion; do not cut correctness |
| Next dev rewrites tracked/generated source or an app needs ignored env files | Report unsupported/invalid provenance; fixture includes stable configured source; choose a compatible public/stateless real-app route |
| App content/backend data varies despite fixed browser options | Manifest says parity unverified; use disposable fixture data and explicit readiness; no universal determinism claim |
| Chromium template/HD encoder performance is too slow | Measure in N0/N5, keep finite limits; do not revive burst capture or broad format support |
| Final public prerequisites are unavailable | Produce tested local release candidate and exact missing gate; publication is separate from the audit/build |

The retained limitations are deliberate release boundaries, not concealed unresolved requirements. Continuous capture, robust state parity, other package managers/frameworks, MCP and caches deserve subsequent releases with their own fixtures and contracts.
