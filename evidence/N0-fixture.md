# N0 synthetic fixture evidence

The goal is a reproducible two-commit Next App fixture for the v0.1 comparison gates. This subtask supplies fixture source, the local-history generator and six schema-valid scenarios. It does not establish recorder, compositor, packaged CLI or release acceptance.

Verified on macOS arm64 with Node `24.22.2`, npm `11.12.1`, Git `2.53.0`, Playwright `1.64.1` and Chromium `156.0.8078.4`. The checked-in fixture pins Next `16.4.3`, React `19.3.1` and React DOM `19.3.1`. The npm lockfile is version 3.

## Outputs and interfaces

- `fixtures/next-app-basic/` contains a JavaScript/JSX App Router app, exact npm pins, lockfile and JSON capture config. No `.git`, `node_modules` or `.next` is checked in.
- `scripts/create-fixture.mjs` exports `createFixture(destination?)`. It returns `{repoRoot, baseCommit, headCommit, baseRef, headRef}`. CLI invocation accepts an optional destination or `--dir destination` and prints that object as JSON.
- The generator creates a unique system temporary directory by default. An explicit destination must be new or empty and must not be a symlink. It rejects reuse of a populated directory.
- Generated repositories use only local identity, fixed author/committer time, disabled hooks/signing, no init template, and disabled global/system Git configuration. Both commits are tagged. Nothing initializes Git inside the checked-in fixture.
- The only revision difference is `app/revision.js`. BEFORE has blue monthly copy and no Yearly switch. AFTER has orange revised copy, the Yearly switch, Save 20% after activation and a taller page.
- Both revisions support retained Get Pro hover, synthetic masking, delayed readiness, fixed browser Date, live animation frames, a debounced input, continuous local polling, same-document navigation and scrolling.
- `/failure` returns HTTP 503. `/controls` supplies ambiguous, hidden and disabled controls plus intentional page-error/dialog/popup/download/file-input triggers.

The default mask is `[data-testid=synthetic-secret]`. All fixture data is synthetic. The `.gitignore` excludes dependencies, Next build output and comparison output.

## Exact history and source proof

Two independent generator calls produced identical full commit IDs.

| Identity | Full Git OID |
| --- | --- |
| `fixture-base` | `30c3da70198a3fbabf627532f75b54fd761f1945` |
| `fixture-head` | `a9fee6837d1f57f4fde087a7a21bb95003f9d96a` |

Both generated histories contain exactly two commits. Their diff names exactly `app/revision.js`. Reusing a populated destination throws the expected error. The fixture source was hashed before and after generation and was unchanged. That digest is SHA-256 over lexically ordered relative paths, NUL separators and file bytes.

```text
source fixture digest
0ddafaabb5b1309660ca6a8bd7134c4f85d6dc686f9d77db28b8f2f72bf73747

fixture package-lock.json
704bbf1b336dac1ef91b9fd3646c70d65c48727e3f427ef6a9808118f3c1f021
```

Generated proof repositories remain available locally.

```text
AFTER <synthetic-fixture-repository>
BEFORE <synthetic-fixture-repository>
```

The BEFORE repository is detached at `fixture-base`. AFTER remains at `fixture-head`. Each received its own `npm ci`. Both had empty `git status --porcelain` after install, startup and browser navigation. Their dependencies and build output remain ignored. The checked-in fixture source also remains unchanged.

## Scenario contracts

All six inputs passed the actual `parseScenario` exported from built `dist/schema/index.js`. The fixture config passed `parseConfig`. This is schema validation only; end-to-end outcome reduction belongs to N2/N5.

| File in `test/fixtures/scenarios/` | Required behavior |
| --- | --- |
| `pricing.scenario.json` | Expected missing BEFORE Yearly switch; AFTER savings assertion; hover, assertion and screenshot retain pointer. |
| `required-before-failure.scenario.json` | Required BEFORE switch failure blocks later BEFORE steps; AFTER proceeds. |
| `required-after-failure.scenario.json` | Legacy button exists only BEFORE; AFTER fails and later AFTER screenshot is blocked. |
| `readiness.scenario.json` | Explicit delayed-ready assertion, fixed Date, live frames, fill/debounce and fragment navigation. |
| `scroll.scenario.json` | Same scroll amount against different document heights. |
| `navigation-failure.scenario.json` | First goto receives 503, so no successful source frame exists before failure. |

The pricing scenario follows spec §7, with an added explicit hover-state assertion. Required failures retain empty `allowMissing` lists. No fixture changes weaken a required failure into expected absence.

## Commands and observed exits

The pinned toolchain path was prepended to PATH for all dependency and browser checks.

```sh
PATH=/private/tmp/swc-toolchain/node_modules/.bin:$PATH node --version
PATH=/private/tmp/swc-toolchain/node_modules/.bin:$PATH npm --version
npm view next version peerDependencies engines --json --fetch-retries=0 --fetch-timeout=10000
npm view react version --json --fetch-retries=0 --fetch-timeout=10000
npm view react-dom version peerDependencies --json --fetch-retries=0 --fetch-timeout=10000
```

Those commands exited 0. Next requires Node `>=20.9.0` and accepts React/React DOM `^19.0.0`; React DOM `19.3.1` requires React `^19.3.1`.

From `fixtures/next-app-basic`, lockfile creation exited 0.

```sh
PATH=/private/tmp/swc-toolchain/node_modules/.bin:$PATH npm install --package-lock-only --ignore-scripts --audit=false --fund=false --fetch-retries=0 --fetch-timeout=30000
```

The inline generator proof imported `createFixture`, compared two fresh histories, asserted two commits, one changed file, clean status, rejected reuse and unchanged source digest. It exited 0 and wrote `/private/tmp/swc-fixture-proof.json`. Its exact bytes are persisted in `evidence/n0-fixture.json`. The absolute repository paths in that observed proof identify the disposable directories used on this host; they are not required checkout locations.

Inside each final generated repository, independent installation exited 0.

```sh
PATH=/private/tmp/swc-toolchain/node_modules/.bin:$PATH npm ci --audit=false --fund=false --fetch-retries=0 --fetch-timeout=30000
```

The two smoke servers used the following exact commands, AFTER first and BEFORE second. They became ready on the assigned loopback ports.

```sh
PATH=/private/tmp/swc-toolchain/node_modules/.bin:$PATH NEXT_TELEMETRY_DISABLED=1 npm run dev -- --hostname 127.0.0.1 --port 4388
PATH=/private/tmp/swc-toolchain/node_modules/.bin:$PATH NEXT_TELEMETRY_DISABLED=1 npm run dev -- --hostname 127.0.0.1 --port 4389
PATH=/private/tmp/swc-toolchain/node_modules/.bin:$PATH node /private/tmp/swc-fixture-smoke.mjs
```

The persisted local browser harness exited 0 and wrote `/private/tmp/swc-fixture-browser-proof.json`. Its exact result bytes are persisted in `evidence/n0-fixture-browser.json`. It observed the expected missing BEFORE switch, a bounded required-control timeout, working AFTER toggle and savings, missing AFTER legacy control, retained hover after screenshot, document heights `1585` and `1900`, 1280×800 screenshots, every secret-region pixel equal to the solid mask, fixed Date, completed real timers/animation frames, debounced result, fragment navigation returning null, HTTP 503, ambiguous/disabled/hidden controls and no unexpected page errors. Final generated source status remained clean.

The same harness is checked in as `scripts/fixture-smoke.mjs`. Only package/proof/output path resolution and optional URL arguments were normalized from the executed temporary harness. Its assertions are unchanged. With both servers running, repeat it as follows. The proof input must contain `first.repoRoot` for AFTER and `second.repoRoot` for BEFORE.

```sh
node scripts/fixture-smoke.mjs evidence/n0-fixture.json /tmp/swc-fixture-recheck http://127.0.0.1:4389 http://127.0.0.1:4388
```

All positional arguments are optional. Defaults use the persisted proof, a portable OS temporary output directory and the two observed loopback URLs. On another host, regenerate fixture repositories and supply the new proof paths rather than relying on this host's recorded temporary directories.

Both smoke-server sessions stopped with exit 0 after Ctrl-C. The following process inspection exited 1 with empty output, confirming no listeners remain on either smoke port.

```sh
/usr/sbin/lsof -nP -iTCP:4388 -iTCP:4389 -sTCP:LISTEN
```

The final fixture screenshots were visually inspected. The AFTER frame visibly contains orange pricing, Save 20%, the hovered Get Pro state and the solid secret mask. This is source-fixture evidence, not a product-produced comparison artifact.

## Artifacts

| Local artifact | SHA-256 |
| --- | --- |
| `evidence/n0-fixture.json` | `9f4f4fddfd4b326d2b05f101d39b2202a3cbc41e998d8376001ba480d691d323` |
| `evidence/n0-fixture-browser.json` | `abd19f8bc46305dfd1eca254f58f9574fde8e0e540985e62c95d1921e0e5a219` |
| `scripts/fixture-smoke.mjs` | `64b38f403dafd7cf9d7283a83abba962de66497924bec08e9c9de95372262b3a` |
| `/private/tmp/swc-fixture-before-masked.png` | `1d1c3c8bca5e1076d4c44f0fd4625f92a1f642e08cbe0c3262581b8f091567bb` |
| `/private/tmp/swc-fixture-after-masked.png` | `400d16a609598647fc609732f8127f29c1774e417c690d48f3166e8ec8d50118` |

## Finding and disposition

The initial startup smoke found an untracked `AGENTS.md` created by Next `16.4.3` under the agent environment. The correct disposition was to set the documented `agentRules: false` in fixture `next.config.mjs`. The final repeat created no source files and both generated repositories remained clean. No ignore rule hides this mutation. The earlier temporary histories are superseded by the exact final identities above.

Primary references were read through Context7. The Next [agentRules documentation](https://github.com/vercel/next.js/blob/canary/docs/01-app/03-api-reference/05-config/01-next-config-js/agentRules.mdx) documents the source-generation switch. The [CLI documentation](https://github.com/vercel/next.js/blob/canary/docs/01-app/03-api-reference/06-cli/next.mdx) documents Webpack, hostname and port flags. The [devIndicators documentation](https://github.com/vercel/next.js/blob/canary/docs/01-app/03-api-reference/05-config/01-next-config-js/devIndicators.mdx) documents disabling the indicator while preserving error reporting.

The Model the Domain principle shaped the single revision-data file and versioned scenario fixtures. The Prove It Works principle shaped the repeated-history assertions, actual browser interactions, mask pixel inspection and clean-source checks. An integrator review and full N2/N5 behavior tests remain required. This worker changed only its assigned fixture, generator, scenario and evidence files and made no project commit.
