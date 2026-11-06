# Configure your web app

Save `show-what-changed.config.json` at your application's Git root. Configure each repository once, then reuse the recipe for later comparisons.

The recipe tells the tool how to prepare and start the app. Choose a local page that works with synthetic or disposable data. Install the application's runtime and package manager separately from the tool.

## Ask your coding agent to configure the app

Open the app repository in your coding agent and paste the [setup prompt in the README](../README.md#configure-your-app-once). The agent inspects your repository and creates the recipe. You do not need to choose a package-manager template first.

The prompt permits one local comparison with disposable test data. It asks the agent to stop for required credentials or services that it cannot discover. Review the resulting configuration and video before using them for other scenarios.

The examples below are the manual alternative and a reference for reviewing generated configuration.

## Use a pnpm and Next.js workspace

This example assumes a committed `pnpm-lock.yaml` at the Git root and a Next.js app in `apps/web`. Run the commands with the pnpm version declared by your repository.

```json
{
	"schemaVersion": 2,
	"appDir": "apps/web",
	"execution": {
		"setup": [
			{"cwd": ".", "argv": ["pnpm", "install", "--frozen-lockfile"], "timeoutMs": 600000}
		],
		"start": {
			"kind": "process",
			"argv": ["pnpm", "exec", "next", "dev", "--hostname", "127.0.0.1", "--port", "{port}"]
		},
		"ready": {"path": "/", "statuses": [200], "timeoutMs": 300000},
		"state": {"kind": "stateless"}
	}
}
```

The install command runs at the repository root. The start command runs in `apps/web`. For a standalone Next.js app at the Git root, change `appDir` to `"."`.

Use `stateless` only when the captured page does not depend on mutable external state. For a database-backed page, configure [state isolation](../spec.md#4-general-execution-recipe) before running the comparison. A successful HTTP response establishes server readiness. Use an `expectVisible` scenario step when the UI needs more time to load.

## Use a static site

For a repository with HTML files in `public`, use an installed Python 3.

```json
{
	"schemaVersion": 2,
	"execution": {
		"start": {
			"kind": "process",
			"argv": ["python3", "-m", "http.server", "{port}", "--bind", "127.0.0.1", "--directory", "public"]
		},
		"state": {"kind": "stateless"}
	}
}
```

## Adapt another stack

Set `appDir` to the app directory relative to the Git root. Add dependency or build commands to `execution.setup`. Declare each command as an argument array.

Set `execution.start` to a foreground server command that binds to `127.0.0.1` and uses the assigned `{port}`. Each placeholder must occupy an entire argument. Set `execution.ready.path` and accepted statuses to a route that works on both snapshots.

Apps may use npm, pnpm, Python, or another installed runtime. Container recipes are also available. See the [execution recipe contract](../spec.md#4-general-execution-recipe) for services, startup, environment bindings, and generated outputs.

## Pass required environment variables

Untracked, ignored `.env` files are not copied. Tracked files remain source inputs, so keep secrets out of Git. The tool does not pass the whole shell environment to app processes. Add only the required names under `execution.env`.

```json
{
	"APP_ORIGIN": {"template": "{origin}"},
	"TEST_API_KEY": {"fromEnv": "SWC_TEST_API_KEY"}
}
```

This fragment belongs inside `execution.env`. Use your app's real variable names. Set referenced values in your shell before comparing. Keep secrets out of literal values, command arguments, and committed configuration. Use test services when a page needs credentials.

## Run your first comparison

Add `.show-what-changed/` to the app's `.gitignore` to keep local output out of commits. From the Git root, create a plan for a page that exists in both snapshots.

```sh
show-what-changed plan --route / --json
```

This compares `HEAD` with the eligible current working tree by default. To compare two commits instead, use `--base <before-ref> --head <after-ref>`.

Read `.show-what-changed/plan.json`. Check the selected sources, commands, environment names, and state assumptions. Planning does not run application code.

After reviewing the plan, authorize the comparison.

```sh
show-what-changed compare --plan .show-what-changed/plan.json --allow-exec --json
```

The recipe runs in isolated source copies with your account's privileges. A successful result includes a video under `.show-what-changed/runs/<runId>/compare.mp4`. Inspect the video and result status before sharing. Use [the pricing tutorial](quickstart.md) for interaction scenarios and output details.
