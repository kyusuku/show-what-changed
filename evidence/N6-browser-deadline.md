# Browser cleanup at the global deadline

The first coherent isolated Linux full run passed 171 unit tests and 77 of 78 integration tests. The recorder's overall-deadline case preserved exit 10 but reported a context cleanup failure. This was a release-blocking lifecycle defect, not an OOM failure or an accepted flaky test.

The Linux owner reproduced it in the original focused case and instrumented a disposable copy. Both context-close calls started before the supervisor sent SIGTERM to Chromium. Playwright then rejected both close requests with `Target.disposeBrowserContext` errors while its connection still appeared live. Context-close and browser-disconnected events arrived a millisecond later. The trace and environment records are in [Linux diagnosis](Linux-diagnosis.md) and `/private/tmp/swc-linux-interim-06`.

The supervisor had assigned the adopted Chromium process an independent timer at the same deadline as its owning run. That timer raced the run's intended context, browser, then process cleanup order. The fix gives spawned commands their existing independent timers and lets the adopted browser follow the run's bounded cleanup. The existing `anchored` distinction expresses those two ownership paths. Explicit timeouts remain active even for a spawned command whose purpose is `browser`.

The new real-browser lifecycle regression waits 200 milliseconds in a context disposer after deadline cancellation. It asserts that Chromium remains connected until context cleanup finishes, then verifies browser disconnection and the absence of every owned process group. It failed before the fix on macOS because Chromium had already disconnected. The regression does not swallow close errors or relax cleanup requirements.

The initial correction passed 57 macOS recorder, lifecycle and runtime tests, plus typecheck. Independent review narrowed its guard from purpose to ownership, preserving the full spawn contract. Both spawned encode and browser timeout regressions then passed. The final source SHA-256 is `d8ed0dc04399b9cedf375192dd41d4dcc392bdc843c315768877acd5c1224953` for `src/runtime/supervisor.ts`.

The final guard independently passed Linux typecheck and four focused cases. They cover the original recorder deadline, context-before-browser ordering, and explicit encode and spawned-browser timeouts. Process inspection found no owned browser or command children afterward, and all OOM and limit counters remained zero. [The final delta record](/private/tmp/swc-linux-interim-08/input.json) identifies every changed file. The preceding broader diagnostic passed all 43 recorder and lifecycle tests. Those are focused results; the immutable final candidate still requires a complete platform run.

```sh
npm test -- test/integration/lifecycle.test.ts test/integration/recorder.test.ts \
  test/unit/runtime.test.ts --maxWorkers=1 --no-file-parallelism
npm run typecheck
```

Fix Root Causes changed the process timer rather than hiding the Playwright error. Prove It Works required both the failing real-browser ordering test and direct process inspection after the repair.
