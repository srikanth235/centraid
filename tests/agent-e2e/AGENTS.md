# AGENTS.md — agent-driven e2e

Notes for any agent (or human) writing or running flows in this folder. Pair this with [README.md](README.md), which is the general user-facing how-to.

## What this layer is for

A loose, exploratory complement to scripted Playwright in [`apps/desktop/tests/e2e/`](../../apps/desktop/tests/e2e/). The harness ([`lib/harness.mjs`](lib/harness.mjs)) launches Electron with `--remote-debugging-port`, gives each run a fresh `userData` + `appsDir`, and exposes a Playwright `Page` over CDP through `runFlow(slug, fn)`. The flow file is the recipe; the harness is the runner.

The structural payoff over Playwright is **external CDP** and **`ctx.restart()`** — Electron outlives the runner, so an agent can attach mid-flow, take ad-hoc actions, and resume. That only matters when an agent is supervising. For pure invariants, prefer Playwright.

## Choosing the right layer

| Symptom | Where it belongs |
|---|---|
| Hard invariant that must never flake in CI | `apps/desktop/tests/e2e/` (Playwright) |
| End-to-end journey that crosses surfaces (clone + edit + publish + reopen) | here |
| Visual / copy / "does this feel right" judgment | here |
| Tight DOM assertion on a single screen | Playwright |

If a flow here stabilizes and becomes invariant-shaped, port it to Playwright and delete the agent-e2e copy.

## Running a flow

```sh
node tests/agent-e2e/flows/<slug>.mjs
```

That does build (if needed), setup, exec, verdict, teardown. Verdict at `runs/<runId>/verdict.md`. On PASS the workspace is wiped; on FAIL it's kept under `runs/<runId>/workspace/` so you can inspect `userData`, `apps/`, etc.

## Authoring a flow

1. Read the existing renderer source for the screen you're testing — selectors live there. Don't guess class names. [`apps/desktop/src/renderer/react/shell/routes/HomeRoute.tsx`](../../apps/desktop/src/renderer/react/shell/routes/HomeRoute.tsx) and [`apps/desktop/src/renderer/react/shell/routes/BuilderRoute.tsx`](../../apps/desktop/src/renderer/react/shell/routes/BuilderRoute.tsx) are the two big ones.
2. Write `flows/<slug>.md` first — Goal, Setup, Steps, Expectations, Verdict. The prose stays the source of intent.
3. Encode it as `flows/<slug>.mjs` using `runFlow`. Skeleton in [README.md](README.md#authoring-a-flow).
4. Run it. Iterate until PASS. The first run's screenshots tell you whether the selectors actually found what you meant.
5. Commit both files. `runs/` is gitignored and stays local.

## Conventions

- **Slug = filename = `runFlow()` first arg.** Keep them identical so verdicts and run dirs are greppable.
- **Throw on failure, return `{ pass: true, notes }` on success.** Don't swallow errors with try/catch — let the harness write the FAIL verdict.
- **Use `ctx.note(msg)` for observations the verdict should preserve.** Things like "found 3 drafts after restart" — short, factual.
- **`ctx.shot('<n>-<intent>.png')` — descriptive name, not `step1.png`.** The screenshots are part of the audit trail.
- **Read `ctx.page` fresh each step. Never destructure it.** `ctx.restart()` replaces the underlying Page.
- **Verify on-disk state when it's the actual unit of truth.** For draft persistence, check `app.json` directly under `ctx.state.appsDir` — don't only trust the rendered DOM.
- **Gateway defaults to your local one** (`http://127.0.0.1:18789`, token from `$OPENCLAW_GATEWAY_TOKEN`). If a flow needs a mock or pinned URL, write a per-flow `centraid-settings.json` into `ctx.state.userData` before connecting.

## When a flow fails

1. Read `runs/<runId>/verdict.md` — it has the error and notes.
2. Look at the last screenshot before the failure. The `.shot()` index in the filename tells you where the flow got to.
3. The workspace is kept on FAIL. `ls runs/<runId>/workspace/apps/` shows what was on disk; `cat runs/<runId>/workspace/userData/centraid-settings.json` shows the seeded config.
4. The state.json still has the (now-dead) cdpUrl and pid. To get a live one for inspection: `node lib/harness.mjs setup` against a fresh run, manually replay the steps up to the failure point, then poke.
5. When done, `node lib/harness.mjs teardown <runId>` to wipe the workspace.

## What not to do

- **Don't put assertions only in screenshots.** A flow that looks right on screen but skips throwing on broken state will PASS silently. Always verify with `locator.count()` / on-disk reads / explicit throws.
- **Don't commit `runs/`.** It's gitignored for a reason — workspaces are tied to your machine paths.
- **Don't add retries inside a flow.** Flakiness is signal. Fix the selector or the wait, don't paper over it.
- **Don't reach into `apps/desktop/dist/` or rebuild manually.** The harness handles the build.
- **Don't call `process.exit()` from a flow.** Throw or return `{ pass: false }` and let `runFlow` handle teardown.

## Where to look

- [README.md](README.md) — user-facing how-to.
- [lib/harness.mjs](lib/harness.mjs) — `runFlow`, `setup`, `restart`, `teardown`. Read this before adding a helper.
- [flows/clone-template-and-reopen.mjs](flows/clone-template-and-reopen.mjs) — canonical example flow.
- [../../apps/desktop/tests/e2e/fixtures.ts](../../apps/desktop/tests/e2e/fixtures.ts) — the scripted-Playwright fixtures. Reuse patterns from here (mock gateway, seedPublishedApp) when a flow needs them.
- [../../AGENTS.md](../../AGENTS.md) — repo-wide conventions agents must follow on top of these.
