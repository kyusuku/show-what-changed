# N0 schema review disposition

The initial independent review reported four boundary defects. Root accepted the concrete runtime defects and added regressions.

- Artifact containment syntax, argv placeholder rules, explicit custom argv, first navigation, Unicode length, held-frame state, and pair metric eligibility now appear in generated structural JSON Schema as well as runtime parsers.
- Capture parsers reject duplicate scenario and step IDs, incorrect scenario outcomes, and an ok frame held from a previous step.
- Timeline parser requires unique scenario title groups, six through sixty frames per step, one through twelve steps per group, cumulative boundaries, complete image entries, and exact total frames. Individual title and step shapes use a discriminated union.
- Public text schemas reject control characters. Scenario input parsing strips terminal controls before validating its human text.
- Phase timings accept the subset of phases actually entered.

JSON Schema describes structural validation. Standard JSON Schema cannot express cumulative arithmetic or uniqueness of one property across arbitrary array entries. The runtime parsers enforce those semantic constraints. Filesystem containment and image hash checks remain mandatory at the consuming module boundary. No consumer may treat structural validation alone as permission to read an artifact path. The supplied documentation examples and added structural invalid cases are checked through both Zod and AJV.

Validation on Node24.22.2 passed strict TypeScript checking, 46 tests in two files, build, and deterministic generated-schema check. This is the N0 contract baseline, not completion of the entire T01 release requirement.
