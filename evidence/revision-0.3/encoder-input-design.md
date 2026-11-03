# Bounded encoder input lifetime

Status. Selected design. Implementation and installed verification remain pending.

The first installed Linux motion case was killed at the unchanged 3 GiB container limit during encoding. Capture and rendering completed. The encoder input contained 157 planned packed frames. Its Node process was the recorded OOM victim.

A controlled Node 24 probe reproduced a separate, concrete defect in the exact packaged `sendPng` function. All 16 completed 4 MiB writes remained reachable while the process exit promise was pending. The Writable queue was empty. Resolving the process exit promise released every buffer and backing store. Removing only the per-write exit reaction also released them before exit. That control omits required failure handling and is not a production fix. Two independent investigators reproduced the retention, and the coordinator reran the packaged-function probe.

The same defect can retain roughly 2.39 GB for this Linux timeline. That arithmetic is consistent with the OOM evidence. Attribution of the original failure remains an inference until the repaired installed workload runs under the same limit. RSS alone is not evidence of buffer reachability or release.

## Selected operation

Replace `sendPng` with one internal composer operation, `writeEncoderFrames(child, frames, run)`. It consumes an iterable or async iterable of packed buffers sequentially, finishes input, validates process exit, and disposes its own listeners. The composer supplies an async generator. The capability probe supplies its two existing frames. Both callers migrate together and the old helper is removed.

One private session owns the terminal process result and at most one pending write settlement. It installs one process-exit observer for the entire encoder lifetime. Each real write callback clears the pending settlement before the producer advances. The session stores no frame history, completed-write list, producer, or image cache. Removable stream and abort listeners are detached on every exit path.

Keep the process-exit observer. The public stdin belongs to a persistent process anchor, whose pipe can remain open after the target exits. A controlled probe of the actual anchor confirmed this ordering. Stream-close observation alone is insufficient.

Remember a successful process exit between completed writes. Reject if the producer supplies another frame. If the producer is exhausted, completion may accept the successful exit. This preserves an encoder that consumes its configured final frame before the caller sends EOF. A failed write, abort, stream error, rejected process result, or failed producer remains a failure even if a later exit code is zero.

The existing supervisor retains process and group ownership. Both caller failure paths destroy their input and stop only the owned process as needed. The shared `OwnedProcess` contract, media validation, source timing, frame selection, capture limits, encoder settings, and acceptance thresholds remain unchanged.

## Alternatives and verification

The other viable design exposes `write`, `finish`, and `dispose` on a writer object. The selected single operation keeps that sequence internal and prevents callers from omitting disposal. A removable process-exit subscription would expand the shared supervisor contract for one composer concern. Clearing a captured buffer alone would leave unbounded promise reactions. Per-frame `Promise.race` would retain the same lifetime problem.

The configured reviewers are all GPT-family models. No cross-family judge is configured or claimed.

The next checkpoint is a bounded lifecycle and reachability test unit. Verify callback completion and backpressure, no producer prefetch, synchronous and asynchronous write failures, abort and deadline handling, exit while the anchor pipe remains open, final success before EOF, producer failure, first-fault retention, and listener disposal. Prove that the number of process observers stays constant across many writes. Then obtain independent review, rebuild and bind a fresh package, and rerun the failed installed Linux workload before broadening acceptance.

Model the Domain shaped the single terminal state and active-write owner. Fix Root Causes required a retention reproduction before repair. Prove It Works keeps the controlled result separate from the pending installed Linux result.
