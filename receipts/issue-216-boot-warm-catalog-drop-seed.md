# issue-216 — Boot-warm the model & tool catalog, delete the seed, show a loading state

GitHub issue: [#216](https://github.com/srikanth235/centraid/issues/216)

The chat/agent model picker was seeded by a hardcoded table
(`packages/agent-runtime/src/models/defaults.ts`) — which both lied (the `codex`
branch named concrete model ids that drift) and was load-bearing because models,
unlike tools, were never warmed on boot. This change deletes the seed, unifies
model + tool enumeration behind one `CatalogWarmer` that boot and Refresh both
drive fire-and-forget, and surfaces a per-surface `loading | ready | empty`
tri-state so the picker shows a loading placeholder before the first warm
completes (and an empty state when a runner reports nothing) instead of a
fabricated default.

## Checklist

- [x] Delete the hardcoded model seed
- [x] Add a unified CatalogWarmer that warms models and tools
- [x] Boot-warm both surfaces in the background
- [x] Surface a per-surface loading/ready/empty tri-state
- [x] Show a loading and empty state in the model picker
- [x] Tests, typecheck, and lint pass

## What changed

### Delete the hardcoded model seed

Removed `packages/agent-runtime/src/models/defaults.ts` (`DEFAULT_MODELS` /
`defaultModelsFor`) entirely, along with its exports from the package barrel and
its use in `preflight.ts` and `build-gateway.ts`. This also retires the only
`no-hardcoded-model-ids` governance waiver in production source. `catalog.ts`
collapses to pure storage: a new `readRunnerModels` mirrors the existing
`readRunnerTools`, and both `resolveRunnerModels` / `resolveRunnerTools`
(read-or-enumerate) are gone — reads never enumerate.

### Add a unified CatalogWarmer that warms models and tools

New `packages/agent-runtime/src/models/catalog-warmer.ts`: `CatalogWarmer` is the
single owner of enumeration for both surfaces and both runners. `warm(kind,
surface)` dedupes concurrent calls via an in-flight map, runs the injected
enumerator best-effort, and merge-writes the catalog only on a non-empty result
(an empty result never clobbers a prior good entry). `deriveStatus(len, warming)`
produces the tri-state (loading wins, so an in-flight refresh still polls). The
gateway constructs one shared instance and routes the agents-status resolvers and
the runner-status reporter through it.

### Boot-warm both surfaces in the background

`build-gateway.ts` `start()` previously warmed only tools on boot; it now loops
over `{codex, claude-code} × {models, tools}` through the shared warmer,
background and non-blocking, gated on `probeCliAvailability`. A cold status read
also kicks a warm (ensure-warm), so the loading state self-heals without a manual
Refresh.

### Surface a per-surface loading/ready/empty tri-state

Added `SurfaceStatus` to `@centraid/app-engine` (re-exported from agent-runtime),
`modelsStatus` on `RunnerStatus`, and four `*ModelsStatus` / `*ToolsStatus` fields
on the agents-status response. The resolver contract changed to return
`{ list, status }`; a throwing resolver degrades to `{ list: [], status: 'empty' }`.

### Show a loading and empty state in the model picker

The desktop composer picker (`app-chat.ts`) renders pulsing "Discovering models…"
dots while loading-with-no-cache, a muted empty state otherwise, and keeps Send
enabled throughout (a turn with no pin runs on the runner's built-in default). It
polls runner-status while `loading` (800 ms, 30 s cap). Settings → Agents
(`app.ts`) mirrors this for both agents and switches its Refresh buttons to
fire-and-forget + poll instead of blanking the panel. New CSS reuses the existing
`cd-pulse` keyframe and runner accent — no new animations.

## Out of scope

- **OpenClaw boot warm.** OpenClaw is not in the boot-warm set; its models warm
  lazily on the first active-runner status read (it never had a seed). A dedicated
  OpenClaw boot probe is deferred to the OpenClaw re-platform.
- **Splitting `build-gateway.ts`.** The file remains over the size cap under its
  existing waiver; the route-handler extraction is tracked separately.
- **Tier classification of enumerated models.** Unchanged — the warmer persists
  whatever the runner reports.

## Verification

Tests, typecheck, and lint pass across every touched package:

- **Tests** green across the touched packages: agent-runtime (60, incl. the new
  `catalog-warmer.test.ts` covering dedupe, never-clobber, the merge-write, and
  the `deriveStatus` truth table; rewritten `catalog.test.ts`; updated
  `preflight.test.ts`), gateway (121, incl. the `{ list, status }` resolver
  reshape in `agents-routes.test.ts`), and app-engine (312).
- **Typecheck, and lint** clean: `tsc -p tsconfig.test.json` for app-engine,
  agent-runtime, gateway, and the desktop renderer; `oxlint` reports 0 errors over
  every changed source and test file.
- **Manual (deferred to review):** cold-boot shows "Discovering models…" then
  auto-resolves without clicking Refresh; an absent CLI shows the empty state with
  Send still working; Refresh-over-a-list keeps the list visible and swaps in the
  fresh one. These need a running gateway + real CLIs and were not run here.
