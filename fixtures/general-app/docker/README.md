# Generic container compatibility fixture

This public fixture has a BusyBox HTTP application and a separate PostgreSQL container per comparison side. Both images use public immutable digests. The application checks TCP connectivity through the side-local service alias before serving. This proves endpoint connectivity, not database health or semantic data equality.

Set `SWC_FIXTURE_DB_PASSWORD` and `SWC_FIXTURE_LOG_CANARY` to synthetic local-only values before the installed-package comparison. The application does not receive the database password. The log canary is printed without a secret label to exercise output redaction. Node 24 runs the host setup and bootstrap helpers. No dependency installation is needed.

The setup helper records the published app origin and backing-service endpoint in the private side state directory. The container writes its internal port, service alias, and state path there. Bootstrap verifies the distinct host/container values and the unchanged published origin. The selected browser scenario is stateless. PostgreSQL data uses the image-declared disposable volume covered by the runtime's bounded tmpfs handling.

The compatibility harness changes `index.html` from `<h1>Container source</h1>` to `<h1>Updated container source</h1>` between its baseline and head commits. That is the reviewed visible source change. The moving square also gives continuous source motion.

Source preparation and pure recipe validation do not establish installed-package Docker acceptance. Run the final candidate through the coordinated bounded Docker window, inspect actual resource limits and ownership, and require verified exact cleanup. A pending creation outcome remains uncertain even when a temporary inspection returns 404.
