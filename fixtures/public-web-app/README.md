# Run the public Workshop board example

Workshop board is a self-authored MIT example for local project tracking. It has a board, client navigation, a scrollable guide library, and a task proposal form. You can complete tasks, reopen them, save a guide, and add a valid proposal to the current browser tab.

The nested web app imports `@workshop/board-data` through its workspace dependency. That package supplies project data, guide titles, server-side validation, and validation feedback. Its source must be built before the app starts. There is no upstream application or copied third-party application code. The generated Git commits identify the exact source used in each comparison.

## Prerequisites

Use Node.js 24, Git, and pnpm 11.9.0 on `PATH`. The recipe checks those versions. The lockfile contains only one local workspace dependency. Installation does not require third-party application packages.

The app binds `127.0.0.1` and the port passed as the first argument. The server uses no accounts, credentials, databases, remote APIs, migrations, or paid providers. No service is replaced or intercepted. Board changes live in one browser tab and reset on a reload. The API validates proposals without persisting them.

## Create exact base and candidate revisions

From the tool source checkout, run the generator with a new or empty destination.

```sh
node scripts/create-public-web-app.mjs --dir /tmp/workshop-board-example
```

The generator copies this public example, commits `fixture-base`, and creates a detached candidate worktree. It changes `packages/board-data/src/feedback.mjs`, commits `fixture-head`, and removes that candidate worktree. The generated repository ends at `fixture-head` with a clean checkout. Existing nonempty destinations are rejected. The source checkout and its Git index are untouched.

The generator also exports `createPublicWebApp(destination)`. It returns the repository root, exact commits, config and scenario paths, feedback source path, expected validation content, checkpoint IDs, viewport, and a repeatable follow-up replacement. It does not install packages or start the app.

## Open the example directly

Run installation and the shared package build at the generated repository root.

```sh
cd /tmp/workshop-board-example
pnpm install --frozen-lockfile
pnpm --filter @workshop/board-data build
node apps/web/server.mjs 4173
```

Open `http://127.0.0.1:4173/board`. The normal routes are `/board` and `/proposals`. Stop the server with Ctrl+C.

## Compare both public flows

Install the candidate tarball in a separate clean tool directory. Use the absolute path to that directory's `show-what-changed` executable as `SWC_BIN`.

```sh
cd /tmp/workshop-board-example
"$SWC_BIN" doctor --json
"$SWC_BIN" plan --base fixture-base --head fixture-head \
	--config show-what-changed.config.json \
	--scenario acceptance/navigation.scenario.json \
	--scenario acceptance/validation.scenario.json --json
"$SWC_BIN" compare --base fixture-base --head fixture-head \
	--config show-what-changed.config.json \
	--scenario acceptance/navigation.scenario.json \
	--scenario acceptance/validation.scenario.json --allow-exec --ci --json
```

The recipe selects `apps/web` explicitly. It installs with `pnpm install --frozen-lockfile` at the workspace root, builds the shared package there, and starts `node server.mjs {port}` from the nested app. Its only declared generated directory is the new build output `packages/board-data/dist`.

The navigation scenario has 11 steps. It opens `/board`, waits for the actual board heading, opens the library, scrolls its inner list, checks the scroll readout, closes the library, and follows the client link to `/proposals`. The drawer and backdrop use 320 ms CSS transitions. The viewport is 390 by 844.

The library's `scroll` handler reads the inner list's actual `scrollTop`. The footer exposes that value in its text and `data-scroll-top` attribute. The required assertion selects `[data-testid="library-scroll-readout"][data-scrolled="true"]`. The shared checkpoint is `library-inner-scroll`. During live acceptance, read `[data-testid="library-list"].scrollTop` independently and record its change from zero. Window scrolling alone cannot update the readout.

The validation scenario has 9 steps. It follows the normal board link to `/proposals`, fills `x` and `broken`, submits the form, and checks the actual alert. The API returns HTTP 422 with both field errors. The shared checkpoint `validation-feedback` retains the changed feedback on both sides. There are no side-specific exclusions.

The base feedback title is "Check the task details". Its message is "Add a longer title and a valid contact email." The candidate title is "Two details need attention". Its message is "Use at least 6 characters for the title and an email such as maker@example.invalid." The candidate also changes the feedback panel's tone from neutral to guided. The validation rules stay the same.

## Repeat a subsequent WORKTREE change

Create another isolated worktree from the generated candidate.

```sh
git -C /tmp/workshop-board-example worktree add --detach \
	/tmp/workshop-board-followup fixture-head
cd /tmp/workshop-board-followup
node --input-type=module -e '
	import { readFileSync, writeFileSync } from "node:fs";
	const path = "packages/board-data/src/feedback.mjs";
	const source = readFileSync(path, "utf8");
	if (!source.includes("Two details need attention")) throw new Error("Unexpected feedback source");
	writeFileSync(path, source.replace("Two details need attention", "Ready for one final check"));
'
"$SWC_BIN" compare --base fixture-head --head WORKTREE \
	--config show-what-changed.config.json \
	--scenario acceptance/navigation.scenario.json \
	--scenario acceptance/validation.scenario.json --allow-exec --ci --json
```

After reviewing the outputs, remove only the disposable follow-up worktree that this procedure created.

```sh
git -C /tmp/workshop-board-example worktree remove --force \
	/tmp/workshop-board-followup
```

## Record final acceptance

Run both scenarios three consecutive times through the exact clean-installed final package. Retain its tarball SHA-256, source commits, recipe and scenario hashes, literal commands, exit codes, media hashes, caller and index preservation, dependency preservation, and owned resource cleanup.

Review source frames and decoded output at normal playback speed. Check intermediate drawer motion, inner scrolling, narrow-view letterboxing, and the changed feedback. Then run the follow-up WORKTREE procedure. This example and source-level checks alone do not establish G19 or universal web-application compatibility.
