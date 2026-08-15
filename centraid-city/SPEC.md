# Centraid City — an explorable 3D model of how Centraid works

Inspired by PGSimCity (https://nikolays.github.io/PGSimCity/): an isometric/orbitable 3D city rendered with three.js where each district is a subsystem of the Centraid gateway, animated particles show data flowing between them, a HUD shows live simulated stats, buildings are clickable with an inspector panel, and a guided tour walks a user message end-to-end.

**Static bundle. Vite build. No runtime network.** The package owns its `three` runtime dependency in `package.json`; Vite bundles `three` and `three/addons/controls/OrbitControls.js` into the static output. Source is organized like PGSimCity: shared contracts/content in `src/core`, the renderer-independent simulation in `src/sim`, Three.js geography/geometry in `src/world`, browser UI in `src/ui`, and the bootstrap in `src/main.ts`.

## Files

- `index.html` — all CSS and UI overlay DOM (HUD, console, inspector, contents panel, chapter card, loading screen)
- `src/core/content.ts` — ALL text content + city data (schema below). Written by the content author. UI/engine must not hardcode copy.
- `src/core/types.ts` — typed contracts shared across package boundaries.
- `src/main.ts` — bootstrap and interaction loop.
- `src/sim/sim.ts` — renderer-independent simulation loop and scenario effects.
- `src/world/` — scene, geography, landmark kit, buildings, roads, and particle flows.
- `src/ui/ui.ts` — HUD, inspector, tour, minimap, and loading/toast surfaces.

## What Centraid is (ground truth for the model)

Centraid is a personal, local-first **superapp**: one shell wrapping many first-party apps. One always-on **gateway** per user (host-agnostic core; run by the desktop app as a detached child, or as a standalone daemon). Everything lives in **vaults** — per-vault SQLite databases (`vault.db`, WAL mode) holding an ontology (star-schema around `core_party`), a journal, app data, FTS5 search index, and sealed columns. Runtime model: **conversation ⊃ turn ⊃ item** (never "chat"). Clients (Electron desktop, web PWA, Expo mobile) talk to the gateway over HTTP/SSE; mobile pairs over an **iroh** p2p tunnel and keeps **offline replicas** synced via WAL segment shipping. Harnesses (Claude Code et al.) run via **ACP**; their tool calls (`vault_sql`, `vault_invoke`, `vault_content`) pass a **consent gateway** — dangerous actions get **parked** until the user approves. The eight bundled apps ship as **blueprints** (Locker, Tally, People, Photos, Agenda…) — first-party React routes inside the shell, on a shared design system; there is no builder and no third-party app plane. An **automation engine** runs triggers (cron with IANA timezones, data triggers) deterministically, zero-token where possible. Blobs live in a local **CAS** (content-addressed, 16 MiB chunks, zstd) with lazy S3 offload for the bounded storage tier; **backups** are snapshots to pluggable providers.

## City geography (single source of truth in `src/core/content.ts`)

Ground plane ≈ 240×240 units, origin center. Districts are raised colored plates with a label:

| district id | name | position | role |
| --- | --- | --- | --- |
| `clients` | Client Approach | front (south) | 3 device towers: Desktop, Web PWA, Mobile; emit request particles |
| `gateway` | Gateway Plaza | center | central hall: HTTP/SSE front desk, router, vault registry |
| `runtime` | Harness Runtime Row | center-west | harness buildings + the Conversation Ledger hall (conversation⊃turn⊃item) |
| `consent` | Consent Gate | between runtime and vault | checkpoint arch; parked-automation parking lot beside it |
| `vault` | Vault Excavation | center-north (a dug-out pit) | vault.db slabs: ontology star (core_party hub + spokes), journal, FTS tower, sealed columns vault |
| `wal` | WAL Works | flanking the vault, amber | write-ahead log conveyor, checkpointer, segment shipper |
| `apps` | App Blueprint Quarter | east | small app buildings: Locker, Tally, People, Photos, Agenda, + construction crane (automation clone + compile) |
| `automation` | Automation Yard | west | cron clock tower, trigger sheds, deterministic assembly line |
| `cas` | Blob CAS Warehouse | north-east | chunk containers, zstd press, lazy S3 crane + departing cloud barge |
| `sync` | Sync Harbor | north-west | iroh tunnel bridge to a detached island of paired devices (mobile replicas as "standbys"), relay lighthouse |
| `backup` | Backup Vaults | far north | snapshot bunkers |

Color semantics (also used by particles): requests cyan `#39c5ea`, harness/turn activity blue `#5b7cfa`, WAL amber `#f5a623`, dirty/unsynced red `#e5484d`, consent violet `#8e4ec6`, sync/replicated green `#30a46c`, blobs slate `#8d9aa5`, automation gold `#ad8b00`.

## Simulation (all client-side, deterministic-ish random)

A tick loop (~10 Hz logic, 60 fps render) drives:

- Client towers emit request particles → gateway → route to runtime/apps/vault.
- Harness turns: a harness lights up, streams item particles into the Conversation Ledger, emits tool-call particles that pass the Consent Gate → vault. Occasionally a call gets **parked** (violet particle diverts to the parking lot; pending-approvals counter rises; later approved).
- Every vault write emits an amber WAL particle onto the conveyor; checkpointer pulses periodically; segment shipper sends green segments over the sync bridge to the replica island and to backup bunkers.
- Replica island has a **replication lag** gauge; when "mobile offline" scenario runs, lag grows red, then catch-up floods green particles.
- Photos/blob imports: slate particles into CAS, periodic S3 barge departure.
- Cron tower hand ticks; on fire, automation shed lights and runs a zero-token assembly.

HUD stats (top bar, updating live): turns/s, items appended/s, WAL KiB/s, pending approvals, replica lag (s), CAS occupancy %, next cron in Xs. Plus FPS.

## UI chrome (match PGSimCity's structure, Centraid's identity)

- Loading screen with playful staged messages (from `src/core/content.ts`), then reveal.
- Top HUD bar: logo "Centraid City", subtitle "a working model of the Centraid gateway", stats row, Day/Night toggle, sound-less (no audio), quality toggle optional.
- **Inspector** (right panel): click any building/district → name, subsystem, what it does, "in the real code" pointer (package path), current sim state.
- **Contents + chapters**: one Contents panel lists every chapter (`src/core/content.ts`), grouped by each chapter's `section`. Picking a row moves the camera, shows a card, and pins the chapter's `scenarioId`; Next/Prev/Close and `#<chapter-id>` deep links all work the same way. The walkthrough section starts at Client Approach with "a message leaves the desktop app…"; the scenarios section carries one chapter per entry in `content.scenarios` (`steady`, `first-run` (vault founding), `harness-builds-app` (crane animates in apps quarter), `photo-flood` (CAS pressure), `offline-mobile` (lag grows then catch-up), `multi-device`, `automation-storm`, `consent-parking`) — sim implements the effects. There is no separate scenario bar; chapters are the only navigation.
- Minimap (bottom-left, 2D canvas of district plates + camera frustum dot) — nice-to-have.
- Legal footnote: "Centraid City is an illustrative model; details simplified."

## `content.ts` schema (contract between agents — do not change shape)

```ts
export const meta = { title, subtitle, legal, loadingMessages: [/* 6-8 strings */] };
export const palette = { requests, harness, wal, dirty, consent, sync, blob, automation };
export const districts = [ { id, name, blurb, color, plate: {x, z, w, d},
  buildings: [ { id, name, kind /* tower|hall|slab|shed|arch|crane|bridge|tank|bunker */,
    pos: {x, z}, size: {w, h, d}, blurb, detail /* 2-4 sentences, accurate */,
    codeRef /* e.g. "packages/gateway/src/…" */ } ] } ];
export const tour = [ { id, section /* "walkthrough" | "scenarios" */, title,
  districtId, buildingId?, scenarioId?, body /* 3-5 sentences */ } ];
export const scenarios = [ { id, name, blurb } ];
export const hudStats = [ { id, label, unit } ];
```

Engine reads geometry ONLY from `src/core/content.ts` (positions/sizes), so the content author owns the city plan; the engine owns rendering, animation, flows, camera, picking, and the sim.

## Quality bar

- 60 fps on an M-series laptop: merged/instanced geometry where easy, few materials, no shadows beyond one directional light + soft ambient; fog for depth; subtle emissive windows at night.
- Visually rich: beveled plates, varied building silhouettes, window textures via canvas, animated particle flows along curved paths, pulsing activity lights, day/night sky gradient.
- No console errors. Works in Chrome. Resizes cleanly. Raycast picking with hover outline.
