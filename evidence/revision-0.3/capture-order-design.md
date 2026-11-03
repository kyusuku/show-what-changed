# Capture ordering and rejection evidence

The goal is reliable, truthful motion capture for general web applications. The selected hardening uses one Chromium screencast slot and preserves the existing ACK boundary, original source timestamps, strict timestamp rejection, and public schema.

The original Linux `CAPTURE_TIMESTAMP_REGRESSION` failure remains unexplained. Its offending scalar pair was not retained. Equality, reversed delivery, and source-clock reversal remain possible. Passing prototype runs do not identify that cause.

## Decision

The pinned Chromium implementation increments its in-flight count before a ThreadPool encode and emits each successful frame when its encode completes. ACK releases that slot. Two slots permit overlapping encodes and therefore completion in the opposite order. One slot prevents that overlap within an uninterrupted session. It does not establish unique timestamps, an increasing source clock, or complete capture of browser presentations. The strict `<=` guard remains necessary. See [Chromium 156.0.8078.4 screencast implementation](https://github.com/chromium/chromium/blob/156.0.8078.4/content/browser/devtools/protocol/page_handler.cc#L1761).

| Alternative | Decision |
| --- | --- |
| One slot with the existing post-sanitization ACK | Selected after bounded full-path screening. Browser encode and client processing overlap less, so cadence must still satisfy the quality gates. |
| Bounded reorder | Rejected. A slow outstanding encode can survive arbitrarily many newer ACKed events. Holding ACKs for a complete two-event batch cannot finish a static one-event stream without an independent completion signal. |
| Sort finalized metadata | Rejected. Stop response does not prove completion of outstanding encodes. Sorting also changes receipt-sequence meaning and can conceal a real source-clock reversal. |
| Diagnostics alone | Retained as evidence collection, but insufficient to remove the known ordering risk. |

The source setting remains private to the CDP adapter. There is no new configuration option or cross-layer phase API. Browser presentations skipped before CDP delivery remain unknown through `sourceDroppedFrames: null`.

## Rejection record

The recorder keeps immutable observations containing only receipt sequence, original source seconds, and host receive elapsed milliseconds. It retains the last accepted observation and captures the immediate receipt predecessor before asynchronous processing.

The first timestamp rejection emits one `capture-timestamp-rejection` event with the side enum, current observation, previous received observation, last accepted observation, numeric difference, and `equal` or `backward` relation. A throwing rejection sink cannot replace the capture fault or skip raw release and ACK. The existing diagnostic sink controls retention.

The record contains no caller context, scenario or step identifiers, URLs, selectors, application text, paths, pixels, payloads, or frame hashes. It can distinguish equality from a negative difference. It cannot identify the browser's encode admission order or establish the original failure's cause.

Four focused cases failed for absent evidence before implementation and passed afterward. They cover equal timestamps, backward timestamps, receipt while masking is pending, and a throwing rejection sink. The complete frame-stream unit file passed 56 tests, and type checking passed on Node 24.22.2. Existing first-fault, raw ownership, ACK, and forced-cutoff behavior remained covered.

## Bounded prototype

Two frozen source copies differed only in the slot literal. Their installed packages differed only in `dist/recorder/motion.js`. Each newly packed package reused the same pinned production dependency tree. This was not a cold-install release check. An earlier offline installation attempt failed before measurement because the selected cache lacked dependency metadata. That preparation failure was retained.

The existing installed verifier ran the real capture, masking, composition, encoding, and decoding path once for each required viewport and each variant. Independent case invocations prevented one failed viewport from suppressing the other. A sink-only temporary overlay retained rejection records. No assertions, timings, thresholds, or frame data changed, and no case was retried.

All four cases passed on macOS arm64 with Node 24.22.2 and Chromium 156.0.8078.4. Each position pair below is BEFORE then AFTER. Gaps and pulse differences are maxima across the case.

| Slots and viewport | Source positions | Decoded positions | Moving source gap, ms | Source pulse difference, ms | Decoded pulse difference, ms |
| --- | --- | --- | --- | --- | --- |
| 2, 1280 × 800 | 166, 166 | 87, 87 | 99.996 | 0.072 | 0 |
| 1, 1280 × 800 | 110, 105 | 88, 88 | 63.810 | 2.150 | 0 |
| 2, 390 × 844 | 176, 176 | 89, 89 | 62.202 | 0.014 | 0 |
| 1, 390 × 844 | 129, 125 | 86, 85 | 83.330 | 0.119 | 0 |

The gates stayed at 60 actual source and decoded positions, a 200 ms known-moving source gap, all three source and decoded pulses, and 80 ms pulse alignment. Every measured decoded moving gap was 33.334 ms or less. All-frame source masks, decoded mask interiors, native transition positions, inner scrolling, and clock bounds passed. The largest clock error bound was 7.629 ms.

All 1,409 counted received frames were persisted and acknowledged, with zero rejected frames and zero timestamp-rejection records. Every case passed its owned-process cleanup checks and closed both fixture servers. The separate late-stop accounting issue means these counters do not prove completeness of all possible post-stop deliveries.

Host load varied substantially. The one-minute load averages before the four cases were approximately 24.5, 37.3, 48.1, and 36.8 on ten logical CPUs. This is a one-repetition quality screen with competing host load, not a speedup measurement or a reliability-rate estimate.

## Identity and remaining evidence

| Variant | Source archive SHA-256 | Package SHA-256 |
| --- | --- | --- |
| Two slots | `a1b357ff19a998865959f5ff919a814337ac82884a8d64596f7ea7a930093307` | `e082086f78fe812740f759d7bd837f4425cb247664c7e82662dd251c7e1a4aa3` |
| One slot | `d3e2f494371a389da366b39955fdf073f8c443542bff4212a84a10f5f95ead12` | `c9484357571d6f86212f4e51c611887d01039caaf03150c5d0542ebabad52ed2` |

At promotion, `motion.ts` exactly matched the tested one-slot source with SHA-256 `079a584fc958b4d43405a004e9efdb2597336be205db54fadae1909355b129e4`. The focused test file had SHA-256 `843c405925c2965d4cee1186bb5f25d8a3fba08e306abbec2a99aa34972bd409`. Later shutdown repairs require new artifact identity and affected verification.

Independent diagnostic and shutdown review, the repeated final platform matrix, Linux and odd-size regression checks, fresh final-package installation, and normal-speed visual review remain required. No release gate is closed by this prototype.
