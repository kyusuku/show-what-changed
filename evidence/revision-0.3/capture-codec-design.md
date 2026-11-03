# Capture codec design decision

The measured capture sanitizer delays acknowledgements at the default viewport. Reusing the general PNG decoder inflates twice and performs full-image conversion and output packing. Removing validation alone would accept excess inflated data. The selected implementation keeps the existing motion thresholds, worker ownership, and raw-memory reservations.

Two independent sketches were compared. Both favored a small capture-only codec over dependency-private adapters. The selected base retains unfiltered scanlines and explicitly consumes its owned source buffer. It compacts validated IDAT payloads in place, inflates once with exact bounds and input consumption checks, reconstructs all rows, applies and verifies masks, then directly deflates those rows. Ordinary RGB remains RGB; RGB transparency expands only when required. General composition retains its broader existing decoder.

| Criterion | Consuming scanline design | Immutable RGBA design |
| --- | --- | --- |
| Fail-closed pixel and PNG behavior | Complete boundary and independent differential tests required | Same required pixel checks |
| Existing memory envelope | In-place IDAT compaction avoids a third encoded buffer; bounded encoder formula is testable | Extra IDAT allocation remains unresolved for padded compressed input |
| Measured work removed | Removes duplicate inflation, ordinary RGB expansion, RGBA bitmap conversion, and row packing | Removes duplicate inflation and output packing but always expands RGB |
| Maintenance and interface | Existing one-call API with explicit consumption contract; private codec helpers | Conventional RGBA representation but extra memory and conversion work |
| Verification path | Synthetic filters/transparency/framing, backing-allocation checks, existing ownership tests, installed motion | Similar correctness suite plus unresolved allocation redesign |

The immutable design's row-order warning is retained. Every row must be reconstructed before masking, because Up, Average, and Paeth can depend on prior unmasked pixels. Both candidates preserve alpha and require masks to be opaque after transparency handling. The selected design preserves the existing fault-code and class identity through the image boundary. Every caller must relinquish raw contents explicitly; no hidden copying adapter is added.

For the selected output cap `C <= 5P + 256`, retained rows, native output chunks, and final PNG assembly are conservatively bounded by `14P + H + 33,354` payload bytes, below `16P` at supported capture dimensions. This corrects the sketch's one-byte omission for the inflater's backing allocation. This is a live payload-buffer bound, not a whole-process RSS claim. Native zlib workspace and allocator-retained unreachable buffers are outside this claim.

The configured cross-family judge pool is empty. Root compared both complete sketches and selected the consuming design; no cross-family review is claimed. Independent review and same-surface installed motion verification remain pending. No speedup is accepted from design or pure timing alone.

## Implementation and allocation evidence

The source implementation uses a constant-size metadata record, a three-state IDAT sequence check, and private RGB or RGBA scanlines. It checks the complete PNG, including every ancillary CRC, before compaction. The native inflater runs once with an exact decoded-length cap and complete compressed-input consumption. All rows are reconstructed before masks. RGB transparency alone triggers expansion, and the general composer decoder remains unchanged.

The existing source and checkpoint callers already abandon raw contents after submission. The worker owns a transferred view, the in-process fallback passes that owned buffer directly, and `MotionRecorder` clears its source reference immediately after submission. `FrameSanitizer.sanitize` now states consumption explicitly. Two existing Worker-test assumptions were updated to follow this contract. Raw release callbacks, worker joining, queue bounds, reservation formulas, and ACK order did not change.

The bounded synthetic probe at `/private/tmp/swc-r4-capture-codec-allocation.mjs` records eighteen cases in `/private/tmp/swc-r4-capture-codec-allocation.json`. It ran on Node 24.22.2, Darwin arm64, at 320 by 240, 1280 by 800, and 1920 by 1080. Every size covers RGB, RGBA, and RGB with transparency, both unmasked and fully masked. It measured native backing stores through the public zlib operations with the exact codec options, then checked the actual sanitizer result and existing transferable reply copy. No global monkeypatch, private dependency import, browser input, or persisted PNG was used.

The inflater returned one backing buffer of `F + 1` bytes. Expanded RGBA rows and the final PNG use exact unpooled allocations. Native deflate retains 32 KiB chunks and, for multiple chunks, a concatenation of exactly `C` bytes. Inspection of this Node version's synchronous zlib implementation confirms that output beyond the cap throws before concatenation. Its chunk loop can retain at most `C + Q` backing bytes, where `Q = 32768`, while concatenation adds `C`. The encoder's full retained-payload bound is therefore `F4 + 1 + 2C + Q + 73`. Source bytes remain in the existing encoded allowance, because compaction creates no encoded-size backing allocation. The RGB-to-RGBA expansion helper returns before encoding, so the source RGB rows are no longer reachable at that stage.

At the smallest, default, and largest tested pixel counts, the conservative cap-based payload bounds are 1,108,794, 14,370,154, and 29,064,834 bytes. Their unchanged `16P` allowances are 1,228,800, 16,384,000, and 33,177,600 bytes. The worst formula also fits every admitted geometry: `P >= 76800` and `H <= 1200` imply `2P - H - 33354 > 0`. The native output cap makes this bound enforceable on failures as well as successful inputs. A focused test supplies a PNG below the encoded input limit whose decoded rows fit the decoded limit but whose re-encoding exceeds the encoded output limit; sanitation rejects it.

This establishes backing sizes and scoped payload lifetimes on the current runtime. It does not measure whole-process RSS, native zlib workspaces, heap objects, allocator retention, or reclamation timing. Linux Node 24 and the final installed candidate remain separate verification gates.
