# Confirmed builder recovery

The full Docker development suite reproduced cleanup that removed a confirmed builder container and left its registered volume. Recovery then rejected the remaining volume because it required the pair to be simultaneously present. Raising a timeout does not repair that interrupted state.

Two independent architecture reviewers proposed the same core repair. The coordinator read both proposals and selected the explicit component-presence design. Keep the existing durable container ID and volume creation identity. Inspect container, volume, and private builder definition independently. A matching complete pair can resolve an issued creation intent. An incomplete pending creation remains uncertain and retains its records.

Delete the confirmed container by its full immutable ID with volume deletion disabled. Reinspect a remaining volume against its registered name, local driver, and original creation time before deleting it without force. A volume used by another container must remain in place. Use the existing bounded cleanup deadline, reinspection after an uncertain response, and at most one validated retry. An expired deadline must not issue a new mutation. Never infer ownership from a prefix or a matching name alone.

After both Engine resources are absent, remove only the matching private Buildx definition with the documented metadata-only `--keep-daemon` operation. Validate its contained file, embedded builder name, driver, node, and endpoint. Prove this behavior with the actual installed Buildx version. Recovery must visit definitions even when Engine resources are already absent. Read-only residue inspection must include volumes and definitions. [Docker Buildx removal](https://docs.docker.com/reference/cli/docker/buildx/rm/)

The implementation should keep this policy inside the existing Docker runtime module. It does not need a new ledger version or persistent cleanup stages. The current Engine state supplies progress after an interruption. The fake-daemon matrix must cover all four confirmed presence combinations, pending and inconsistent identities, replacements, lost responses, in-use volumes, metadata errors, deadlines, and repeat cleanup. Follow with one live orphan-volume recovery and unrelated-resource preservation check.

Docker volume deletion uses a name and has no atomic identity precondition tied to the observed creation time. Immediate reinspection detects observed replacements but cannot prevent a hostile Docker administrator from replacing the name between inspection and deletion. Non-forced deletion protects an in-use volume. The implementation and documentation must not claim stronger isolation. [Docker Engine API](https://docs.docker.com/reference/api/engine/version/v1.53/)

The approved panel used gpt-6-astra and gpt-6.1-terra at xhigh effort. No cross-family judge is configured. Model the Domain changed the pair boolean into independent presence. Make Operations Idempotent changed recovery to finish observed partial progress. Attack the Premise ruled out another timeout-only repair. Source implementation, independent review, and live acceptance remain pending.

## Implementation checkpoint

The implementation keeps the existing ledger schema and represents current container, volume, and definition presence independently. The source and focused verification are recorded in [R3 runtime evidence](R3.md#confirmed-builder-recovery-repair). Typechecking and 97 focused tests passed. Independent review and the targeted live orphan-volume test remain pending.

The actual installed Buildx is `v0.33.0-desktop.1`, commit `7f91f038ac14cbf5c4b2a6b76470860814424da1`. Bounded fake Unix-socket checks covered absent, running, and stopped containers. `--keep-daemon` removed only the exact private definition, preserving an unrelated definition. It performed pings and container inspections, with no Engine mutation. The design therefore allows read-only Engine requests during metadata removal. The earlier source inspection of a newer upstream version did not establish this installed binary's request behavior.
