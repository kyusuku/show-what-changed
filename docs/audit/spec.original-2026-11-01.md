> Historical document sanitized for public distribution. Its content is not a byte-for-byte copy of the original development record. It is not current release evidence.

# `show-what-changed` — Technical Specification

**Version:** 0.1 draft · **Date:** 1 Nov 2026 · **Status:** pre-build, private repo
**Owner:** Tampraphon Lorattanasane · **License (planned):** MIT
**Kind:** personal tool, open-sourced once it works. Not a startup or a paid product.

> **One line:** when an AI coding agent finishes a UI change, `show-what-changed` records the same click-through on the old and new versions of the app and gives you one synced, side-by-side **BEFORE | AFTER** video instead of a wall of text.

Conventions used in this doc:
- **[ASSUMPTION]** marks a design guess that hasn't been validated.
- **[GOAL]** marks a performance or quality target. None of these have been measured.
- **[VERIFY]** marks something to check against upstream docs while implementing.
- `SWC` is shorthand for `show-what-changed` in this doc only. The CLI is always typed in full (see open question 1 about a short alias).

---

## 0. Name and availability

Checked on 1 Nov 2026:
- **Package registries:** `show-what-changed` is not taken on npm, PyPI, Homebrew or crates.io.
- **GitHub:** no user, organisation or repository uses the name.
- **Domains:** RDAP has no registration record for `show-what-changed.com` or `show-what-changed.dev`.
- **To do before the public launch:**
  - Reserve the npm name with a placeholder `0.0.0` package.
  - Create the GitHub repo (private) under the owner's account.
  - Optionally buy `show-what-changed.dev`, confirming availability at a registrar first.
- Trademarks weren't checked. The name is a generic description, so it's low risk.

---

## 1. Problem

AI coding agents (Cursor, Claude Code, Codex, GitHub Copilot agent, Cline, Windsurf, etc.) end UI tasks with a long text summary ("I updated the header, adjusted spacing…"). To check UI work, you have to read that, run the app, find the right screen, and remember what it looked like before. Seeing the change is much faster than reading about it.

Existing tools cover only parts of this (see §3):
- Some capture only the "after" state.
- Some output only screenshots or GIFs.
- Some are tied to a single editor or vendor.
- Some write before and after as two separate videos.
- None produces a single **step-synced** side-by-side video that **any** agent can trigger through the CLI or MCP and that works between **any two refs**.

## 2. Goals and non-goals

### 2.1 Goals
1. **G1, one artefact:** produce one side-by-side MP4 with labels (BEFORE on the left, AFTER on the right), plus GIF and PNG fallbacks, for a UI change in a local web app.
2. **G2, agent-agnostic:** usable from any agent through (a) the CLI, (b) an MCP server and (c) an Agent Skill file (`SKILL.md`). There are no editor extensions in v1.
3. **G3, any two refs:**
   - BEFORE defaults to `HEAD`, or the merge-base with the default branch (see open question 2).
   - AFTER defaults to the working tree (uncommitted changes included).
   - Both can be any git ref.
4. **G4, step-synced:** both sides run the same scenario, and the video is aligned **per action step**, not by wall-clock. Each step segment lasts as long as the slower side, and the faster side holds its last frame.
5. **G5, deterministic enough to compare:** frozen time, no animations, the same fonts and seeded randomness, and optional HAR-based network mocks, so the diff shows code changes rather than noise.
6. **G6, state parity:** the same auth (Playwright `storageState`), the same seed and reset hooks, and the same viewport on both sides.
7. **G7, changed-route detection:** map changed files to routes or stories through framework adapters, so the agent doesn't have to guess what to record.
8. **G8, PR-friendly output:** write media and a markdown snippet compatible with `vercel-labs/before-and-after` and with manual `gh` workflows. Nothing is uploaded by default.
9. **G9, local-first and safe:** runs on the developer's machine or in their CI, with no telemetry or cloud service.

### 2.2 Non-goals for v1
- Native mobile apps (iOS and Android), desktop apps (Electron UI is a maybe later), and terminal UIs.
- Visual regression testing as a CI gate. Pixel diffs exist to highlight regions, not to pass or fail builds. That's what Chromatic, Percy and Playwright `toHaveScreenshot` are for.
- Hosting or a web dashboard, and accounts.
- Editor extensions (VS Code, JetBrains). Agents reach the tool through the CLI and MCP.
- Recording arbitrary production sites. The target is a repo you can run locally.
- Fixing the agent's work automatically.
- First-class Windows support. macOS and Linux come first; Windows is best effort (see §16).

---

## 3. Prior art and what we take from each

Every URL below was checked on 1 Nov 2026 (see the verification note at the end of this section). If code is copied rather than just used for ideas, keep the MIT notice in `THIRD_PARTY_NOTICES.md`.

| Project | What it does | What we take | What's missing for us |
|---|---|---|---|
| [bouzidanas/playwright-comparison-gif-maker](https://github.com/bouzidanas/playwright-comparison-gif-maker) ("PR UI Compare"), MIT | VS Code extension. Checks out the base in a git worktree, runs one Playwright scenario on both versions, outputs a side-by-side GIF | The worktree-for-before pattern and the idea of replaying one scenario on both versions | Tied to VS Code, GIF only, can't pick arbitrary refs, not callable by agents |
| [QwertyBit-Ventures/pr-preview](https://github.com/QwertyBit-Ventures/pr-preview), MIT per earlier research (GitHub's licence detection reports "other") | CLI and MCP that plug into Claude Code; records before and after | Shape of the MCP tools, Claude Code integration, CLI ergonomics | Two separate MP4s rather than one synced video, watermark, open-core |
| [juangadm/pre-post](https://github.com/juangadm/pre-post) | Works out which routes changed from the diff and puts before/after screenshots in the PR description | Ideas for detecting changed routes from the diff | Screenshots only, no interaction or video |
| [astuanax/qa-screens](https://github.com/astuanax/qa-screens) | Auth profiles, `storageState` reuse, SSIM comparison | Auth profile design, storing `storageState`, SSIM to spot visually unchanged steps | Not about agents or video |
| [vercel-labs/before-and-after](https://github.com/vercel-labs/before-and-after) | Agent skill that lays out existing before/after media side by side in a PR body | Our output plugs straight into it, so we don't rebuild PR formatting | Doesn't capture "before" itself |
| [microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp) | Playwright browser control over MCP | Accessibility-snapshot locator conventions, so agent-written scenarios match what agents already "see" | General browser control with no before/after |
| [vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser) | Browser automation CLI built for agents | Optional recording backend (§11.6) | Not a comparison tool |
| [crs48/xNet PR #94](https://github.com/crs48/xNet/pull/94) | Real-world example of mapping changed files to routes and recording with Playwright and ffmpeg | Validates the file-to-route heuristics and ffmpeg pipeline | A one-off script, not a reusable tool |
| [Tim Deschryver: "Let your AI agent capture its changes with the Playwright CLI"](https://timdeschryver.dev/blog/let-your-ai-agent-capture-its-changes-with-the-playwright-cli) | Blog post on having agents record their own changes | Skill and prompt wording, plus the "agent records at end of task" workflow | Captures "after" only |

Built-in vendor features (Cursor cloud agents, Devin recordings, Copilot agent screenshots) record the **after** state only, inside their own product. SWC is complementary to them.

**Verification note:** all nine links returned HTTP 200 on 1 Nov 2026. GitHub's API reports these licences:
- **MIT:** PR UI Compare, pre-post and qa-screens.
- **"Other" (`NOASSERTION`, meaning GitHub couldn't classify the licence):** pr-preview and before-and-after.

Read those two `LICENSE` files yourself before copying any code from them **[VERIFY]**. Star counts are tiny except before-and-after (about 418): PR UI Compare 2, pr-preview 2, pre-post 1, qa-screens 0. Last pushes were between Jul and Oct 2026.

---

## 4. User stories

### 4.1 Agent at the end of a task (primary)
> As a developer using Claude Code or Cursor, when the agent finishes a UI change, I want it to call `show-what-changed` and reply with a side-by-side video and a two-line summary, so I can check the change in 10 seconds.

Flow:
1. The agent finishes editing.
2. The Skill tells it to call the MCP tool `swc_plan`, which returns changed routes and draft scenarios.
3. The agent refines the scenario if needed (for example, opening the modal it changed).
4. The agent calls `swc_compare`.
5. The agent links `compare.mp4` and the manifest summary in its reply.

### 4.2 Manual developer
> As a developer, I want `npx show-what-changed` in my repo to compare my uncommitted changes against `HEAD` on the routes I touched, with no config on a standard Next.js app.

```bash
npx show-what-changed                     # working tree vs HEAD, auto routes
npx show-what-changed --base main         # vs merge-base with main
npx show-what-changed --base v1.2 --head v1.3 --route /pricing
```

### 4.3 PR and CI
> As a maintainer, I want a GitHub Action job to run SWC on PRs that touch UI files and attach the video to the PR, so reviewers see the change without checking it out.

- Runs `show-what-changed --base $BASE_SHA --head $HEAD_SHA --ci`, then uploads the artefacts.
- Posting is opt-in: `--pr-comment` uses `gh`, or the files are handed to `vercel-labs/before-and-after`.
- In CI, auth comes from secrets, never from committed files.

### 4.4 Comparing a specific interaction
> As a developer who changed a checkout form, I want to write a five-step scenario once (fill the email, click Continue, see the error) and replay it on both versions.

---

## 5. High-level architecture

```
 CLI ──┐
 MCP ──┼──► Planner ──► Workspace Mgr ──► Server Orchestrator ──► Recorder (lockstep) ──► Composer ──► artifacts + manifest.json
 Skill ┘   diff → routes   worktrees,       2 dev servers,          Playwright | agent-     ffmpeg: step sync,
           → scenarios     install cache    ports, ready checks     browser backend         hstack, labels, diff boxes
```

Modules (one package for the MVP, split later, see §19):
- **`planner`:** reads the git diff, runs framework adapters, and writes `plan.json` with routes and scenarios.
- **`workspace`:** creates and caches git worktrees for non-working-tree refs, installs dependencies, and runs hooks.
- **`orchestrator`:** starts and stops dev servers, assigns ports, runs ready checks, captures logs, and cleans up.
- **`recorder`:** runs the scenarios in lockstep on two browser contexts, captures per-step frames and video segments, and logs timings.
- **`composer`:** aligns segments by step, builds the ffmpeg filter graph, computes pixel-diff boxes, and encodes MP4, GIF and PNG.
- **`mcp`:** stdio MCP server wrapping the core API.
- **`cli`:** argument parsing, terminal UI and exit codes.

---

## 6. CLI

Binary: `show-what-changed`, also run as `npx show-what-changed`. Node ≥ 20 **[ASSUMPTION: Node 20 LTS minimum; revisit with Playwright's supported range]**.

### 6.1 Commands

| Command | Purpose |
|---|---|
| `show-what-changed [compare]` (default) | Plan if needed, then record both sides and compose the video |
| `show-what-changed plan` | Write `plan.json` (changed routes and draft scenarios) without recording. Agents use this to inspect or edit before running `compare` |
| `show-what-changed record --side before\|after` | Record one side only (debugging) |
| `show-what-changed compose <runDir>` | Re-compose the video from existing frames with different layout or format flags, without re-recording |
| `show-what-changed init` | Detect the framework and write `show-what-changed.config.ts`, and add `.show-what-changed/` to `.gitignore` |
| `show-what-changed auth <profile>` | Open a headed browser on the app, let the user log in, and save `storageState` to `.show-what-changed/auth/<profile>.json` (gitignored) |
| `show-what-changed doctor` | Check git, Node, the Playwright browsers, ffmpeg, the config, ports, worktree state and trust status |
| `show-what-changed clean [--all]` | Remove stale worktrees, servers, run directories and caches |
| `show-what-changed mcp` | Start the MCP server on stdio |
| `show-what-changed skill install [--target claude\|cursor\|codex\|generic]` | Copy the Agent Skill file to the right location (§14) |

### 6.2 Main flags for `compare`

| Flag | Default | Meaning |
|---|---|---|
| `--base <ref>` | auto (see open question 2) | BEFORE ref |
| `--head <ref>` | `WORKTREE` (current files, uncommitted included) | AFTER ref. `WORKTREE` is a special value |
| `--route <path>` (repeatable) | auto-detected | Restrict to these routes |
| `--max-routes <n>` | `5` | Cap on auto-detected routes |
| `--scenario <file\|id>` (repeatable) | auto (one visit-and-scroll scenario per route) | Scenario file(s) or IDs from the config |
| `--device <name>` (repeatable) | `desktop` | Viewport preset (`desktop` 1280×800, `mobile` 390×844 with touch) or a Playwright device name |
| `--auth <profile>` | from config | `storageState` profile |
| `--layout <hstack\|vstack\|auto>` | `auto` | Rule below |
| `--format <list>` | `mp4,png` | Any of `mp4`, `gif`, `webm`, `png` (poster), `frames` |
| `--max-width <px>` | `1920` | Width of the combined output |
| `--highlight / --no-highlight` | on | Draw boxes around changed regions |
| `--collapse-unchanged` | off | Shorten visually unchanged steps to 300 ms |
| `--out <dir>` | `.show-what-changed/runs/<timestamp>-<shortsha>` | Output directory |
| `--keep-servers` | off | Leave dev servers running after the run (debugging) |
| `--reuse-before <url>` / `--reuse-after <url>` | none | Skip starting a server and use a URL that's already running |
| `--backend <playwright\|agent-browser>` | `playwright` | Recording backend |
| `--mock <off\|record\|replay>` | `off` | HAR network mocking (§10.1) |
| `--timeout <sec>` | `600` | Overall run timeout |
| `--ci` | auto if `CI=true` | Non-interactive mode: no prompts, plain logs. Untrusted repos fail (§15) |
| `--json` | off | Print the manifest to stdout (for agents) |
| `--yes` | off | Accept the trust prompt for this repo, interactively run only (§15) |
| `--pr-comment` | off | After composing, post or update a PR comment with `gh` (opt-in, §12.3) |
| `-v / --verbose`, `--quiet` | | Logging level |

**Layout rule for `auto`:**
- `hstack` for desktop viewports.
- `hstack` for mobile viewports too, since two phones side by side fit a 16:9 frame.
- `vstack` only for ultra-wide viewports (width > 1.5 × height) where side by side would scale each side below 60%.

### 6.3 Example output (human mode)

Illustrative only, not a measurement:
```
show-what-changed v0.1.0
  base  main@3f2a1c9 (merge-base)   head  working tree (4 files changed)
  routes  /pricing  /settings/profile   (nextjs-app adapter)
  ▸ worktree   reused cache  (lockfile unchanged)
  ▸ servers    before :4310 ready · after :4311 ready
  ▸ record     /pricing 6 steps · /settings/profile 4 steps
  ▸ compose    compare.mp4 (1920×600)
  ✓ .show-what-changed/runs/2026-11-01T2301-3f2a1c9/compare.mp4
    2 routes · 10 steps · 7 steps with visual change · 1 step absent in BEFORE (selector not found)
```

---

## 7. Configuration: `show-what-changed.config.ts`

Optional: zero config must work for the default Next.js and Vite templates. The file is loaded with `jiti` **[ASSUMPTION]**, so TS, ESM and CJS all work. `.js`, `.mjs` and `.json` versions are also accepted.

```ts
import { defineConfig } from 'show-what-changed';

export default defineConfig({
  // ── App ─────────────────────────────────────────────
  framework: 'auto',                 // 'nextjs-app' | 'nextjs-pages' | 'vite-react-router' | 'sveltekit' | 'storybook' | 'custom' | 'auto'
  cwd: '.',                          // app root inside a monorepo, e.g. 'apps/web'
  dev: {
    command: 'pnpm dev --port {port}',   // {port} is substituted; PORT env is also set
    portRange: [4310, 4399],             // two free ports are picked from this range
    ready: { url: '/', status: [200, 399], timeoutSec: 120 }, // or { log: /ready in/i } or { tcp: true }
    env: { NEXT_TELEMETRY_DISABLED: '1' },
    envFiles: ['.env.local'],            // copied (not symlinked) into the BEFORE worktree; never logged
    build: false,                        // true → run build + start (slower, closer to prod, no dev overlays)
  },
  install: {
    command: 'auto',                     // from lockfile: pnpm i --frozen-lockfile | npm ci | yarn --immutable | bun i --frozen-lockfile
    cache: 'lockfile-hash',              // reuse node_modules when the lockfile hash matches; 'none' to always install
  },

  // ── State parity ────────────────────────────────────
  auth: {
    default: 'user',
    profiles: {
      user:  { storageState: '.show-what-changed/auth/user.json' },
      admin: { storageState: '.show-what-changed/auth/admin.json' },
    },
    // optional scripted login, run once per side if storageState is missing or expired
    login: async ({ page, baseURL, profile }) => { /* ... */ },
  },
  hooks: {
    beforeAll:  { command: 'pnpm db:migrate', perSide: true },                // runs in each worktree with SWC_SIDE=before|after, SWC_PORT
    beforeEach: { command: 'pnpm db:reset && pnpm db:seed', perSide: true },  // before each scenario
    afterAll:   { command: 'pnpm db:drop', perSide: true },
  },
  backend: {
    mode: 'shared',                      // 'shared' (both frontends hit one backend/DB) | 'separate'
    sideEnv: {                           // used in 'separate' mode
      before: { DATABASE_URL: 'postgres://localhost/app_swc_before' },
      after:  { DATABASE_URL: 'postgres://localhost/app_swc_after' },
    },
  },
  network: {
    mock: 'off',                         // 'off' | 'record' | 'replay'
    har: '.show-what-changed/har/{scenario}.har',
    mockUrls: ['/api/**'],               // what gets recorded/replayed
    block: ['**/analytics/**', 'https://www.googletagmanager.com/**'],
  },

  // ── Determinism ─────────────────────────────────────
  determinism: {
    freezeTime: '2026-01-15T10:00:00Z',  // Playwright clock API; false to disable
    disableAnimations: true,
    randomSeed: 42,
    hideSelectors: ['[data-testid="live-clock"]', '.intercom-launcher'],
    waitForFonts: true,
    locale: 'en-US', timezoneId: 'UTC', colorScheme: 'light',
  },

  // ── Capture ─────────────────────────────────────────
  devices: ['desktop'],                  // or ['desktop', 'mobile'] or Playwright device names
  routes: {
    include: [],                         // always record these
    exclude: ['/api/**'],
    params: { '/blog/[slug]': ['/blog/hello-world'], '/u/[id]': ['/u/1'] }, // samples for dynamic routes
    map: {},                             // manual file-glob → routes, e.g. { 'src/components/Header/**': ['/', '/about'] }
  },
  scenarios: './show-what-changed/scenarios', // directory of *.scenario.(ts|json|yaml)
  capture: { mode: 'frames', cursor: true }, // 'frames' | 'video'
  output: {
    dir: '.show-what-changed/runs',
    formats: ['mp4', 'png'],
    maxWidth: 1920, fps: 30,
    stepHoldMs: 600,                     // minimum time each step stays on screen
    labels: { before: 'BEFORE · {ref}', after: 'AFTER · {ref}' },
    highlight: { enabled: true, threshold: 0.1, minAreaPx: 64 },
  },
});
```

Resolution order: CLI flags, then MCP arguments, then the config file, then adapter defaults, then built-in defaults.

---

## 8. Scenarios

### 8.1 Format

Scenarios are data (JSON or YAML) by default, so agents can write them reliably and the same file runs identically on both sides. TS scenarios exist as an escape hatch.

```yaml
# show-what-changed/scenarios/pricing-toggle.scenario.yaml
id: pricing-toggle
title: Toggle yearly pricing
route: /pricing
device: desktop            # optional, overrides the default
auth: none                 # profile name | none
steps:
  - goto: /pricing
  - waitFor: { role: heading, name: Pricing }
  - screenshot: Initial view           # named keyframe (also a sync point)
  - click: { role: switch, name: /yearly/i }
    note: Switch to yearly billing
    optional: true                     # new in AFTER; missing on BEFORE is fine, recorded as "absent"
  - expectVisible: { text: /save 20%/i }
    side: after
  - scrollTo: { role: region, name: Plans }
  - hover: { role: button, name: Get Pro }
  - screenshot: Hover on CTA
```

**Step types (v1):**
- **Navigation:** `goto`, `waitForUrl`.
- **Actions:** `click`, `dblclick`, `hover`, `fill`, `type`, `press`, `select`, `check`, `uncheck`.
- **Scrolling:** `scrollTo`, `scrollBy`.
- **Waiting:** `waitFor`, plus `waitMs` (discouraged, capped at 3000).
- **Checks and keyframes:** `expectVisible`, `screenshot` (named keyframe).
- **Other:** `setViewport`, and `evaluate` (TS scenarios only).

**Locators**, in preference order. This mirrors Playwright's recommended `getByRole`-first approach and the accessibility snapshot that agents see through playwright-mcp:
1. `{ role, name }`, which maps to `getByRole(role, { name, exact? })`. `name` can be a string or `/regex/flags`.
2. `{ label }`, `{ placeholder }`, `{ text }`, `{ altText }`, `{ title }`.
3. `{ testId }`, which maps to `getByTestId`.
4. `{ css }` or `{ xpath }`. These are allowed, but the linter warns because they break most often between BEFORE and AFTER.
5. Modifiers: `nth`, `within: <locator>`, `hasText`.

**Per-step options:**
- `optional`
- `timeoutMs` (default 5000)
- `note` (caption text)
- `side: before|after|both` (for example, dismissing a banner that only exists on one side)
- `fallbacks: [locator, ...]` (§11.5)

**Settle rule (implicit after each action):** wait for network idle (1.5 s cap), then `document.fonts.ready`, then two `requestAnimationFrame` calls. Configurable.

### 8.2 Auto-generated default scenario

When no scenario covers a changed route, the planner writes:
```yaml
steps:
  - goto: <route>
  - screenshot: Top of page
  - scrollBy: { pages: 1 }   # repeated until the bottom, max 5 screens, screenshot after each
```
This covers static visual changes. Interaction changes need a scenario written by the agent or a person.

### 8.3 How the agent generates scenarios from the diff

`plan` (and the `swc_plan` MCP tool) returns:
1. **Changed files and routes:** the changed files and changed routes (§9), with the reason for each mapping.
2. **Snapshots:** an accessibility snapshot of each route on the AFTER side, in playwright-mcp's YAML-like format, trimmed to 8 KB per route. This needs only the AFTER server, which the plan starts lazily and keeps for the compare (`planId`).
3. **Default scenarios.**
4. **Diff hints:** added or removed text strings, and new `aria-label`, `role` and `data-testid` values in changed JSX/TSX/Svelte hunks. These come from a regex pass at first, with an AST pass later **[ASSUMPTION]**.

The Skill (§14) tells the agent to:
1. Pick 1–3 user-visible interactions it changed.
2. Write steps using **role and name from the snapshot**.
3. Use elements that exist on **both** sides (for example, a button whose label didn't change) as navigation anchors. Mark steps that only exist in the new UI as `optional: true` or `side: after`.
4. Keep each scenario to 12 steps or fewer and 30 seconds or less.
5. Call `swc_validate_scenario` (a dry run on AFTER only) before `swc_compare`.

Agent-written scenarios are saved to `.show-what-changed/scenarios/agent/` (gitignored). `--save-scenarios` copies them into the committed `show-what-changed/scenarios/` so they can be reused.

### 8.4 Linting
`show-what-changed plan --lint` flags:
- CSS or XPath locators;
- `waitMs` used where `waitFor` would do;
- more than 12 steps;
- required (non-optional) steps whose locator text appears only in the diff's added lines, which will almost certainly fail on BEFORE.

---

## 9. Changed-route detection

### 9.1 Pipeline
1. **List changed files:** run `git diff --name-status <base>...<head>`. For `WORKTREE`, also include untracked files from `git ls-files --others --exclude-standard`.
2. **Filter:** keep UI-relevant files using the adapter's globs.
3. **Map files to routes:**
   - **Direct:** a page or route file maps to its route.
   - **Indirect:** a component or style file maps to the routes that import it. This uses a reverse import graph built with `es-module-lexer` and tsconfig path aliases, capped at depth 6.
   - **Global:** layouts, global CSS, Tailwind config and theme files map to `routes.include`, or to `/` if that's empty.
4. **Rank:** direct matches first, then by number of changed importers, then the shallowest URL. Capped by `--max-routes`.
5. **Resolve dynamic segments:** use `routes.params`. If no sample exists, the route is skipped with the reason "needs param sample", and the agent is told to supply one.

Every mapping is recorded in the manifest as `{ route, reason: 'direct'|'import'|'global', via: [files] }` for debugging.

### 9.2 Adapters (v1)

| Adapter | Detection | Route source | Notes |
|---|---|---|---|
| `nextjs-app` | `next` in deps and `app/` or `src/app/` exists | `app/**/page.{tsx,jsx,ts,js,mdx}`. `(group)` segments are stripped, `[param]` and `[...slug]` are dynamic, and `@slot` and `_private` are ignored. `layout`, `template`, `loading` and `error` files map to all descendant pages | **MVP adapter** |
| `nextjs-pages` | `next` in deps and `pages/` exists | `pages/**/*.{tsx,jsx}` minus `api/`. `_app` and `_document` count as global | v0.5 |
| `vite-react-router` | `vite` and `react-router(-dom)` in deps | Best-effort AST parse of `createBrowserRouter([...])` and `<Route path>`. React Router v7 framework mode uses `app/routes.ts` or `app/routes/` file conventions | If it can't tell, it reports unknown routes, and `routes.include`/`routes.map` or the agent supplies them |
| `sveltekit` | `@sveltejs/kit` in deps | `src/routes/**/+page.svelte`. `+layout.svelte` maps to descendants, and `(group)` and `[param]` are handled | v0.6+ |
| `storybook` | `.storybook/` exists | Changed component maps to the `*.stories.*` files that import it, then to CSF story IDs and the URL `/iframe.html?id=<id>&viewMode=story`. Default dev command: `storybook dev -p {port} --ci` | Best for design systems and isolated components |
| `custom` | config | `routes.include` and `routes.map` only | Always available |

```ts
interface FrameworkAdapter {
  id: string;
  detect(root: string, pkg: PackageJson): Promise<boolean>;
  defaults(root: string): Partial<Config>;             // dev command, ready check, globs
  listRoutes(root: string): Promise<RouteEntry[]>;     // file → route pattern
  classify(file: string): 'route' | 'layout' | 'global' | 'component' | 'ignore';
}
```

---

## 10. Determinism

Both sides use the **same** browser build, context options and init scripts.

| Concern | Mechanism |
|---|---|
| Time | Playwright clock API (`page.clock.install({ time })` before navigation; pause or advance around steps as needed) **[VERIFY the exact API for the pinned Playwright version]**. `timezoneId` and `locale` are fixed on the context |
| Animations | `reducedMotion: 'reduce'` on the context, plus an injected stylesheet that sets animation and transition durations and delays to 0, `scroll-behavior: auto` and `caret-color: transparent`. Scenarios can opt out with `animations: allow` when the change *is* an animation |
| Randomness | Init script that replaces `Math.random` with a seeded PRNG (mulberry32, `randomSeed`) and makes `crypto.randomUUID` deterministic. Documented limitation: server-side randomness isn't affected |
| Fonts | Wait for `document.fonts.ready`. Both sides use the same machine and browser, so system fonts match. In CI, use the official Playwright Docker image. Optional `fontOverrides` serves local font files instead of remote ones |
| Dynamic noise | `hideSelectors` get `visibility:hidden` (not `display:none`, which would shift layout). Opt-in preset for common chat widgets and cookie banners |
| Dev overlays | The Next.js dev indicator and error overlay and the Vite error overlay are hidden by an injected CSS preset. `build: true` avoids them entirely |
| Network | Analytics and tracking blocked by default (`network.block`), plus HAR mocking (§10.1) |
| Pointer | The mouse is parked at (0,0) before keyframes unless the step is a hover |
| Viewport and DPR | Fixed per device. `deviceScaleFactor: 1` for video. PNG keyframes optionally at 2× with `--hidpi` |

### 10.1 HAR network mocking
- **`--mock record`:** run the AFTER side once and record requests matching `network.mockUrls` to the HAR file, using `routeFromHAR(..., { update: true })`.
- **`--mock replay`:** both sides answer those requests from the HAR. By default unmatched requests fall back to the network (`notFound: 'fallback'`); `--mock-strict` aborts them instead.
- **Use case:** frontend-only changes where both sides should see identical data without a database.
- **Caveat (documented):** if the change *alters the API contract*, replaying an AFTER HAR on BEFORE can break BEFORE. The tool warns when more than 20% of BEFORE's matching requests miss the HAR **[ASSUMPTION: threshold]**.

---

## 11. Orchestration, recording and composition

### 11.1 Workspace manager
- **AFTER = `WORKTREE`:** use the repo in place, with no checkout.
- **Any ref:** `git worktree add --detach <cache>/wt/<sha12> <sha>`.
  - Cache directory: `${XDG_CACHE_HOME:-~/.cache}/show-what-changed/<repoHash>/`.
  - Worktrees are reused when the SHA matches. The cache keeps at most 4, evicting the least recently used.
- **Dependencies:**
  1. Hash each side's lockfile (`pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`, `bun.lock(b)`) together with the app's `package.json`.
  2. **Same hash as the main checkout:** symlink the main `node_modules` into the worktree. If the framework rejects symlinks, fall back to a real install. Next.js/Turbopack may need `outputFileTracingRoot` or `turbopack.root` adjusted **[VERIFY per framework]**.
  3. **Different hash:** run a frozen install with the detected package manager. pnpm's shared store keeps this fairly cheap; npm uses `npm ci --prefer-offline`.
  4. The result is cached per lockfile hash.
- **Env files:** `dev.envFiles` are **copied** into the BEFORE worktree with mode 0600 and deleted on cleanup. Their contents never reach logs or the manifest.
- **Monorepos:** `cwd` points at the app. Installs run at the workspace root, detected through `pnpm-workspace.yaml` or the `workspaces` field.
- **Build caches** (`.next`, `.svelte-kit`, `node_modules/.vite`) are kept per worktree, so later runs start faster.

### 11.2 Server orchestrator
- **Ports:** picks two free ports from `portRange`, checking each by binding.
- **Start:** spawns `dev.command` with `{port}` substituted. Env:
  - `PORT`, `SWC_SIDE` and `SWC_RUN_ID`;
  - `BROWSER=none`, so the dev server doesn't open a browser;
  - `NEXT_TELEMETRY_DISABLED=1`.
  
  Binds to `127.0.0.1` where the framework allows it.
- **Ready check:**
  - Polls the URL every 500 ms until the status is acceptable, or matches a log regex, or connects over TCP. Default timeout is 120 s per server.
  - Once ready, it sends one warm-up GET to each target route, so dev-mode compile time isn't recorded.
- **Hooks:**
  - `beforeAll` runs per side after install and before the server starts (for example, migrations).
  - `beforeEach` runs before each scenario, on both sides **sequentially** (BEFORE then AFTER), to avoid database races in `shared` mode.
  - A hook failure aborts the run with exit 5.
- **Backend modes:**
  - **`shared`** (default): simple, but migrations in AFTER can break BEFORE. The tool warns when the diff touches `migrations/`, `prisma/schema.prisma`, `drizzle/` or `supabase/migrations/`.
  - **`separate`:** per-side `sideEnv` (for example, two databases). The user's hooks create and seed each one.
- **Logs:** stdout and stderr go to `<runDir>/logs/{before,after}.server.log`, with secrets redacted (§15).
- **Cleanup:**
  - Kills the whole process group on success, failure, SIGINT and SIGTERM (spawned `detached`, then `process.kill(-pid)` on POSIX).
  - A PID file at `<cache>/servers.json` lets `clean` reap orphans after a crash.
  - Worktrees stay in the cache. Temporary env files are always deleted.
- **Reusing servers:** `--reuse-before/--reuse-after <url>` skips all of the above for that side.

### 11.3 Recorder (lockstep)
- **Browser setup:** one Chromium instance with two **browser contexts**. Both get identical viewport, DPR, locale, timezone, colour scheme, reduced motion, `storageState` and init scripts.
- **Lockstep loop** per scenario:
  ```
  for step in scenario.steps:
      resolve locator on BEFORE and AFTER in parallel (with fallbacks, §11.5)
      perform the action on both sides in parallel
      settle both sides (§8.1 settle rule)
      capture a keyframe PNG on both sides
      record per-side timings: actionStart, settled, status, resolvedBy
  ```
- **Capture modes** (`capture.mode`):
  1. **`frames`** (default and MVP): a keyframe after each step, plus a short burst of frames during the action (up to 10 frames over 1 s or less, via CDP `Page.startScreencast` or repeated screenshots). The composer builds video from these.
     - Pros: deterministic, independent of wall-clock time, and step alignment is exact.
     - Cons: less smooth, though animations are disabled anyway.
     - Scroll steps capture 6 intermediate frames so scrolling reads visually.
  2. **`video`** (opt-in, v0.6+): Playwright `recordVideo` per context. Step timestamps from the loop are used to cut segments with ffmpeg `trim`. Smoother, but timing needs care.
- **Cursor:** an injected fake cursor (SVG) glides to the target before click and hover and shows a ripple on click, so viewers see what was pressed. Disable with `--no-cursor`.

### 11.4 Composer (sync and ffmpeg)

**Step alignment:**
- Each step `i` lasts `L_i = max(len_before_i, len_after_i, stepHoldMs)` on both sides.
- The shorter side is padded by freezing its last frame (`tpad=stop_mode=clone:stop_duration=…`).
- If a step is absent or skipped on one side, that side holds its previous frame, dimmed, with a caption (§11.5).

**Per-side clip (`frames` mode):**
1. Write an ffconcat list with a per-image `duration` for each side.
2. Encode it to a constant-30-fps intermediate clip per side.
3. Stack the two clips.

**Reference filter graph:**
```
ffmpeg -i before.mp4 -i after.mp4 -filter_complex "
 [0:v]scale=W:-2:flags=lanczos,pad=iw+4:ih+48:0:48:color=#111111,
      drawtext=fontfile=FONT:text='BEFORE · main@3f2a1c9':x=16:y=14:fontsize=20:fontcolor=#ff9b9b[b];
 [1:v]scale=W:-2:flags=lanczos,pad=iw:ih+48:0:48:color=#111111,
      drawtext=fontfile=FONT:text='AFTER · working tree':x=16:y=14:fontsize=20:fontcolor=#9bffb0[a];
 [b][a]hstack=inputs=2,pad=iw:ih+40:0:0:color=#111111,
      drawtext=fontfile=FONT:text='click Get Pro':x=16:y=h-30:fontsize=18:fontcolor=white:enable='between(t,4.2,5.4)',
      drawtext=... (one per step) [v]"
 -map "[v]" -c:v libx264 -pix_fmt yuv420p -crf 23 -preset medium -movflags +faststart compare.mp4
```
- **Sizing:**
  - Each side is `W = floor((maxWidth - 4) / 2)`, rounded to an even number.
  - A 4 px divider is added through `pad` on the left input.
  - When the two sides differ in height (rare, since the viewports are identical), the shorter one is padded.
- **Captions:** each step's `note`, or an auto description such as "click 'Get Pro'", is drawn with `drawtext` and an `enable='between(t,start,end)'` window. ASS subtitles via `subtitles=` are an alternative **[VERIFY libass in ffmpeg-static builds]**.
- **Font:** bundle Inter (OFL) and pass it through `fontfile=` so no system font lookup is needed.
- **Binary:** `ffmpeg-static` by default. `SWC_FFMPEG` or a system ffmpeg is preferred when present. `doctor` checks that `drawtext` (libfreetype) is available.
- **Multiple scenarios:** each scenario gets its own `compare.mp4`. The top-level `compare.mp4` concatenates them with a 1 s title card each ("/pricing · Toggle yearly pricing · desktop").

**Changed-region highlighting:**
1. **Diff:** for each step, run `pixelmatch` on the BEFORE and AFTER keyframes at the same size (viewport crop).
2. **Boxes:**
   - Dilate the diff mask by 4 px, then find connected components.
   - Merge them into at most 8 boxes and drop any smaller than `minAreaPx`.
3. **Drawing:** boxes appear on the **AFTER** side only, during that step's segment, starting 300 ms in so the clean frame shows first (`drawbox=x:y:w:h:color=#ffcc00@0.9:t=3:enable=...`).
4. **Per-step metrics:**
   - `changeRatio` (the fraction of differing pixels), plus SSIM optionally, as in qa-screens.
   - Steps with `changeRatio < 0.001` are `unchanged`.
   - With `--collapse-unchanged`, those steps last only 300 ms.
5. **Layout shifts:** a shift makes everything below it differ. When `changeRatio > 0.5`, boxes are suppressed and the caption says "layout changed broadly" **[ASSUMPTION: heuristic; a DOM-based diff is open question 8]**.

**Output formats:**

| Format | Encoding | Size goal |
|---|---|---|
| MP4 (primary) | H.264, yuv420p, CRF 23, 30 fps, faststart, at most 1920 px wide | **[GOAL]** ≤ 10 MB for 30 s, so it fits GitHub upload limits **[VERIFY current limits]** |
| GIF | Two-pass palette (`palettegen=stats_mode=diff`, `paletteuse=dither=bayer:bayer_scale=3`), 12 fps, at most 960 px wide | **[GOAL]** ≤ 8 MB. If it's larger, retry at 10 fps and 800 px, then warn |
| WebM | VP9, CRF 33 | optional |
| PNG poster | Side-by-side keyframe of the step with the highest `changeRatio`, with boxes | ≤ 1 MB |
| PNG frames | `frames/NN-<slug>-{before,after,diff}.png` | for PR tools and debugging |

### 11.5 Selector breakage on the BEFORE side
The agent tested its scenario against AFTER, so breakage usually happens on BEFORE: the old UI may lack the new button or use different text. For each step and side, resolution goes like this:
1. **Primary locator:** 5 s timeout. On BEFORE it drops to 2 s after the run's first miss, so runs don't crawl.
2. **The scenario's `fallbacks[]`**, in order.
3. **Automatic fallbacks**, in order:
   - the same role with a fuzzy name (case-insensitive, whitespace normalised, similarity ≥ 0.8) **[ASSUMPTION: threshold]**;
   - the same `testId`;
   - the same text without the role;
   - the same relative position as the element resolved on the other side. This is used **only** for `hover` and `scrollTo`, never for `click`, `fill` or `press`, to avoid acting on the wrong element.
4. **If still not found:**
   - **`optional: true` or `side: after`:** skip on BEFORE and record `{status: 'absent', reason}`. The video holds BEFORE's previous frame with the caption "not present in BEFORE". This is usually *the point* of the change, so it's presented as information, not an error.
   - **Required step:** skip it with a note and keep going while BEFORE is still on the same URL as AFTER. If the URLs diverge, BEFORE freezes for the rest of the scenario with the caption "BEFORE diverged at step N".
5. **Reporting:** the manifest records `resolvedBy: 'primary' | 'fallback[n]' | 'fuzzy' | 'testId' | 'text' | 'position'`, so the agent can tighten the scenario.

On AFTER, a required step that fails makes the scenario `failed`, because either the agent's UI or the scenario is wrong. The video is still composed, with a warning, and the run exits with code 3.

### 11.6 Recorder backends
```ts
interface RecorderBackend {
  launch(opts: LaunchOptions): Promise<void>;
  newSide(side: 'before' | 'after', ctx: ContextOptions): Promise<SideHandle>;
  close(): Promise<void>;
}
interface SideHandle {
  goto(url: string): Promise<void>;
  act(step: Step, loc: ResolvedLocator): Promise<StepResult>;
  settle(): Promise<void>;
  screenshot(opts?: ShotOptions): Promise<Buffer>;
  burst(ms: number, maxFrames: number): Promise<Buffer[]>;
  snapshot(): Promise<string>;      // accessibility snapshot for plan
}
```
- **`playwright`** (default): uses `playwright-core` with Chromium. `doctor` offers to run `npx playwright install chromium`.
- **`agent-browser`** (optional, v0.6+): drives `vercel-labs/agent-browser` through its CLI, mainly to reuse an agent's existing browser setup.
  - **[VERIFY]** its current commands, screenshot and recording support, and whether two isolated sessions can run in parallel.
  - If lockstep isn't possible, it records BEFORE and then AFTER sequentially. Alignment still works, because the composer aligns by step, not by time.
- **Browsers:** Chromium only in v1. Firefox and WebKit come later through the Playwright backend.

---

## 12. Outputs

### 12.1 Run directory layout
```
.show-what-changed/                      # gitignored by `init`
  runs/2026-11-01T2301-3f2a1c9/
    compare.mp4                          # all scenarios, with a title card per scenario
    compare.gif                          # if requested
    poster.png                           # most-changed step, side by side, with boxes
    pr.md                                # ready-to-paste markdown (§12.3)
    manifest.json
    scenarios/
      pricing-toggle--desktop/
        compare.mp4                      # this scenario only
        before.mp4  after.mp4            # per-side step-aligned clips (for before-and-after / custom layouts)
        frames/01-initial-view-{before,after,diff}.png …
        scenario.resolved.json           # exact steps run, with resolved locators
    logs/ before.server.log  after.server.log  recorder.log  ffmpeg.log
  auth/                                  # storageState profiles (0600)
  har/                                   # HAR mocks
  scenarios/agent/                       # agent-written scenarios
show-what-changed/scenarios/             # committed, reusable scenarios (no dot)
```
Run directories older than 14 days, or beyond the 20 most recent, are pruned automatically **[ASSUMPTION: defaults]**.

### 12.2 `manifest.json` (schema v1)
```jsonc
{
  "schemaVersion": 1,
  "tool": { "name": "show-what-changed", "version": "0.1.0" },
  "runId": "2026-11-01T2301-3f2a1c9",
  "status": "ok",                         // ok | partial | failed
  "repo": { "root": "/abs/path", "framework": "nextjs-app" },
  "base": { "ref": "main", "sha": "3f2a1c9…", "resolvedVia": "merge-base", "url": "http://127.0.0.1:4310" },
  "head": { "ref": "WORKTREE", "sha": "a81d…", "dirty": true, "url": "http://127.0.0.1:4311" },
  "changedFiles": ["app/pricing/page.tsx", "components/PlanCard.tsx"],
  "routes": [
    { "route": "/pricing", "reason": "direct", "via": ["app/pricing/page.tsx"] },
    { "route": "/settings/profile", "reason": "import", "via": ["components/PlanCard.tsx"] }
  ],
  "scenarios": [{
    "id": "pricing-toggle", "route": "/pricing", "device": "desktop", "status": "ok",
    "video": "scenarios/pricing-toggle--desktop/compare.mp4",
    "steps": [
      { "i": 0, "action": "goto /pricing",
        "before": { "status": "ok", "ms": 820 }, "after": { "status": "ok", "ms": 790 },
        "changeRatio": 0.042, "boxes": [[312, 140, 420, 96]],
        "frames": { "before": "…", "after": "…", "diff": "…" } },
      { "i": 3, "action": "click switch /yearly/i",
        "before": { "status": "absent", "reason": "locator not found (role=switch name=/yearly/i)" },
        "after":  { "status": "ok", "resolvedBy": "primary", "ms": 240 }, "changeRatio": 0.31 }
    ]
  }],
  "artifacts": { "mp4": "compare.mp4", "gif": null, "poster": "poster.png", "prMarkdown": "pr.md" },
  "summary": "2 routes · 10 steps · 7 visually changed · 1 absent in BEFORE",
  "warnings": ["Diff touches prisma/schema.prisma; shared backend may break BEFORE"],
  "timingsMs": { "plan": 0, "workspace": 0, "servers": 0, "record": 0, "compose": 0 }
}
```
- **Schema:** a JSON Schema is generated to `schema/manifest.v1.json`.
- **`--json`:** prints this object to stdout.
- **`summary`:** written so an agent can paste it into its reply unchanged.

### 12.3 PR integration (all opt-in)
- **Always written locally:** `pr.md`. It contains a BEFORE/AFTER `<table>` per scenario, the poster, the summary, and a `{{VIDEO_URL}}` placeholder. Image paths are relative so a tool can rewrite them after upload.
- **`vercel-labs/before-and-after` compatibility:** each scenario has `before.mp4`/`after.mp4` and `frames/*-{before,after}.png` with predictable names, all listed in the manifest. **[VERIFY]** the exact inputs that skill expects (local paths or URLs, naming). If needed, add `--export before-and-after` to write its expected layout. Integration stays at compatibility level, with no dependency.
- **`--pr-comment`:** uses the user's authenticated `gh` to create or update one comment tagged `<!-- show-what-changed -->`, containing the summary and poster.
  - **[VERIFY]** whether current `gh` can attach video files (the brief mentions `gh pr edit --attach`; I haven't confirmed that flag exists). The REST API has no general upload endpoint for comment attachments.
  - **Fallbacks:** (a) in CI, upload as a workflow artifact and link it; (b) `--media-branch` commits media to an orphan branch and links raw URLs (explicit opt-in); (c) the user drags and drops the file.
- **GitHub Action** (v0.5): `show-what-changed/action`, a thin composite action. It installs Chromium, runs `--ci`, uploads `.show-what-changed/runs/*` as an artifact, and optionally comments.

Nothing leaves the machine unless one of these flags is set.

---

## 13. MCP server

Started with `show-what-changed mcp` (stdio) using `@modelcontextprotocol/sdk`.
- **Progress:** long operations send MCP progress notifications where the client supports them.
- **Async mode:** `swc_compare` also accepts `async: true`; the client then polls `swc_status`.

Client config (Cursor, Claude Code, Cline and others use the same shape):
```json
{ "mcpServers": { "show-what-changed": { "command": "npx", "args": ["-y", "show-what-changed", "mcp"] } } }
```

### 13.1 Tools

**`swc_plan`** detects changes and proposes what to record.
```json
{
  "name": "swc_plan",
  "description": "Detect UI routes changed between two git refs. Returns draft scenarios and an accessibility snapshot of each route on the AFTER side, to help write interaction steps.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "cwd":   { "type": "string", "description": "Repo or app root. Defaults to the server's cwd." },
      "base":  { "type": "string", "description": "BEFORE ref. Default: auto." },
      "head":  { "type": "string", "description": "AFTER ref or 'WORKTREE'. Default: WORKTREE." },
      "routes":{ "type": "array", "items": { "type": "string" } },
      "includeSnapshots": { "type": "boolean", "default": true },
      "maxRoutes": { "type": "integer", "default": 5, "minimum": 1, "maximum": 20 }
    }
  }
}
```
→ `{ planId, base, head, framework, changedFiles, routes:[{route,reason,via}], draftScenarios:[Scenario], snapshots:{[route]: string}, hints:{addedText, removedText, newTestIds}, warnings }`

**`swc_validate_scenario`** dry-runs scenarios on AFTER only, without video.
```json
{ "name": "swc_validate_scenario",
  "inputSchema": { "type": "object", "required": ["scenarios"],
    "properties": { "planId": { "type": "string" },
                    "scenarios": { "type": "array", "items": { "$ref": "#/$defs/Scenario" } } } } }
```
→ per step `{ status, resolvedBy, error? }`, plus a low-resolution screenshot of the first failed step as an image content block.

**`swc_compare`** is the main tool.
```json
{ "name": "swc_compare",
  "description": "Record the same scenarios on BEFORE and AFTER and compose a step-synced side-by-side video. Returns artifact paths and a summary to show the user.",
  "inputSchema": { "type": "object",
    "properties": {
      "planId":    { "type": "string", "description": "Reuse servers and worktrees from swc_plan." },
      "cwd":       { "type": "string" }, "base": { "type": "string" }, "head": { "type": "string" },
      "scenarios": { "type": "array", "items": { "$ref": "#/$defs/Scenario" } },
      "routes":    { "type": "array", "items": { "type": "string" } },
      "devices":   { "type": "array", "items": { "type": "string" }, "default": ["desktop"] },
      "formats":   { "type": "array", "items": { "enum": ["mp4","gif","webm","png","frames"] }, "default": ["mp4","png"] },
      "highlight": { "type": "boolean", "default": true },
      "async":     { "type": "boolean", "default": false }
    } } }
```
→ the manifest (§12.2), plus `poster.png` as an image content block so agents that can see images check the result before replying. With `async: true`, it returns `{ runId }`.

**`swc_status`:** `{ runId }` → `{ state: 'planning'|'installing'|'starting'|'recording'|'composing'|'done'|'failed', progress: 0..1, message, manifest? }`

**`swc_cancel`:** `{ runId }` → stops the run and kills its servers, keeping partial artefacts.

**`swc_cleanup`:** `{ all?: boolean }` → stops leftover servers and prunes worktrees and caches.

`$defs/Scenario` is the JSON Schema version of §8.1, shipped as `schema/scenario.v1.json` and embedded in the tool schemas.

**Trust (§15):** the MCP server never auto-trusts. An untrusted repo returns error code 7 with the message "run `npx show-what-changed doctor` in a terminal to trust this repo".

**Resources (optional, v0.6+):** `swc://runs/{runId}/manifest` and `swc://runs/{runId}/poster`.

---

## 14. Agent Skill (`SKILL.md`)

Installed by `show-what-changed skill install --target …`. Target paths are best-effort; each tool's current convention needs checking **[VERIFY]**:
- **generic:** `skills/show-what-changed/SKILL.md`, plus a pointer line in `AGENTS.md`.
- **claude:** `.claude/skills/show-what-changed/SKILL.md`.
- **cursor:** a project rule under `.cursor/rules/` that references the skill.
- **codex:** a section appended to `AGENTS.md`.

Outline of the text:
```markdown
---
name: show-what-changed
description: After finishing any change that affects what users see in a web UI, record a side-by-side BEFORE/AFTER video with show-what-changed and lead your final reply with it instead of a long text summary.
---
## When to use
- You changed components, pages, styles, copy or layout in a web app in this repo.
- Skip for backend-only, test-only, docs-only, or config changes with no visual effect.

## Steps
1. Save your changes. Do NOT commit just for this; AFTER defaults to the working tree.
2. Call `swc_plan` (MCP) or run `npx show-what-changed plan --json`.
3. Read `routes` and `snapshots`. If you changed an interaction (modal, form, toggle, hover state), write 1–3 short scenarios:
   - use role+name locators from the snapshot, e.g. { role: button, name: "Save" }
   - anchor on elements that exist in both versions; mark new-only steps `optional: true`
   - ≤ 12 steps, no fixed sleeps
4. Call `swc_validate_scenario`; fix failing steps (max 2 attempts).
5. Call `swc_compare` (or `npx show-what-changed --json`).
6. Final reply:
   - First line: the video path (show the poster image if you can).
   - Then the manifest `summary` and at most 3 bullets on what changed and why.
   - Mention "absent in BEFORE" steps and warnings honestly.
7. If it fails (exit code ≠ 0): report the error message and hint, then fall back to a short text summary. Retry at most once.

## Never
- Never pass `--yes` or set SWC_TRUST for a repo the user hasn't trusted.
- Never use `--pr-comment`, `--media-branch` or any upload unless the user asked.
- Never paste secrets from logs.
```

---

## 15. Security

- **Trust gate:** running a repo's install scripts, dev command and hooks executes arbitrary code.
  - **First run in a repo:** SWC lists exactly what it will run (install, dev command, hooks, both SHAs) and asks for confirmation.
  - **Storing consent:** consent goes in `~/.config/show-what-changed/trusted.json`, keyed by repo path plus a hash of the config and the `package.json` `scripts`. Any change to those asks again.
  - **CI:** untrusted repos fail with exit 7 unless `SWC_TRUST=1` is set explicitly.
  - **MCP:** the server never auto-trusts.
- **BEFORE refs are code too:** installing an old or other-branch ref runs *that* ref's scripts. For CI on fork PRs, the docs say to use `pull_request` (not `pull_request_target`) with no secrets.
- **Secrets:**
  - Env files are copied with 0600 permissions and deleted after the run. `storageState` files are 0600 and gitignored.
  - Logs redact values of env vars whose names match `/(KEY|TOKEN|SECRET|PASSWORD|DATABASE_URL|PRIVATE)/i`, plus common token shapes (`sk-…`, `ghp_…`, JWT-like strings).
  - The manifest never contains env values.
- **PII in recordings:** `hideSelectors` and `--redact <selector>` blur regions on both sides (Playwright's screenshot `mask`). The README warns that videos may contain whatever is on screen.
- **No egress by default:**
  - No telemetry and no uploads.
  - Only `--pr-comment` and `--media-branch` talk to GitHub, through the user's own `gh`.
  - Third-party analytics are blocked during recording.
- **Local-only servers:** bound to `127.0.0.1` where possible and always killed on exit.
- **Supply chain:** few dependencies, a committed lockfile, npm provenance on publish, and `gitleaks` in CI.

---

## 16. Error handling and exit codes

| Code | Meaning | Typical cause and what's printed |
|---|---|---|
| 0 | Success | Everything composed. AFTER steps all OK (BEFORE `absent` is allowed) |
| 1 | Internal error | Bug. Log path and issue link |
| 2 | Usage or config error | Bad flag, invalid config or scenario (zod error path), unknown ref |
| 3 | Partial | Composed, but a required AFTER step failed or a scenario was skipped |
| 4 | Nothing to show | No UI-relevant changes and no `--route`. Lists the changed files with a hint |
| 5 | Workspace or hook failure | Worktree, install or hook failed. Tail of the log |
| 6 | Server failure | Dev server exited or wasn't ready in time. Last 40 log lines for that side |
| 7 | Not trusted | Untrusted repo in CI or MCP |
| 8 | Environment missing | No Chromium, no ffmpeg, or ffmpeg without `drawtext`. `doctor` prints the fix commands |
| 9 | Composition failure | ffmpeg error. Frames are kept; `compose <runDir>` retries |
| 10 | Timeout or cancelled | `--timeout` or `swc_cancel`. Partial artefacts kept |
| 130 | Interrupted | SIGINT. Cleanup still runs |

Every error states:
- what failed;
- which side (BEFORE or AFTER);
- one concrete next action;
- the log path.

`--json` errors look like `{ "status": "failed", "error": { "code": 6, "side": "before", "message": "…", "hint": "…", "log": "…" } }`.

**Platforms:** macOS and Linux are first-class. On Windows, worktrees and Playwright work, but process-group kills and symlinked `node_modules` need special handling, so it's best effort, with WSL2 recommended **[ASSUMPTION]**.

---

## 17. Performance targets **[GOAL — none measured]**

These say what "fast enough to run at the end of every agent task" should mean. They are design targets, not benchmarks.

| Phase | Target (warm cache, mid-size Next.js app, 1 route, ≤ 8 steps, recent laptop) |
|---|---|
| Plan (diff and routes, no snapshots) | < 2 s |
| Workspace (BEFORE worktree reused, lockfile unchanged) | < 3 s |
| Workspace (cold, lockfile changed) | Depends on the package manager install. No target; show progress |
| Both servers ready plus warm-up, in parallel, dev mode | < 30 s |
| Recording | < 2 s per step (both sides in parallel) |
| Composing the MP4 | < 10 s for 30 s of output |
| **Total (warm)** | **< 60 s** |

Main levers:
- start both servers in parallel;
- reuse worktrees, `node_modules` and build caches;
- share servers between plan and compare through `planId`;
- use `frames` capture;
- later, an optional keep-alive daemon (open question 5).

---

## 18. Tech stack

- **Language:** TypeScript (strict), Node ≥ 20, ESM. Built with `tsup`. pnpm for the repo.
- **Browser:** `playwright-core` with Chromium (`npx playwright install chromium`, prompted by `doctor`). Optional `agent-browser` backend.
- **Video:** `ffmpeg-static` and `ffprobe-static`, preferring a system ffmpeg when present.
- **Images:** `pixelmatch` with `pngjs`. `sharp` for resizing **[ASSUMPTION: its native dependency is acceptable; otherwise stay pngjs-only]**.
- **MCP:** `@modelcontextprotocol/sdk` (stdio).
- **CLI:** `citty` or `commander` (pick one), `picocolors`, and a spinner with a plain fallback in CI.
- **Config and schemas:** `zod` for validation, `zod-to-json-schema` to generate the published schemas, `jiti` to load the TS config, and `yaml`.
- **Git:** the `git` CLI through `execa` (no libgit2).
- **Code analysis:** `es-module-lexer`, `get-tsconfig` (path aliases), and `@babel/parser` for router configs.
- **Tests:** `vitest`, Playwright, and ffprobe-based assertions.

---

## 19. Repository structure

The MVP is a **single package** with the folders below under `src/`. Split into packages only if the MCP server or the action needs it **[ASSUMPTION]**.
```
show-what-changed/
├─ src/
│  ├─ cli/                 # commands, flags, terminal output, exit codes
│  ├─ mcp/                 # MCP server + tool handlers
│  ├─ planner/             # diff.ts, importGraph.ts, hints.ts, adapters/{nextjs-app,nextjs-pages,vite-react-router,sveltekit,storybook,custom}.ts
│  ├─ workspace/           # worktree.ts, install.ts, envFiles.ts, cache.ts, trust.ts
│  ├─ orchestrator/        # ports.ts, server.ts, ready.ts, hooks.ts, cleanup.ts
│  ├─ recorder/            # lockstep.ts, locators.ts, fallbacks.ts, determinism/, cursor/, backends/{playwright,agent-browser}.ts
│  ├─ composer/            # align.ts, filtergraph.ts, ffmpeg.ts, highlight.ts, gif.ts, poster.ts, prMarkdown.ts
│  ├─ schema/              # config.ts, scenario.ts, manifest.ts (zod)
│  └─ index.ts             # public API: plan(), compare(), defineConfig()
├─ skills/show-what-changed/SKILL.md
├─ schema/                 # generated *.v1.json
├─ fixtures/               # test apps (§20)
├─ assets/                 # Inter font (OFL), cursor.svg
├─ action/                 # GitHub composite action (v0.5)
├─ docs/                   # recipes: auth, DB seeding, monorepos, Storybook, CI
├─ test/                   # unit, integration, golden
├─ THIRD_PARTY_NOTICES.md  LICENSE  README.md  SECURITY.md  CONTRIBUTING.md
```

---

## 20. Testing strategy

- **Unit tests (vitest):**
  - adapter file-to-route tables;
  - import graph and aliases;
  - ref resolution;
  - alignment math (`L_i`, padding);
  - filter graph generation (snapshot tests);
  - highlight box merging on synthetic PNGs;
  - fallback ranking;
  - config and scenario validation;
  - log redaction;
  - trust hashing.
- **Fixture apps:** each one is a tiny app plus a `make-history.sh` script that creates commits `c0` and `c1` with a known UI change.
  - `next-app-basic` (MVP): `/` and `/pricing`. The change is a button colour and copy change, plus a new yearly toggle.
  - `next-pages-basic`, `vite-react-router`, `sveltekit-basic`, `storybook-react`.
  - `auth-app`: a login-gated page, to test `storageState`.
  - `db-app`: SQLite with seed and reset hooks.
- **Integration tests:** the full CLI on each fixture from `c0` to `c1`, asserting:
  - the exit code;
  - manifest routes and step statuses (for example, the new toggle is `absent` on BEFORE);
  - with ffprobe: duration within one frame of `Σ L_i` plus title cards, and the expected dimensions, codec and fps;
  - `changeRatio` above 0 on changed steps and about 0 on unchanged ones.
- **Golden outputs:** keyframes, not MP4 bytes, because encoders aren't byte-stable.
  - Golden PNGs per fixture step, compared with a pixelmatch tolerance.
  - The composed MP4 is checked by extracting frames at the midpoint of each segment and comparing them to golden composed frames.
  - Update with `pnpm test:update` and review in a PR.
  - The source of truth is the official Playwright Docker image on Linux.
- **Determinism test:** run the same comparison twice and require identical keyframes, within a tiny tolerance. This catches leaks in time, randomness or animations.
- **Failure tests:**
  - a server that never becomes ready gives exit 6;
  - a port already in use is skipped;
  - a failing hook gives exit 5;
  - SIGINT mid-recording leaves no orphan processes (checked through the PID file);
  - a selector missing on BEFORE is `absent` and gets a caption;
  - an untrusted repo in `--ci` gives exit 7.
- **MCP tests:** spawn the server, validate the `tools/list` schemas, then run `swc_plan` and `swc_compare` on `next-app-basic`.
- **CI:** GitHub Actions. Full suite on ubuntu-latest, smoke tests on macos-latest, and Windows smoke tests from v0.6 as best effort.
- **Dogfooding:** representative web app is the first real project (§23).

---

## 21. Milestones

There are no dates; it's a side project. Exit criteria are what count.

| Milestone | Scope | Exit criteria |
|---|---|---|
| **M0: spike** | Hard-coded script: worktree at `HEAD`, two `next dev` processes, one route, keyframes after `goto` and one click, ffmpeg `hstack` to MP4 | One correct-looking MP4 of `next-app-basic` |
| **M1: MVP** (CLI only) | `compare` with the **Next.js App Router adapter only**, default and YAML scenarios, `frames` capture, step alignment, labels and captions, MP4 and PNG poster, manifest v1, core determinism (animations off, frozen clock, seeded random), ready checks, cleanup, trust prompt, `doctor` | Works end to end on the fixture **and on representative web app** five times in a row without manual fixes |
| **M2: agent-ready** | `plan` with snapshots and hints, the MCP server (`swc_plan`, `swc_validate_scenario`, `swc_compare`, `swc_status`, `swc_cancel`, `swc_cleanup`), SKILL.md and `skill install`, BEFORE fallbacks and `absent`, highlight boxes, `--json` | Claude Code and Cursor each complete "make a UI change, call the tool, reply with the video" on representative web app |
| **M3: state parity** | Auth profiles and the `auth` command, hooks, backend modes, env file copying, HAR record and replay, worktree and `node_modules` caching | `auth-app` and `db-app` fixtures pass |
| **v0.5: public launch** | `nextjs-pages` and `vite-react-router` adapters, GIF, `pr.md`, before-and-after compatibility, GitHub Action, README with demo video, docs | Launch checklist in §23 |
| **v0.6–0.9** | SvelteKit and Storybook adapters, `video` capture mode, `--pr-comment` and `--media-branch`, multiple devices per run, `agent-browser` backend, MCP resources, Windows best effort, optional keep-alive daemon | Each adapter's fixture passes in CI |
| **v1.0** | Config, scenario and manifest schemas frozen under semver, full docs, every fixture green on Linux and macOS | No planned breaking changes |

---

## 22. Open questions

1. **Short alias:** `swc` clashes with the SWC compiler's `swc` binary (`@swc/cli`), so ship no alias, or something like `swcd`. Decide before publishing.
2. **Default BEFORE ref:** on a feature branch, merge-base shows the *whole branch's* changes, while `HEAD` shows just the agent's uncommitted edits. Leaning towards `HEAD` when the tree is dirty and merge-base when it's clean, with an explicit `--base` always winning.
3. **Default capture mode:** `frames` is deterministic but may look choppy on hover and transition changes. Decide after dogfooding.
4. **Dev or build mode by default:** dev starts faster when warm; build is closer to production with no overlays. Default to dev with a per-project `build: true`?
5. **Keep-alive daemon:** keeping servers warm between agent calls is a big speed win, at the cost of complexity and stale state.
6. **Scenario authoring:** are agents plus accessibility snapshots reliable enough, or add `record-scenario` (headed Playwright codegen converted to our YAML)?
7. **Hosting PR videos:** with no simple attachment API, is an orphan media branch acceptable, or only artifact links?
8. **Highlight accuracy:** would a DOM-based diff (matching elements by role and name, then comparing their bounding boxes) beat pixel diffs when layout shifts? Candidate for v1.x.
9. **before-and-after:** stay compatible-only (current lean) or integrate directly?
10. **Multiple devices:** side by side per device in separate clips (current plan), or a 2×N grid?
11. **Copied code:** if any code is taken from PR UI Compare or pr-preview, re-check their `LICENSE` files then (pr-preview's isn't auto-detected as MIT by GitHub) and credit them.

---

## 23. Launch plan

1. **Stay private until M2 works on representative web app.** "Works" means the agent end-of-task flow produces a correct video on real changes, repeatedly, without hand-fixing.
2. **Hygiene before flipping to public:**
   - clean the history if needed;
   - run `gitleaks detect` over the full history;
   - make sure fixtures hold no real data;
   - add `LICENSE` (MIT), `THIRD_PARTY_NOTICES.md`, `SECURITY.md`, `CONTRIBUTING.md` and issue templates.
3. **README order:**
   1. **The demo video first:** a real BEFORE/AFTER under 20 s, as an MP4 uploaded to GitHub, plus a GIF fallback.
   2. A one-line pitch.
   3. A Next.js quick start: `npx show-what-changed`.
   4. "Use it with your agent": the MCP snippet and `skill install`.
   5. How it works (the §5 diagram).
   6. A link to the config reference.
   7. Prior art and credits (§3).
4. **Publish:**
   - Reserve the npm name early with a `0.0.0` placeholder.
   - Release `0.5.0` with npm provenance.
   - Create a GitHub release with the demo video.
5. **Announce everything on the same day** (you post these, the tool doesn't):
   - an X thread led by the video;
   - Show HN: "Show HN: show-what-changed – side-by-side before/after videos of your AI agent's UI changes";
   - r/ClaudeAI, r/cursor and r/webdev;
   - relevant Discord communities;
   - submissions to MCP server directories and agent-skill lists.
6. **After launch:**
   - Triage issues weekly.
   - Prioritise the framework adapters people ask for.
   - Hold the non-goals in §2.2.

---

## Appendix A: Glossary
- **BEFORE / AFTER:** the app rendered from the base ref, and from the head ref or the working tree.
- **Step:** one scenario action plus its settle; the unit of synchronisation.
- **Keyframe:** a screenshot taken after a step settles.
- **Lockstep:** performing each step on both sides before moving to the next.
- **Absent:** a step whose target doesn't exist on one side, which is expected for new UI.

## Appendix B: Assumptions in one place
- **Runtime:** Node ≥ 20; Chromium only in v1; macOS and Linux first.
- **Implementation choices:**
  - regex diff hints before AST ones;
  - `jiti` for loading the config;
  - `sharp` is acceptable;
  - a single package for the MVP.
- **Thresholds:**
  - HAR miss warning above 20%;
  - "broad layout change" when `changeRatio` is above 0.5;
  - fuzzy name similarity of at least 0.8;
  - run pruning at 14 days or 20 runs.
- **Unverified upstream details:**
  - the Playwright clock API details;
  - libass in ffmpeg-static;
  - GitHub upload size limits;
  - whether `gh` has an attachment flag;
  - before-and-after's expected inputs;
  - agent-browser's command surface;
  - skill install paths for each agent.
- **Performance:** every number in §17 is a goal, not a measurement.
