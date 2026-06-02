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

- [x] Plugin imports and mounts buildGateway().composedHandler; no hand-rolled store/runtime/route graph remains
- [x] @centraid/worktree-store and @mariozechner/pi-ai removed from the plugin package.json
- [x] automation-host.ts, automations-cron.ts, automations-provider.ts deleted
- [x] Cron runs via InProcessScheduler, started only from gateway_start (single-process invariant)
- [x] Chat + ctx.agent + ctx.tool behavior unchanged (in-process surfaces retained)
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

### Plugin gutted onto `buildGateway()` + `composedHandler` (Plane A)

`packages/openclaw-plugin/src/index.ts` no longer constructs a
`WorktreeStore`, DB providers, the `UserStore` / `AnalyticsStore` /
`ChatHistoryStore`, or the `Runtime`. `register()` now calls
`buildGateway({ appsStoreRoot, lazyStoreInit, … })` once per process and
mounts the returned `gw.composedHandler` on the three gateway-auth prefixes
(`/centraid`, `/_centraid-chat`, `/_centraid-user`) — the handler replays
`chatHistory → userStore → extraHandlers[] → runtime.handle` minus the
bearer check, for a host that owns auth. `gw.start('')` is driven from
`gateway_start`; bootstrap, git-store registry sync, and the cron scheduler
all run inside it. The plugin no longer names the git store, the DB
providers, or the `Runtime`.

### Cron switched to `InProcessScheduler` (Plane C)

The plugin no longer registers OpenClaw native cron jobs. `buildGateway()`
owns a single in-process `InProcessScheduler` that fires enabled cron
automations on a minute-boundary timer, started only from `gw.start()` —
i.e. only in the HTTP-serving process — preserving the single-process
invariant even though OpenClaw runs `register()` in multiple worker
subprocesses. `lazyStoreInit` keeps the concurrent git-store `init()` off
those workers; construction stays cheap, so it is safe in every process and
gives the worker's `centraid_*` tools a live runtime.

This let three files be deleted: `automation-host.ts` (the adapter onto
OpenClaw's `cron.add/update/remove`), `automations-cron.ts` (the OpenClaw
cron wire format + `centraid:<ref>:N` job-name mangling), and
`automations-provider.ts` (the `centraid-mock` provider whose StreamFn
recovered the dispatch from a `<<<centraid:…>>>` sentinel prompt). The
`@mariozechner/pi-ai` dependency died with the mock provider, and
`@centraid/worktree-store` dropped out now that the plugin never names the
git store; `@centraid/gateway` was added.

### In-process Plane B retained via injection

The plugin injects the three execution seams above so chat, runner-status,
and automation fires still run in OpenClaw's process: `chatRunner` →
`makeOpenClawChatRunner` (`runEmbeddedAgent`); `runnerStatus` →
`{ kind: 'openclaw', ok: true }`; `fireAutomationFactory` →
`runOpenclawFire` (`ctx.tool` → `callGatewayTool`, `ctx.agent` →
simple-completion), shared by the cron scheduler and the run-now route.
`runOpenclawFire` itself is kept as-is for Phase 1. The plugin-owned
`/_centraid-hook` webhook route (not part of `composedHandler`) resolves
live app code through `gw.codeAppsDir()`. `registerCentraidTools` now takes
a `Promise<Runtime>` and resolves it lazily on first tool call, since the
runtime is built asynchronously and the tools run in worker subprocesses.

## Out of scope

- **Phase 2 — Plane B orchestrator refactor.** Extracting the shared
  automation-run orchestrator (ledger + analytics + `runAutomationHandler`)
  parameterized by injected dispatchers, and collapsing `openclaw-fire.ts`
  onto it. Phase 1 keeps `openclaw-fire.ts` whole and injects it through
  `fireAutomationFactory`.
- **Live run streaming for OpenClaw automation fires.** The gateway's
  run-event bus (issue #158) is not wired to `runOpenclawFire`; OpenClaw
  automation runs are recorded in the ledger but do not stream live. This
  is folded into the Phase 2 orchestrator dedup.
- **Host inversion** (`/acp spawn openclaw`): explicitly deferred — centraid
  stays an in-process OpenClaw plugin.

## Verification

- **Typecheck** — `bunx turbo run typecheck` is green across all 19
  workspace packages, including `@centraid/desktop` (which consumes
  `serve()`/`buildGateway()`) and `@centraid/openclaw-plugin`. The new
  `buildGateway()` options are all optional, so desktop + daemon call sites
  compile unchanged.
- **Tests** — `bunx turbo run test` for the gateway / app-engine /
  automation-engine / openclaw-plugin set passes (gateway: 83/83), so the
  default (non-injected) `buildGateway()` paths are byte-for-byte unchanged.
- **Plugin imports and mounts buildGateway().composedHandler; no hand-rolled store/runtime/route graph remains** — verified by reading `index.ts`: no `new WorktreeStore`, no `new Runtime`, no store/provider construction; `composedHandler` is mounted on the gateway-auth prefixes.
- **@centraid/worktree-store and @mariozechner/pi-ai removed from the plugin package.json** — verified in `packages/openclaw-plugin/package.json`; `@centraid/gateway` added; `grep` finds no remaining references in `src/`.
- **automation-host.ts, automations-cron.ts, automations-provider.ts deleted** — removed via `git rm`; no dangling imports remain (`grep` clean).
- **Cron runs via InProcessScheduler, started only from gateway_start (single-process invariant)** — the plugin no longer touches OpenClaw cron; the scheduler is `buildGateway()`'s and `scheduler.start()` runs only inside `gw.start()`, which the plugin drives from `gateway_start` (the only event firing in the HTTP-serving process). `lazyStoreInit` keeps git-store `init()` off the worker subprocesses.
- **Chat + ctx.agent + ctx.tool behavior unchanged (in-process surfaces retained)** — chat still runs through `makeOpenClawChatRunner` (`runEmbeddedAgent`), and automation fires still run through `runOpenclawFire` (`ctx.tool` → `callGatewayTool`, `ctx.agent` → simple-completion); both are injected into `buildGateway()` rather than reconstructed.
