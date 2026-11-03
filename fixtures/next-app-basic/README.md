# Synthetic Next App fixture

This is local, disposable test data. The source is the BEFORE revision. Generate a separate two-commit repository from the project root.

```sh
node scripts/create-fixture.mjs
node scripts/create-fixture.mjs --dir /tmp/my-new-fixture
```

The generator prints `repoRoot`, full `baseCommit` and `headCommit`, and lightweight tags `fixture-base` and `fixture-head`. It never initializes Git in this source directory. An existing destination must be empty. Git identity and timestamps are local and fixed. Hooks, signing and global Git configuration are disabled. Repeated generation from identical source produces the same two commits.

Use Node 24.x and npm 11.12.1. Dependencies are pinned to Next 16.4.3 and React/React DOM 19.3.1 with a committed npm lockfile. Install and run inside the generated repository.

```sh
npm ci
npm run dev -- --hostname 127.0.0.1 --port 4310
```

The generated HEAD is AFTER. BEFORE has blue monthly pricing. AFTER has orange copy, a Yearly switch, a Save 20% state, and a taller page. Both revisions expose a Get Pro hover label that stays visible while the pointer remains on the button. `/readiness` uses a delayed ready state, browser Date, two animation frames, a debounced text input and continuous local `/poll` requests. `/failure` returns HTTP 503. `/controls` includes ambiguous, disabled and hidden buttons plus disposable unsupported-event controls. Its page-error button throws intentionally.

The default config masks `[data-testid=synthetic-secret]` on every capture. The token is synthetic and deliberately visible before masking. Never use real credentials in this fixture. Scenario inputs live at `test/fixtures/scenarios` in the parent project. The success scenario permits only the expected missing BEFORE switch. Required missing BEFORE and AFTER scenarios intentionally produce partial comparisons. The navigation-failure scenario tests a first-frame failure.

The app uses JavaScript and JSX so Next does not rewrite a TypeScript config during startup. Webpack is selected for a repeatable local dev path. `agentRules: false` disables Next's startup generation of `AGENTS.md`, preserving source provenance. Next's development indicator is disabled through its documented configuration; compiler and runtime error overlays remain enabled.
