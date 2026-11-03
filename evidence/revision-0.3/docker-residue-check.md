# Independent Docker residue verifier

The release harness can call `assertNoDockerResidue(runDir, runId)` from `scripts/verify-docker-residue.mjs` after the installed CLI exits. The function returns `{ checkedResources }` only when every recorded identity is absent. Each builder contributes two inspected identities. A missing ledger or a validated empty ledger returns zero.

The verifier independently reads `private/docker.json`. It imports no product runtime or cleanup function and makes only HTTP GET requests. It does not create, delete, reconcile, or rewrite Docker resources or ledger entries. It does not inspect process ownership. The release harness must separately inspect the primary and Docker cleanup process ledgers.

The input follows the current schema-2 ledger in `src/runtime/docker.ts`. Run identity, ownership labels, registered names, builder name relationships, strict object fields, resource limits, unique registration names, and pending creation references are validated before inspection. Recorded IDs must have the Docker ID format for their resource kind. Unsupported schemas, malformed or unreadable records, identity mismatches, and nonempty pending creation intent fail closed.

Only absolute local Unix socket endpoints are accepted. The endpoint comes from the validated ledger. The verifier does not consult environment variables or invoke the Docker CLI. Each resource is inspected by its recorded ID, falling back to its exact registered name when no ID was recorded. Each builder requires independent inspection of its recorded container ID or exact container name and its exact volume name. Every URL path component is encoded.

Only a complete HTTP 404 response proves absence. HTTP 200 fails with `DOCKER_RESIDUE_FOUND`. Other statuses, unavailable daemons, incomplete responses, oversized bodies, and deadlines fail with fixed error codes. Errors and successful results do not contain daemon response text, endpoint values, resource names, run directories, or environment values.

Bounds are 1 MiB for the regular ledger file, one second for the file read, 64 KiB per response body, one second per request, and five seconds for the overall check. Ledger files and directory ancestors must be canonical and cannot be symlinks. File identity and metadata are rechecked after the read.

Verification on 2026-11-03 used Node 24.22.2 and Vitest 5.0.5. The targeted command was `npm exec -- vitest run test/unit/docker-residue-check.test.mjs --maxWorkers=1`.

```text
Test Files  1 passed (1)
Tests       13 passed (13)
Duration    2.32s
```

The first sandboxed run could not bind a temporary Unix socket and failed with `EPERM`. The same local-only suite passed outside the sandbox. The tests use a fake HTTP API on a temporary Unix socket. They verify missing and empty ledgers, exact GET identities, ID and name fallback, encoded image IDs and names, unchanged ledger bytes, existing resources, a leftover builder volume, unresolved creation intent, unavailable daemons, unexpected status, header and body deadlines, oversized and incomplete bodies, malformed records, run and ownership mismatches, unsupported endpoints, and unsafe file shapes.

`node --check scripts/verify-docker-residue.mjs` and the scoped `git diff --check` also passed. This is fake API proof of the verification helper. It does not prove that an installed CLI run cleaned real Docker resources. Real Docker acceptance and release-harness integration remain separate checks.

Model the Domain shaped the validated ledger-to-inspection-path mapping. Prove It Works shaped the exact request assertions and the distinction between fake API evidence and real Docker acceptance.
