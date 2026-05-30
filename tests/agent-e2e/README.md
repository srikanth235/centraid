# Agent-driven e2e

A loose, exploratory counterpart to `apps/desktop/tests/e2e/` (Playwright). Each
flow is a runnable `.mjs` file under [flows/](flows) — `node` it and the harness
takes care of build, fresh state, restart, screenshots, verdict, and teardown.

Use this layer for narrative end-to-end journeys ("clone a template, edit it,
publish it, see it on mobile") where a human-judgment pass adds value. Keep
scripted Playwright in `apps/desktop/tests/e2e/` for invariants that must never
flake.

## Running a flow

```sh
node tests/agent-e2e/flows/clone-template-and-reopen.mjs
```

That's the whole loop. The harness:

1. Builds the desktop app if `dist/main.js` is missing.
2. Creates a tmp `userData` + `appsDir` under `runs/<flow>-<timestamp>/`.
3. Launches Electron with `--remote-debugging-port=<free>` and your real
   gateway settings (default `http://127.0.0.1:18789`, token from
   `$OPENCLAW_GATEWAY_TOKEN`). Override per-flow by writing your own
   `centraid-settings.json` inside the flow if needed.
4. Connects Playwright over CDP, exposes `ctx.page` / `ctx.shot` / `ctx.restart`
   / `ctx.note` to the flow.
5. Runs the flow's body. Throws or returning `{ pass: false }` → FAIL.
6. Writes `runs/<runId>/verdict.md` with PASS/FAIL and notes.
7. Tears down Electron. On PASS the workspace is wiped; on FAIL it's kept so
   you can poke at the on-disk state.

## Authoring a flow

Two files, same slug:

```
flows/
  my-flow.md     ← prose intent: goal, steps, expectations
  my-flow.mjs    ← runnable: calls runFlow() with the steps
```

The `.mjs` is the source of truth for execution; the `.md` is for humans
(or agents) reading the diff to understand intent.

Skeleton:

```js
import { runFlow } from '../lib/harness.mjs';

await runFlow('my-flow', async (ctx) => {
  await ctx.shot('start');
  await ctx.page.locator('.something').click();
  if (somethingWrong) throw new Error('describe the failure');
  ctx.note('intermediate observation');

  await ctx.restart();           // ctx.page is replaced; do NOT destructure it
  await ctx.shot('after-restart');

  return { pass: true, notes: 'one-line summary for the verdict' };
});
```

Read `ctx.page` fresh each step — `ctx.restart()` swaps it under the hood.

## Layout

```
tests/agent-e2e/
  flows/                              ← committed flows (.md + .mjs pairs)
  lib/
    harness.mjs                       ← runFlow() + setup/restart/teardown CLI
  runs/                               ← gitignored audit trail per run
```

## Side CLI for ad-hoc debugging

When you want to poke around manually (no automated assertions), drive the
harness directly:

```sh
node tests/agent-e2e/lib/harness.mjs setup        # → runId, cdpUrl
# ...attach to cdpUrl with your own driver...
node tests/agent-e2e/lib/harness.mjs restart <id>
node tests/agent-e2e/lib/harness.mjs teardown <id>  # add --keep-workspace to keep tmp dirs
```

## When to graduate a flow

When a flow stabilizes and you want CI-grade gating: port it to a Playwright
spec in `apps/desktop/tests/e2e/`. Agent e2e is the fast-iteration, exploratory
tier; Playwright is the regression tier.
