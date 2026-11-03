# N0 schema review

Verdict: **ISSUES**. This review covers `src/schema/index.ts`, `src/schema/io.ts`, `src/schema/errors.ts`, `test/unit/schema.test.ts`, and `scripts/generate-schemas.mjs` against spec sections 3, 4, 7, 9 and 10. It is not a T01 or release-gate verdict.

## Comment and suppression review

The scoped scan found no actual code comments or lint/TypeScript suppression directives. The sole `//` match is the invalid URL string in `test/unit/schema.test.ts:44`. Deletions, restores, reruns, fixes and encoding offers: none. This was a native read-only equivalent of the no-comments scan, not a separate Comment Sicko worker. The assigned review forbids spawning and code edits.

## Findings

1. **Published JSON Schemas accept invalid documents rejected at runtime.** `scripts/generate-schemas.mjs:8` converts Zod schemas, but `refine` and `superRefine` checks at `src/schema/index.ts:15-20,54-64,66-67,109-112,122-125,140-150` are not represented by the generated JSON Schema. AJV 2020 accepted each of the following while the runtime schema rejected it: a scenario with duplicate step IDs; `dev.argv: ["server", "--port={port}"]`; and a timeline with `startFrame: 1` and `poster: "../outside.png"`. The published config schema also accepted `{"schemaVersion":1,"framework":"custom"}` while `parseConfig` rejected it because explicit `dev.argv` is required. This affects downstream validators relying on the package schemas, including artifact path containment and timeline boundaries. The separate runtime validation and filesystem checks still must be applied. See `spec.md:90-93`, `spec.md:157`, and `spec.md:211-213`.

2. **Capture schemas accept duplicate IDs and held frames reported as successful.** `CapturedScenarioSchema` and `CaptureBundleSchema` at `src/schema/index.ts:114-131` do not enforce unique step and scenario IDs, although `spec.md:91` requires IDs unique within their parent. A captured scenario containing the same valid step twice passes `CapturedScenarioSchema.safeParse`. `SideResultSchema` also accepts `{status:"ok", reasonCode:null, image:"frames/1.png", heldFromStepId:"old", elapsedMs:0}`. Because `CapturedStepSchema` determines verification solely from the two `ok` statuses, such a held frame can be accepted as a verified pair with a non-null change ratio. The spec requires an `ok` picture to be a new capture and says a held frame is never `ok` for a later failed or blocked step (`spec.md:155,304-312`). This is a boundary acceptance finding; the capture producer was not reviewed.

3. **Timeline validation permits a schedule that cannot be produced under the presentation contract.** `src/schema/index.ts:136-150` validates a positive step duration but does not enforce the minimum six frames derived from the 200 ms minimum hold, or the required title per scenario. A timeline containing only one `step` segment with `durationFrames: 1` and `totalFrames: 1` passes `TimelineSchema.safeParse`. A title with `scenarioId: null` also passes. `spec.md:341-343` requires a 30-frame title for every scenario and computes step lengths from the bounded hold. `spec.md:157` requires limits to be validated on compose. Runtime compose validation outside this scoped review may add checks.

4. **Public text schemas accept terminal control characters.** `HumanTextSchema` at `src/schema/index.ts:15` checks only length. It accepts `"\u001b[31mred"`; the same is true of `WarningSchema` message fields at line 86. The scenario entry point sanitizes title and note (`src/schema/index.ts:196-204`) and `ToolFailure` sanitizes its own message and hint (`src/schema/errors.ts:7-10`), but capture labels, captions, titles, source identity text, imported warnings and other direct schema inputs can pass through the schemas with controls intact. The contract requires human text to strip terminal control characters and sanitized diagnostics in public artifacts (`spec.md:93,138,377`). This establishes acceptance at the shared boundary, not that a particular completed writer currently leaks the text.

## Reproduction and verification

Node 24.22.2 with the pinned dependencies was used. `PATH=/private/tmp/swc-toolchain/node_modules/.bin:$PATH ./node_modules/.bin/vitest run test/unit/schema.test.ts` passed all 26 tests.

For independent runtime probes, the scoped TypeScript files were compiled outside the workspace:

```sh
mkdir -p /private/tmp/swc-review
PATH=/private/tmp/swc-toolchain/node_modules/.bin:$PATH ./node_modules/.bin/tsc --ignoreConfig src/schema/index.ts src/schema/io.ts src/schema/errors.ts --outDir /private/tmp/swc-review --target es2022 --module nodenext --moduleResolution nodenext --types node --skipLibCheck
ln -sfn "$PWD/node_modules" /private/tmp/swc-review/node_modules
printf '%s\n' '{"type":"module"}' > /private/tmp/swc-review/package.json
```

The session's executable probe is `/private/tmp/swc-review/repro.mjs`. It builds the generated schemas using the same `z.toJSONSchema` options as the generator and validates them with AJV 2020, with format checks disabled so the results concern the stated refinements. Relevant output included:

```text
duplicate-step runtime= false json= true
embedded-port runtime= false json= true
bad-timeline runtime= false json= true
custom config parse= rejected json= true
human raw control accepted= true
warning raw control accepted= true
partial timings= false
title without scenario= true
held status ok= true
duplicate captured steps= true
step only 1 frame= true
documented-config runtime= true json= true
documented-scenario runtime= true json= true
```

`partial timings` is recorded only as an observation. No conclusion is drawn without a specified representation for unvisited phases. The schema generation check, full suite, actual artifact writers, image hash verification and release behavior were outside this review.
