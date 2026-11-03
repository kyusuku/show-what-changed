# Persistent motion failure labels

An installed partial comparison produced a valid failure interval shorter than one output frame. Its later held frames displayed BLOCKED without explaining the preceding failure. The blocked badge now includes PRIOR STEP FAILED. Independent review then reproduced a held, unlabeled frame between a step barrier and its later blocked marker, and a failed-track override that hid blocked-step labels.

Two independent design sketches agree that recorded failure is persistent within a scenario. The coordinator selects the marker-based presenter resolver because it also respects the current step's blocked marker during gaps between successive blocked steps. Keep the recorder's event intervals, saved timeline metadata, source selection, output ticks, and total duration unchanged.

Resolve each side at each output tick in this order. The current step's reached blocked marker displays BLOCKED with its prior-failure explanation. Any reached step-failure or track-failure marker otherwise displays FAILED. Before a terminal marker, preserve active waiting, expected-absence, and exclusion annotations. With no applicable state, display no badge. Never infer that an event has happened from its eventual checkpoint result.

Keep the resolver private to the presenter and bounded by the existing scenario step and annotation limits. No new schema, capture writer, cache, or public interface is needed. A failure in one scenario or side does not carry into another. Tests must exercise the actual output ticks around both boundaries, track-only failure, ordinary annotations, and unchanged selected images and duration.

Both reviewers used approved GPT-family models at xhigh effort. There is no configured cross-family judge. Model the Domain changed failure from a transient annotation assumption into a recorded persistent fact. Laziness Protocol kept the repair in one presenter helper. Installed rendering and normal-speed visual acceptance remain pending.
