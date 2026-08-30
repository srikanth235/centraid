# Mobile boot-condition integration tier

The middle tier of the app × state grid ([#890](https://github.com/srikanth235/centraid/issues/890) W3).

## What this is

Seven suites — one per app state in [`tests/matrix.json`](../matrix.json)`#appStates.states` — that boot a **real gateway process** (`serve()`, auto-founded Personal vault, the eight bundled system apps installed with their manifest scopes granted at install) and a **real native replica session** (`createNativeReplicaSession` over the repo's `node:sqlite` stand-in for op-sqlite), arrange each state as a boot condition, and assert **what the session reports**.

## Why it exists

The grid already had two owners and a hole between them.

- **Component tier** — `packages/blueprints/apps/<app>/states.test.tsx` renders whichever state it is handed. It proves the drawing, never the producing.
- **Device tier** — the Maestro journeys under [`tests/agent-e2e-mobile`](../agent-e2e-mobile/README.md). It proves the native wiring, once, and it is the most expensive evidence this repo buys: a simulator minute on a macOS runner costs roughly **600× a vitest second on Linux**, so state variety cannot live there. Multiply seven states by eight apps on a device and the nightly stops being a nightly.

Nothing in between proved that a real session against a real gateway _produces_ those states. Five cells were literal `gap`s in the matrix (`docs.stale`, `people.offline`, `people.stale`, `people.conflict`, `photos.stale`). This tier is where state variety belongs: cheap, deterministic, on Linux, with no device and no network.

## What it may claim

- That a real gateway plus a real replica session **reaches** each state: an empty bootstrapped library, a durable queued intent with its optimistic overlay, a refused socket that still serves the replica, a cursor genuinely behind the gateway's, the gateway's own base-version conflict with both version numbers, a `confirm: true` command parked for the owner, and a revoked app's permanent refusal.
- That each of those is caused by its arrangement. Every test carries a **negative** half through the same session and the same drain — a second row nobody touched, a second write on a live transport, the same read after a row really lands. A suite whose positive half passes on its own proves only that the session always says one thing.

## What it may not claim

- **Nothing about rendering.** No component is mounted. Whether the pending sheet, the stale banner or the conflict copy draws correctly stays with the component tier.
- **Nothing about the SSE feed.** The injected change feed never emits; every suite advances the session with `pullNow()`, which is the same coordinator path a feed frame triggers. That a live frame _wakes_ the pull is a device claim.
- **Nothing about op-sqlite.** The driver is `NodeSqliteDriver` — the same SQL, no native module. FlashList measurement, gestures, background tasks, real airplane mode and the native module load all remain device claims.
- **Nothing about timing.** No budget is measured here; the perf and scale lanes own that.

## Running it

```sh
node node_modules/vitest/vitest.mjs run --config tests/integration-mobile/vitest.config.ts
```

`packages/server` (and its dependencies) must be built first — the suites import `serve()` from source, and it reaches `@centraid/server/engine` through `dist`:

```sh
bun run build
```

Files run one at a time (`fileParallelism: false`): each boots its own gateway and vault on disk. Every temp directory is removed by the test kit's `tempDir()` and every gateway is closed in `afterAll`/`afterEach`. Whole-suite wall clock is about **two minutes** on a Linux dev host.

## The grid, as this tier covers it

`✓` covered, `—` not reachable here (skipped with the reason in the test title).

| App    | dayone | pending | offline | stale | conflict | parked | denied |
| ------ | ------ | ------- | ------- | ----- | -------- | ------ | ------ |
| agenda | ✓      | ✓       | ✓       | ✓     | ✓        | ✓      | ✓      |
| docs   | ✓      | ✓       | ✓       | ✓     | ✓        | —      | ✓      |
| locker | ✓      | ✓       | ✓       | ✓     | ✓        | ✓      | ✓      |
| notes  | ✓      | ✓       | ✓       | ✓     | ✓        | —      | ✓      |
| people | ✓      | ✓       | ✓       | ✓     | ✓        | ✓      | ✓      |
| photos | ✓      | ✓       | ✓       | ✓     | ✓        | —      | ✓      |
| tally  | ✓      | ✓       | ✓       | ✓     | ✓        | ✓      | ✓      |
| tasks  | ✓      | ✓       | ✓       | ✓     | ✓        | —      | ✓      |

### The four cells this tier does not cover, and why

`docs.parked`, `notes.parked`, `photos.parked`, `tasks.parked`. A park is the vault holding a command that carries `confirm: true` (`packages/vault/src/gateway/gateway.ts`). Only nineteen commands in the vault carry it, and none of them is reachable from any action those four apps ship:

- **docs** — the `core.*_document` and `core.*_folder` families carry none.
- **notes** — the `knowledge.*` family carries none.
- **photos** — `media.forget_person` is the only parking media command, and no bundled Photos action calls it.
- **tasks** — schedule's parking commands are all event-shaped; none of `schedule.*_task` carries one.

Those cells stay with the component tier, which is an honest owner for them: the apps genuinely design a parked state and genuinely render it, but _this_ tier cannot be the one that produces it. They are `it.skip`ped with that reason in the title rather than passed on an invented outcome. The fix is a product change (an action of those apps routing to a confirm-required command), not a test change — so do not "close" them here by faking a park.

## How the enumeration stays honest

Each suite reads `packages/blueprints/apps/*/app.json` **at run time** and iterates the apps whose `states.designed` contains its state. A ninth bundled app, or an app that newly declares a state, is therefore enumerated the moment its manifest says so. A manifest that declares a state with neither an arrangement nor a stated blocker **fails the suite** (`enumerate()` throws) rather than being skipped, and a manifest that declares a state this tier has never heard of fails the same way.

## Layout

| File | Purpose |
| --- | --- |
| `vitest.config.ts` | the `@centraid/mobile-integration` project, on `nodeProject` from the test kit |
| `lib/manifests.ts` | reads the shipped app manifests; the enumeration source |
| `lib/gateway.ts` | boots one real `serve()` gateway; the online action door; a dead loopback port |
| `lib/seat.ts` | one real native replica session, with a transport that can be cut and restored |
| `lib/apps.ts` | per-app recipes over shipped action ids, and the stated blockers |
| `lib/parking.ts` | computes which apps can park at all, from the vault registry and the apps' own handlers |
| `lib/boot-conditions.ts` | enumeration, seeding, and the read-shaped arrangements (dayone, offline, stale) |
| `lib/write-conditions.ts` | the write-shaped arrangements (pending, conflict, parked, denied) |
| `<state>.integration.test.ts` | the seven suites |

`boot-conditions.ts` and `write-conditions.ts` are one tier split by the repo's 500-line file cap, not by a boundary in the design; the write half imports `seedRow`, `enumerate` and the status helpers from the read half.
