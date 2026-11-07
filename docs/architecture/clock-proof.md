# Clock proof for 0.1.2

This addendum defines the 0.1.2 clock-proof contract. It supersedes the clock-measurement and final-sampling order in [specification section 7.2](../../spec.md#72-motion-backend-and-clocks) for the new proof branch. The historical specification and release evidence remain unchanged.

The recorder keeps one unit-rate mapping for each browser session:

```text
runElapsedMs = sourceSeconds * 1000 + offsetMs
```

The 40 ms error limit, source timestamp order, frame masks, motion acceptance thresholds, and ownership rules remain unchanged. A follow-up clock measurement never changes the offset or a recorded timestamp.

## Why a delayed response needs a different proof

A request brackets a browser clock reading between the host's send and response observations. A slow response makes this interval wide. That interval alone does not distinguish a changed clock from delayed delivery.

The legacy proof uses the largest half round trip plus the largest midpoint deviation from the fixed offset. A single delayed response can therefore exceed 40 ms. The new proof retains that response and allows one fresh measurement to establish a tighter endpoint. Contradictory evidence still fails immediately. A second ambiguous measurement ends the attempt.

## Supported clock relationship

The new proof applies to the standard Node 24 runtime and the locally owned, pinned Chromium on Linux and macOS. Unknown transports retain the legacy proof. The proof trusts the documented operating-system clocks and the standard runtime implementations. It does not claim to authenticate modified binaries, remote clocks, injected clock overrides, or faulty firmware.

On Linux, both runtimes read `CLOCK_MONOTONIC` in the same operating-system clock domain. Their relative offset is constant, including shared clock adjustments. See [Node's Linux clock](https://github.com/nodejs/node/blob/v24.22.2/deps/uv/src/unix/linux.c) and [Chromium's POSIX clock](https://github.com/chromium/chromium/blob/156.0.8078.4/base/time/time_now_posix.cc).

On macOS, Node reads continuous time and Chromium reads absolute time. Apple's API defines continuous time to advance through sleep. Both use the Mach timebase. Their relative offset is constant while awake and increases across sleep. The proof accommodates that increase while rejecting a shift that exceeds its error limit. See [Apple's Mach clock contract](https://github.com/apple-oss-distributions/xnu/blob/xnu-12377.1.9/osfmk/mach/mach_time.h#L33-L63), [Node's Darwin clock](https://github.com/nodejs/node/blob/v24.22.2/deps/uv/src/unix/darwin.c#L50-L59), and [Chromium's Apple clock](https://github.com/chromium/chromium/blob/156.0.8078.4/base/time/time_apple.mm#L36-L79).

This is an operating contract, not an inference that matching measurements prove clocks cannot change. An observable reset, incompatible interval, invalid ordering, or excessive offset shift fails the affected side.

## Endpoint bound

Let `D(t)` be the host clock minus the source clock at one instant, in milliseconds. Within the supported clock relationship, `D(t)` does not decrease. Conversion rounding requires a bounded allowance.

Each sample provides an interval for its offset:

```text
lower = hostBeforeMs - sourceSeconds * 1000
upper = hostAfterMs - sourceSeconds * 1000
```

The recorder retains all five startup samples and selects the narrowest sample's midpoint as its fixed offset. That sample is the lower anchor. A later endpoint supplies the upper bound. For any covered event between those anchors, the possible offset lies between the lower anchor's lower bound and the later endpoint's upper bound.

The proof expands both ends for numeric error. A per-offset allowance of 0.01 ms covers native conversion and floating-point rounding within the supported finite magnitude of `2^40` milliseconds. Two such allowances cover the endpoint-to-event comparison. The allowance applies globally. It is never added again for each measurement.

The maximum distance between the fixed offset and the expanded interval bounds the mapping error. Every accepted proof must remain at or below 40 ms. The record retains the maximum accepted bound. A broad intermediate response remains raw evidence and must be consistent with every later interval. It does not become an accepted error bound merely because its individual round trip was slow.

All samples remain in acquisition order. Their host brackets cannot overlap, and their source timestamps must increase. A running maximum of prior lower bounds detects contradictions with later upper bounds. The proof also rejects intervals that establish an excessive shift without needing a follow-up.

## Frame coverage and shutdown

Frame timestamps must fall strictly between the lower anchor and the final source sample. Equality alone cannot establish ordering across a stopped source clock. A frame outside the proven interval fails capture. The recorder does not discard that frame and claim a complete recording.

The recorder retains `sendLastFrame: true`. Chromium clears its cached image when capture starts. The option retains the latest frame while an acknowledgement is outstanding. See [Chromium's screencast implementation](https://github.com/chromium/chromium/blob/156.0.8078.4/content/browser/devtools/protocol/page_handler.cc#L1532-L1593).

For the new proof, shutdown stops the source and drains pending marker measurements, then cuts off subscription delivery before acquiring the final endpoint. That endpoint must cover every admitted frame, including frames awaiting masking or persistence. Final validation precedes a successful capture result. Source-stop time remains separate from later sampling, acknowledgement, persistence, and disposal.

Chromium's frame reference time can name an expected display time slightly ahead of callback delivery. If the first final sample does not yet cover an admitted frame, the recorder can wait up to 40 ms before its one final follow-up measurement. The same follow-up budget handles an ambiguous endpoint. A second insufficient sample, a larger future interval, or an expired cleanup deadline fails capture. No frame timestamp changes.

The same fulfilled-acknowledgement counts, bounded queues, masking, cancellation, and cleanup rules still apply. Subscription cutoff does not prove Chromium delivered every upstream frame. The source-drop count remains unknown.

## Action event timing

Dispatch denotes invocation of the step attempt through `performAction`. A locator wait can delay the eventual browser input. The recorder does not label step invocation as the exact DOM input time.

A dispatch marker must be close to the actual host invocation time. The recorder checks freshness and invokes the callback in the same synchronous operation. A stale first measurement can use the one allowed fresh request before invocation. Cancellation or failed timing prevents invocation.

Completion and observation end are events that already happened. The recorder captures their host observation times before requesting a source measurement. If delivery is delayed, a later sample can prove the original sample's mapping. It cannot move the event or replace it with a later timestamp. A source marker too far from the original host event fails.

New markers retain their source sample identity and host event time. Saved-capture validation checks both event proximity and membership in the retained clock evidence.

## Artifact compatibility

The new clock record uses an explicit `proof.kind = "monotone-endpoints"` branch. It retains the common rate, fixed offset, samples, and error bound. Its anchor and final indices identify the proof interval. The old uncertainty and midpoint-drift fields keep their original meanings in the legacy branch. The public manifest reports `maxDriftMs: null` for an endpoint proof.

The updated reader accepts legacy clock and marker records. Old readers reject the new strict shapes. This is backward reading compatibility, not forward compatibility. Generated schemas and runtime validation describe the same branches.

A numeric proof does not establish motion quality or release readiness. The installed archive must still pass the unchanged motion and application comparison gates on the supported verification platforms.
