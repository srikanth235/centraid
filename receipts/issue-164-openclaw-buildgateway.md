# issue-164 — openclaw-plugin consumes buildGateway() (Phase 1: Plane A + Plane C)

GitHub issue: [#164](https://github.com/srikanth235/centraid/issues/164)

`@centraid/openclaw-plugin` had drifted into a parallel, hand-rolled
reimplementation of the gateway core — it directly constructed the git
`WorktreeStore`, the DB providers, the stores, the `Runtime`, the
registry-sync loop, every route, plus its own OpenClaw-cron path. All of
that already exists, host-agnostic, in `@centraid/gateway`'s
`buildGateway()`. Phase 1 migrates the plugin onto `buildGateway()` +
`composedHandler` (Plane A) and switches cron to the gateway's in-process
scheduler (Plane C), deleting the OpenClaw-cron glue. The in-process
chat + automation-fire surfaces (Plane B) are retained but now injected
into `buildGateway()` rather than wired by hand.

The Plane B orchestrator dedup (collapsing `openclaw-fire.ts` onto a shared
orchestrator parameterized by injected dispatchers) is **Phase 2** and is
explicitly out of scope here.

## Checklist

- [ ] Plugin imports and mounts buildGateway().composedHandler; no hand-rolled store/runtime/route graph remains
- [ ] @centraid/worktree-store and @mariozechner/pi-ai removed from the plugin package.json
- [ ] automation-host.ts, automations-cron.ts, automations-provider.ts deleted
- [ ] Cron runs via InProcessScheduler, started only from gateway_start (single-process invariant)
- [ ] Chat + ctx.agent + ctx.tool behavior unchanged (in-process surfaces retained)
- [ ] Automation fire goes through the shared orchestrator with injected dispatchers, manual + scheduled at parity (Phase 2)

## What changed

### `buildGateway()` gained in-process host-execution seams

`buildGateway()` constructs its own codex/claude chat runner, runner-status
preflight, and `runAutomationLocal`-based fire path. An in-process host
(OpenClaw) needs those three to run inside its own process instead. Four
optional options were added, each defaulting to today's behavior so the
desktop + daemon callers are byte-for-byte unchanged:

- `chatRunner` — overrides the constructed chat runner.
- `runnerStatus` — overrides the `GET /centraid/_chat/runner-status`
  preflight (OpenClaw reports `{ kind: 'openclaw', ok: true }`).
- `fireAutomationFactory` — overrides how an automation is fired (shared by
  the cron scheduler and the run-now route). The new `FireAutomation` /
  `FireAutomationDeps` / `FireAutomationFactory` types are exported.
- `lazyStoreInit` — defers the git-store `init()` from construction to
  `start()`, so a host that builds the gateway in multiple processes keeps
  the concurrent git-init off all but the one process that calls `start()`.

`BuiltGateway` also exposes `codeAppsDir()` — a `WorktreeStore`-agnostic
resolver for the live `main` worktree's `apps` dir — so a host can wire its
own automation routes without naming the git store.

## Out of scope

- **Phase 2 — Plane B orchestrator refactor.** Extracting the shared
  automation-run orchestrator (ledger + analytics + `runAutomationHandler`)
  parameterized by injected dispatchers, and collapsing `openclaw-fire.ts`
  onto it.
- **Host inversion** (`/acp spawn openclaw`): explicitly deferred — centraid
  stays an in-process OpenClaw plugin.

## Verification

- **Typecheck** — `bunx turbo run typecheck` is green across all 19
  workspace packages, including `@centraid/desktop` (which consumes
  `serve()`/`buildGateway()`). The new options are all optional, so desktop
  + daemon call sites compile unchanged.
- **Tests** — `bunx turbo run test` for the gateway / app-engine /
  automation-engine set passes (gateway: 83/83), so the default
  (non-injected) `buildGateway()` paths are unchanged.
