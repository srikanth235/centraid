# issue-17 — agent-e2e harness + root test orchestration

GitHub issue: [#17](https://github.com/srikanth235/centraid/issues/17)

## Checklist

- [x] Root `test` script delegating to turbo
- [x] `test` task in `turbo.json` with `dependsOn: ["^build"]`
- [x] `tests/agent-e2e/` scaffolded with `lib/harness.mjs`, README, AGENTS.md, `.gitignore`
- [x] Graceful kill with `page.close({ runBeforeUnload: true })` so localStorage flushes before main-process exit
- [x] Flow `clone-template-and-reopen` — draft persistence on disk across restart
- [x] Flow `multiple-drafts-coexist-and-persist` — three drafts, templates not consumed by clone
- [x] Flow `delete-draft-wipes-disk-and-ui` — tile menu → confirm modal → IPC delete chain
- [x] Flow `settings-theme-persists` — renderer-pref persistence in userData
- [x] All four flows verified PASS end-to-end

## What changed

**Root `test` script delegating to turbo.** `package.json` gains `"test": "turbo run test"`. The new `test` task in `turbo.json` with `dependsOn: ["^build"]` ensures per-package builds run first (currently `tsx --test` in `@centraid/agent-harness` and `@centraid/openclaw-plugin`), becoming invokable via `bun run test` at the root. Turbo silently skips packages without a `test` script.

**`tests/agent-e2e/` scaffolded with `lib/harness.mjs`, README, AGENTS.md, `.gitignore`.** New directory at repo root for agent-driven flows. The harness exports a single `runFlow(slug, fn, opts)` orchestrator that does build → fresh `userData` + `projectsDir` → spawn Electron with `--remote-debugging-port` → connect Playwright via `chromium.connectOverCDP` → exec the flow with `ctx.page` / `ctx.shot` / `ctx.note` / `ctx.restart` → write verdict.md → teardown. Side CLI (`setup` / `restart` / `teardown`) is exposed for ad-hoc driving. README is the user-facing how-to; AGENTS.md is the agent-judgment guide (when to use this vs Playwright, conventions, failure-debug recipe). `.gitignore` excludes `runs/` so audit trails stay local.

**Graceful kill with `page.close({ runBeforeUnload: true })` so localStorage flushes before main-process exit.** `killAndWait` does a leading 250ms pause to let just-completed writes enter Chromium's persistence pipeline, sends SIGTERM, busy-waits for exit, then SIGKILL as last resort. The `ctx.restart()` helper additionally closes the renderer page with `runBeforeUnload: true` first — that's what triggers pagehide and makes Chromium flush localStorage to leveldb. Without it, renderer prefs (e.g. theme) set <1s before restart are lost; with it, they persist correctly. Per-run workspace under `runs/<slug>-<timestamp>/workspace/` is wiped on PASS, kept on FAIL.

**Flow `clone-template-and-reopen` — draft persistence on disk across restart.** Clicks Hydrate template → waits for builder → verifies `projects/hydrate/app.json` is on disk with name "Hydrate" → exits builder → verifies Hydrate draft tile appears under APPS → restarts → verifies draft tile is still there.

**Flow `multiple-drafts-coexist-and-persist` — three drafts, templates not consumed by clone.** Clones all three built-in templates in sequence, confirms each builder opens and the back button returns home. Asserts the TEMPLATES section still holds all three tiles (clones don't consume — `loadAvailableTemplates` at app.ts line 682 filters by `userApps`, not drafts), three project directories exist on disk, and three draft tiles render under APPS. Restart preserves all of it.

**Flow `delete-draft-wipes-disk-and-ui` — tile menu → confirm modal → IPC delete chain.** Clones Hydrate, opens the `.tile-more-btn` context menu, clicks "Delete draft", confirms in the modal, waits for the draft tile to detach. Verifies the project directory is gone from disk, the originating template stays in TEMPLATES (only publish consumes), and a restart preserves the clean state.

**Flow `settings-theme-persists` — renderer-pref persistence in userData.** Opens the Settings drawer, clicks "Dark" in the theme segmented control, confirms `html[data-theme="dark"]` immediately. Closes the drawer, restarts Electron with the same `userData`, asserts `html[data-theme="dark"]` after reconnect. This exercises the localStorage-in-userData path, distinct from disk-backed drafts.

**All four flows verified PASS end-to-end.** See Verification.

## Out of scope

- LLM-in-the-runtime-loop helpers (`ctx.askClaude`, visual diff vs golden run, autonomous step authoring from prose specs). Sketched in conversation as future shapes; none added now.
- Mock gateway in the harness. The existing Playwright fixture at `apps/desktop/tests/e2e/fixtures.ts` has one — port it in when a flow needs publish/delete branches.
- Porting any agent-e2e flow into Playwright as a regression-tier test. That's the "graduate" step, done per-flow when invariants stabilize.
- CI wiring — these flows are local-only for now (`runs/` is gitignored, no GitHub Actions step).

## Verification

- `bun run test` at the root passes — 6 turbo tasks, 39 tests across `@centraid/agent-harness` (1) and `@centraid/openclaw-plugin` (38).
- All four flows PASS sequentially in ~11s on a warm build:
  - `clone-template-and-reopen` — 2.3s
  - `delete-draft-wipes-disk-and-ui` — 2.6s
  - `multiple-drafts-coexist-and-persist` — 2.6s
  - `settings-theme-persists` — 2.4s
- Each run produces a `verdict.md` and a `screenshots/` directory under `runs/<slug>-<timestamp>/`.
- The graceful-kill behavior is verified by `settings-theme-persists`: without `page.close({ runBeforeUnload: true })`, an earlier harness lost the theme write — the leveldb log file was 0 bytes after exit. With the fix, dark theme survives restart.
- Two flows had wrong premises initially caught by failing assertions (assumed clone consumed templates; actually only publish does). Slugs renamed to match what the flows actually verify; the corrected understanding is documented in the flow comments and spec.
