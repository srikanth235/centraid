// governance: allow-repo-hygiene file-size-limit — data, not logic: the city plan and
// every word of copy. Length here is content volume. #704 gives it a schema type.
// Centraid City — content.ts
//
// ALL text content + city geometry for the Centraid City visualization.
// The engine (main.ts / world/world.ts / sim/sim.ts) reads geometry ONLY from this
// file; it does not hardcode copy or coordinates. Schema is fixed by
// SPEC.md — do not change the shape of these exports.
//
// Coordinate convention: ground plane is 240x240 units, origin at the
// center. +x is east, +z is south (so -z is north). Every district
// `plate` is a rectangle CENTERED at (x, z) with total width `w` (along x)
// and depth `d` (along z). Building `pos` is an ABSOLUTE world position
// that falls inside its district's plate bounds.

import type {
  CityDistrict,
  CityMeta,
  HudStat,
  Palette,
  Scenario,
  TourChapter,
} from "./types.js";

export const meta = {
  title: "Centraid City",
  subtitle: "a working model of the Centraid gateway",
  legal: "Centraid City is an illustrative model; details simplified.",
  loadingMessages: [
    "pouring the gateway plaza foundations…",
    "digging the vault excavation…",
    "amber-lining the WAL conveyor…",
    "parking unapproved automations…",
    "stringing the iroh bridge to the replica island…",
    "zstd-pressing a warehouse of blobs…",
    "winding the cron clock tower…",
    "hanging inspector signage on every building…",
  ],
} satisfies CityMeta;

export const palette = {
  requests: "#39c5ea",
  harness: "#5b7cfa",
  wal: "#f5a623",
  dirty: "#e5484d",
  consent: "#8e4ec6",
  sync: "#30a46c",
  blob: "#8d9aa5",
  automation: "#ad8b00",
} satisfies Palette;

export const districts = [
  {
    id: "clients",
    name: "Client Approach",
    blurb:
      "Three front doors, one gateway — desktop, web, and mobile all speak the same HTTP/SSE contract, over a tunnel once paired.",
    color: "#39c5ea",
    plate: { x: 0, z: 95, w: 118, d: 40 },
    buildings: [
      {
        id: "clients-desktop",
        name: "Desktop Tower",
        kind: "tower",
        pos: { x: -34, z: 92 },
        size: { w: 12, h: 11, d: 12 },
        blurb: "Electron shell, spawns the gateway as a detached child.",
        detail:
          "The desktop app is a thin Electron shell around the shared React kit; on launch it spawns (or attaches to) a detached gateway child process rather than embedding the engine in-process. That keeps the gateway alive across renderer reloads and crashes, and is the only supported production topology — in-process gateway wiring is test-only.",
        codeRef: "apps/desktop/src/main/detached-gateway.ts, local-gateway.ts",
      },
      {
        id: "clients-web",
        name: "Web PWA Tower",
        kind: "tower",
        pos: { x: 0, z: 88 },
        size: { w: 12, h: 9, d: 12 },
        blurb:
          "Installable PWA speaking HTTP/SSE — direct, or tunnelled once paired.",
        detail:
          "apps/web is an installable Progressive Web App built on the same browser-safe HTTP client every client shares. It pairs by redeeming the same ticket every other client uses, over an iroh endpoint compiled to WASM and driven from its service worker, then rides the same conversation and turn routes as desktop.",
        codeRef:
          "apps/web/src/web-host.ts, iroh-transport.ts + packages/client/src",
      },
      {
        id: "clients-mobile",
        name: "Mobile Tower",
        kind: "tower",
        pos: { x: 34, z: 92 },
        size: { w: 12, h: 10, d: 12 },
        blurb: "Expo app, pairs over iroh, keeps an offline replica.",
        detail:
          "The Expo mobile app pairs with a gateway over an iroh peer-to-peer tunnel rather than a plain HTTP fetch, so it can reach a home gateway without port-forwarding. It also carries a local SQLite replica so recent vault state is readable — and partially writable — while offline.",
        codeRef:
          "apps/mobile + apps/mobile/modules/centraid-tunnel + packages/client/src/replica/native.ts",
      },
    ],
  },
  {
    id: "gateway",
    name: "Gateway Plaza",
    blurb:
      "One always-on core: the HTTP/SSE front desk, the router, and the vault registry.",
    color: "#39c5ea",
    plate: { x: 0, z: 0, w: 60, d: 55 },
    buildings: [
      {
        id: "gateway-frontdesk",
        name: "Front Desk Hall",
        kind: "hall",
        pos: { x: 0, z: -6 },
        size: { w: 22, h: 9, d: 16 },
        blurb: "The HTTP/SSE server every API request lands on first.",
        detail:
          "One Node HTTP server accepts every API request — REST calls for conversations, turns, and settings, plus long-lived SSE streams for live turn output. It settles the Host check, CORS, and bearer auth, and strips every client-supplied identity header so the gateway can re-stamp device and companion-grant headers from the authenticated enrollment. Static PWA assets are served separately.",
        codeRef: "packages/app-engine/src/http/http-server.ts",
      },
      {
        id: "gateway-router",
        name: "Route Tower",
        kind: "tower",
        pos: { x: -16, z: 12 },
        size: { w: 9, h: 8, d: 9 },
        blurb: "Dispatches to conversation, turn, and blueprint routes.",
        detail:
          "The router fans requests out to conversation routes, turn/SSE routes, the blueprint app bundle server, and prefs — each a focused handler module rather than one sprawling switch. It is host-agnostic: the same router runs identically whether the gateway is a detached desktop child or a standalone daemon.",
        codeRef:
          "packages/gateway/src/serve/build-gateway.ts (composedHandler) + packages/app-engine/src/http/router.ts",
      },
      {
        id: "gateway-vaultregistry",
        name: "Vault Registry",
        kind: "tower",
        pos: { x: 16, z: 12 },
        size: { w: 9, h: 8, d: 9 },
        blurb: "The warm map of every mounted vault plane under this gateway.",
        detail:
          "Each vault is a sovereign 'plane' living in its own directory holding vault.db and journal.db; the registry keeps a warm in-memory map of mounted planes keyed by vault id and resolves the active vault from ambient request context, so two clients on two different vaults never collide.",
        codeRef: "packages/gateway/src/serve/vault-registry.ts",
      },
      {
        id: "gateway-health",
        name: "Health Board",
        kind: "shed",
        pos: { x: 0, z: 20 },
        size: { w: 10, h: 5, d: 7 },
        blurb: "Component health + disk pressure, watched continuously.",
        detail:
          "A health registry tracks 24 named components — the event loop, vaults, disk, the storage limit and quota, connections, the broker, the scheduler, enrichment, vault integrity, backups, and a dozen more like the outbox, the model catalog, and automation runs — and surfaces them to the runtime page so an operator sees a down subsystem before a user does. Twelve are pulled by a probe; the rest report their own failures where they happen. The set is enumerable, which is what lets a test drive every one of them unhealthy.",
        codeRef:
          "packages/gateway/src/serve/health-registry.ts (EXPECTED_HEALTH_COMPONENTS), build-gateway.ts (registerProbe), disk-health.ts",
      },
    ],
  },
  {
    id: "runtime",
    name: "Harness Runtime Row",
    blurb:
      "ACP harnesses execute turns; the Conversation Ledger records every item in order. Optional — plenty of traffic never comes here.",
    color: "#5b7cfa",
    plate: { x: -78, z: 0, w: 64, d: 55 },
    buildings: [
      {
        id: "runtime-ledger",
        name: "Conversation Ledger Hall",
        kind: "hall",
        pos: { x: -78, z: -10 },
        size: { w: 24, h: 8, d: 15 },
        blurb: "conversation ⊃ turn ⊃ item — the ordered spine of everything.",
        detail:
          "Every conversation — typed, automation-fired, or builder — holds turns, and each turn appends an ordered trace of items, starting with the inbound message itself at ordinal 0. This ledger is the spine of everything a harness does. It is not the spine of the whole system: ordinary reads and writes, and device-to-device sync, appear to complete without a turn ever being opened here.",
        codeRef:
          "packages/app-engine/src/stores/gateway-db.ts + packages/app-engine/src/conversation/store-sql.ts",
      },
      {
        id: "runtime-acp1",
        name: "ACP Harness — Claude",
        kind: "tower",
        pos: { x: -100, z: 8 },
        size: { w: 8, h: 9, d: 8 },
        blurb:
          "One ACP harness process per turn, reused warm per conversation.",
        detail:
          "Harnesses run through the Agent Client Protocol: a harness spawns the backing CLI/SDK, streams its output as items, and hands it a per-turn loopback MCP endpoint as its only door back into the vault. Provider-agnostic by design — a dozen-plus harness kinds share this one seam.",
        codeRef: "packages/agent-runtime/src/backends/acp",
      },
      {
        id: "runtime-acp2",
        name: "ACP Harness — Automation",
        kind: "tower",
        pos: { x: -84, z: 20 },
        size: { w: 8, h: 8, d: 8 },
        blurb: "The same harness, fired by cron instead of a person.",
        detail:
          "Automation fires are not a special code path — they are turns on an automation-kind conversation, dispatched through the same harness chat uses, so cost accounting and the item ledger work identically whether a human or a cron tick started the turn.",
        codeRef:
          "packages/automation/src/fire/fire.ts + packages/agent-runtime/src/automation/run-automation-live-dispatch.ts",
      },
      {
        id: "runtime-registry",
        name: "Harness Registry",
        kind: "shed",
        pos: { x: -58, z: 18 },
        size: { w: 9, h: 5, d: 8 },
        blurb:
          "Which harness kinds the runtime can drive, and at what minimum version.",
        detail:
          "Enumerates every ACP harness kind the runtime can drive — around seventeen of them — and the minimum CLI version each has been verified against, so a harness whose event or flag schema has drifted is refused rather than half-driven. What is actually installed on this machine is probed separately, at preflight.",
        codeRef: "packages/agent-runtime/src/registry.ts + preflight.ts",
      },
      {
        id: "runtime-models",
        name: "Model Shed",
        kind: "shed",
        pos: { x: -100, z: 22 },
        size: { w: 8, h: 5, d: 7 },
        blurb: "The model catalog harnesses select from, enumerated live.",
        detail:
          "Holds the model catalog harnesses select from, enumerated live over ACP from what each harness reports rather than baked into a list here, plus the capability-tier indirection — smart, balanced, fast — which so far only the Claude Code harness declares. Pricing and per-turn metering live over in app-engine, not here.",
        codeRef: "packages/agent-runtime/src/models",
      },
    ],
  },
  {
    id: "consent",
    name: "Consent Gate",
    blurb:
      "Every dangerous tool call passes a checkpoint before it touches a vault.",
    color: "#8e4ec6",
    plate: { x: -25, z: -42, w: 54, d: 22 },
    buildings: [
      {
        id: "consent-arch",
        name: "Checkpoint Arch",
        kind: "arch",
        pos: { x: -12, z: -42 },
        size: { w: 10, h: 10, d: 6 },
        blurb:
          "vault_sql / vault_invoke / vault_content all walk through here.",
        detail:
          "Every harness tool call — vault_sql, vault_invoke, vault_content — is checked against the caller's grants before it reaches the vault. A grant names scopes, and each scope carries a verb (read, read+act, act, reveal) plus row filters and a field mask. No grant covering the verb means the call stops here.",
        codeRef:
          "packages/vault/src/gateway/consent.ts, gateway.ts + packages/agent-runtime/src/backends/acp/vault-mcp-server.ts",
      },
      {
        id: "consent-parking",
        name: "Parking Lot",
        kind: "shed",
        pos: { x: -40, z: -36 },
        size: { w: 12, h: 4, d: 9 },
        blurb: "High-risk calls wait here until a human approves them.",
        detail:
          "A high-risk command from a non-owner caller is not executed outright — it parks: a pending-approval row is written and the client's Approvals screen lists it to allow or deny. The harness gets a `parked` outcome to report, not an error to retry, and approving later executes the stored invocation directly rather than resuming the turn.",
        codeRef:
          "packages/vault/src/gateway/gateway.ts + packages/gateway/src/serve/vault-plane.ts (confirmParked)",
      },
      {
        id: "consent-ledger",
        name: "Grant Ledger",
        kind: "slab",
        pos: { x: -10, z: -35 },
        size: { w: 9, h: 3, d: 7 },
        blurb: "Consent decisions are kept as evidence, not deleted.",
        detail:
          "A grant row names who was granted what: an app or a party, a purpose, who granted it, and when it expires. Revoking sets revoked_at and flips the status rather than deleting the row, and narrowing a scope leaves a tombstone recording the verbs, row filter, and field mask that were withdrawn — so what someone could once do stays answerable later. A separate record in the runtime governs whether a conversation may reach a model provider at all; that one is not kept here.",
        codeRef:
          "packages/vault/src/schema/consent.ts (consent_access_grant and consent_scope_tombstone)",
      },
    ],
  },
  {
    id: "vault",
    name: "Vault Excavation",
    blurb:
      "Every user's data lives here: an ontology star, a journal, search, and sealed columns.",
    color: "#39c5ea",
    plate: { x: 0, z: -78, w: 52, d: 38 },
    buildings: [
      {
        id: "vault-core",
        name: "core_party Hub",
        kind: "slab",
        pos: { x: 0, z: -78 },
        size: { w: 12, h: 4, d: 12 },
        blurb: "The star-schema hub every ontology row hangs off.",
        detail:
          "The ontology is a star schema centered on core_party — people, agents, and records all resolve back through it — with typed spoke tables for the rest of the data model. This shape is what lets blueprint apps (Locker, People, Tally…) share one graph instead of siloed per-app databases.",
        codeRef: "packages/vault/src/schema/core.ts",
      },
      {
        id: "vault-journal",
        name: "Journal Slab",
        kind: "slab",
        pos: { x: -14, z: -68 },
        size: { w: 9, h: 3, d: 8 },
        blurb: "The receipt log every gateway-mediated read and write leaves.",
        detail:
          "journal.db records a receipt for every gateway-mediated read and write — hash-not-value where a column is sealed — kept separate from vault.db's live ontology tables. The split is deliberate, but not for deltas: the audit stream grows orders of magnitude faster than the model, and vault.db is the sovereign asset that has to stay small.",
        codeRef:
          "packages/vault/src/schema/journal.ts + packages/vault/src/gateway/evidence.ts",
      },
      {
        id: "vault-fts",
        name: "FTS5 Tower",
        kind: "tower",
        pos: { x: 14, z: -68 },
        size: { w: 8, h: 7, d: 8 },
        blurb: "Full-text search over every text-bearing entity in the vault.",
        detail:
          "One FTS5 shadow table per text-bearing entity — fifteen of them — mirrors searchable content, so both the client search box and harness tool calls get bounded, ranked full-text lookups instead of LIKE scans.",
        codeRef: "packages/vault/src/schema/fts.ts",
      },
      {
        id: "vault-sealed",
        name: "Sealed Columns Vault",
        kind: "slab",
        pos: { x: 0, z: -90 },
        size: { w: 14, h: 5, d: 8 },
        blurb: "Encrypted-at-rest columns for secrets and sealed connections.",
        detail:
          "Certain columns — Locker's secret fields, connector credentials — are sealed: ciphertext at rest under a per-vault key kept in a sibling directory that export and backup deliberately do not move, a placeholder in every default read, revealable only under the `reveal` verb with a per-item receipt, and recorded in the journal as a hash rather than a value.",
        codeRef: "packages/vault/src/schema/sealed.ts",
      },
      {
        id: "vault-spokes",
        name: "Ontology Spoke Yard",
        kind: "shed",
        pos: { x: 16, z: -88 },
        size: { w: 9, h: 3, d: 6 },
        blurb: "Typed spoke tables radiating off the party hub.",
        detail:
          "About a third of the ontology's foreign keys — 57 of 177 REFERENCES clauses — resolve back to core_party; the rest form typed spokes (places, events, connectors, app data) that blueprints read and write through declared handlers rather than raw SQL where possible.",
        codeRef:
          "packages/vault/src/schema/domains-home-business.ts, domains-health-finance-schedule.ts, domains-social-knowledge-media.ts",
      },
    ],
  },
  {
    id: "wal",
    name: "WAL Works",
    blurb:
      "Amber conveyor belts turn every commit into a shippable, checkpointed segment.",
    color: "#f5a623",
    plate: { x: 48, z: -78, w: 28, d: 38 },
    buildings: [
      {
        id: "wal-conveyor",
        name: "WAL Conveyor",
        kind: "shed",
        pos: { x: 48, z: -90 },
        size: { w: 10, h: 4, d: 8 },
        blurb: "vault.db runs in WAL mode; every write lands here first.",
        detail:
          "vault.db is opened in SQLite WAL mode with autocheckpoint disabled, so every commit appends a frame to the write-ahead log instead of touching the main file directly — the conveyor that both the checkpointer and the segment shipper read from.",
        codeRef: "packages/vault/src/db.ts",
      },
      {
        id: "wal-checkpointer",
        name: "Checkpointer",
        kind: "tower",
        pos: { x: 40, z: -76 },
        size: { w: 7, h: 6, d: 7 },
        blurb:
          "Folds WAL frames back into vault.db once the log passes 16 MiB.",
        detail:
          "Nothing checkpoints this database except the WAL shipper, and always with TRUNCATE, so the WAL stays strictly append-only between checkpoints. That is what makes a copy of vault.db safe to take — a foreign checkpoint would backfill frames the shipper never saw, and a database copied mid-checkpoint is silently torn. A real trap this project hit once. The trigger is size, not a timer: a WAL past 16 MiB rolls the group over.",
        codeRef: "packages/vault/src/wal-shipper.ts",
      },
      {
        id: "wal-shipper",
        name: "Segment Shipper",
        kind: "tower",
        pos: { x: 56, z: -68 },
        size: { w: 7, h: 6, d: 7 },
        blurb: "Ships WAL segments to the backup provider.",
        detail:
          "Bundles committed WAL frames into segments and drains them to the backup provider, so a restore lands a bounded number of frames behind the primary vault instead of needing a full copy each time. Device replicas are fed differently, over in the harbor. The shipper reads the log and nothing else — it never asks a harness what to send.",
        codeRef:
          "packages/vault/src/wal-shipper.ts + packages/gateway/src/backup/wal-uploader.ts",
      },
    ],
  },
  {
    id: "apps",
    name: "App Blueprint Quarter",
    blurb:
      "Eight scaffolded apps — Locker, Tally, People, Photos, Agenda, Notes, Tasks, Docs — built on one shared kit.",
    color: "#5b7cfa",
    plate: { x: 94, z: 15, w: 44, d: 70 },
    buildings: [
      {
        id: "apps-locker",
        name: "Locker",
        kind: "hall",
        pos: { x: 82, z: -8 },
        size: { w: 10, h: 6, d: 9 },
        blurb: "Password/secret manager blueprint, autofill and all.",
        detail:
          "Locker is a full-stack blueprint app: sealed secret columns with the title and username left plaintext and searchable, an autofill-safe unlock flow, and a lock that survives a page reload — all rendered on the shared design kit rather than bespoke CSS.",
        codeRef: "packages/blueprints/apps/locker",
      },
      {
        id: "apps-tally",
        name: "Tally",
        kind: "hall",
        pos: { x: 104, z: -6 },
        size: { w: 9, h: 5, d: 8 },
        blurb: "Shared expenses, groups, and who owes whom.",
        detail:
          "Split, settled: a personal expense splitter that tracks shared costs across groups and friends, shows who owes whom, and settles up — sixteen declared actions talking through handlers instead of ad hoc queries.",
        codeRef: "packages/blueprints/apps/tally",
      },
      {
        id: "apps-people",
        name: "People",
        kind: "hall",
        pos: { x: 82, z: 12 },
        size: { w: 10, h: 6, d: 9 },
        blurb: "A personal CRM built directly on core_party.",
        detail:
          "People turns the ontology's core_party hub plus a people_profile spoke into a personal CRM, with lists — renamed from circles once that name collided with the audience mechanism — modeled as SKOS concepts rather than a bespoke tagging table.",
        codeRef: "packages/blueprints/apps/people",
      },
      {
        id: "apps-photos",
        name: "Photos",
        kind: "hall",
        pos: { x: 104, z: 12 },
        size: { w: 9, h: 5, d: 8 },
        blurb: "Imports land in the CAS; this app is just the album view.",
        detail:
          "Photos never owns bytes itself — every image lands in the shared blob CAS keyed by content hash, and this app is a thin album/gallery layer with dedup for free.",
        codeRef:
          "packages/blueprints/apps/photos + packages/vault/src/blob/local.ts",
      },
      {
        id: "apps-agenda",
        name: "Agenda",
        kind: "hall",
        pos: { x: 92, z: 34 },
        size: { w: 11, h: 6, d: 10 },
        blurb: "Calendar, RSVPs, and recurrence on the same ontology.",
        detail:
          "Agenda models events and guests as core_party joins (schedule_attendee), so an RSVP is a relationship in the same graph as everything else, not a separate calendar silo.",
        codeRef: "packages/blueprints/apps/agenda",
      },
      {
        id: "apps-crane",
        name: "Builder Crane",
        kind: "crane",
        pos: { x: 112, z: 40 },
        size: { w: 8, h: 13, d: 8 },
        blurb: "Where a harness scaffolds a brand-new app from a blueprint.",
        detail:
          "When a harness (or a person, via the builder UI) scaffolds a new app, the crane is the visual for that build turn: a blueprint template is copied, wired to declared handlers, and snapshotted into the vault's code store.",
        codeRef:
          "packages/blueprints/src/scaffold.ts, scaffold-files.ts + packages/gateway/src/worktree-store/worktree-store.ts",
      },
    ],
  },
  {
    id: "automation",
    name: "Automation Yard",
    blurb: "Cron and data triggers fire deterministic, zero-token turns.",
    color: "#ad8b00",
    plate: { x: -92, z: 60, w: 52, d: 40 },
    buildings: [
      {
        id: "automation-clock",
        name: "Cron Clock Tower",
        kind: "tower",
        pos: { x: -92, z: 46 },
        size: { w: 9, h: 12, d: 9 },
        blurb: "IANA-timezone cron, with an explicit DST policy.",
        detail:
          "The cron cursor resolves schedules against real IANA timezones through a tiered resolution strategy, with an explicit, tested policy for DST gaps and overlaps rather than leaving them to whatever the host OS does.",
        codeRef:
          "packages/automation/src/cron-timezone.ts + packages/automation/src/fire/cron-cursor.ts, cron-match.ts",
      },
      {
        id: "automation-shed1",
        name: "Data Trigger Shed",
        kind: "shed",
        pos: { x: -110, z: 60 },
        size: { w: 9, h: 5, d: 8 },
        blurb:
          "Fires on a vault row matching a condition, polled on its own gate.",
        detail:
          "Alongside cron, automations can fire on a data condition — a consented vault read polled on the trigger's gate rather than hooked into the write itself, with each matched row hashed whole so it fires once and stays quiet until that row's content changes.",
        codeRef: "packages/automation/src/fire/condition.ts",
      },
      {
        id: "automation-line",
        name: "Deterministic Assembly Line",
        kind: "hall",
        pos: { x: -76, z: 60 },
        size: { w: 14, h: 6, d: 10 },
        blurb: "19 of the 27 bundled automations run with zero model tokens.",
        detail:
          "An automation handler is ordinary JavaScript in a worker thread with five ctx rails — vault, fetch, state, runs, delegate — and only ctx.delegate is billed. Of the 27 bundled automations, 19 never touch it: they run for free and the same way every time. The eight that do are the ones that genuinely need judgment — captioning a photo, extracting text, drafting notes.",
        codeRef:
          "packages/automation/src/handler/runner.ts (delegateDispatcher) + packages/blueprints/automations",
      },
      {
        id: "automation-scheduler",
        name: "Scheduler Ledger",
        kind: "slab",
        pos: { x: -92, z: 76 },
        size: { w: 10, h: 3, d: 7 },
        blurb: "The honest record of what a gateway's downtime cost.",
        detail:
          "The scheduler is in-process and deliberately does not backfill: minutes the timer slept through are skipped, and this ledger is the record of that — one bounded entry per automation per gap, so a restart can say what it missed instead of pretending it missed nothing. Durable trigger positions live separately, in the cursor engine, which is at-least-once.",
        codeRef:
          "packages/automation/src/fire/scheduler-ledger.ts, cursor-engine.ts",
      },
    ],
  },
  {
    id: "cas",
    name: "Blob CAS Warehouse",
    blurb:
      "Content-addressed storage on disk, chunked and compressed only on the way out.",
    color: "#8d9aa5",
    plate: { x: 92, z: -55, w: 48, d: 40 },
    buildings: [
      {
        id: "cas-containers",
        name: "Chunk Containers",
        kind: "tank",
        pos: { x: 78, z: -66 },
        size: { w: 9, h: 7, d: 9 },
        blurb: "Every blob is content-addressed by the sha256 of its bytes.",
        detail:
          "Blob bytes are keyed by the sha256 hash of their content and stored whole on disk under the vault directory, never base64'd into a database column — the same file uploaded twice lands once, for free. Uploads that stream straight through to the remote tier are the ones cut into fixed 16 MiB parts, which is what makes those transfers resumable.",
        codeRef:
          "packages/vault/src/blob/local.ts, custody.ts, stream-ingress.ts",
      },
      {
        id: "cas-press",
        name: "zstd Press",
        kind: "shed",
        pos: { x: 100, z: -66 },
        size: { w: 8, h: 5, d: 8 },
        blurb:
          "Compresses the bytes that leave the machine, not the ones that stay.",
        detail:
          "Compression applies to what ships — sealed remote-tier frames and backup chunk payloads — not to the local tier, which stores raw bytes, and not to WAL segments, which seal raw byte ranges by design. It sits inside encryption, prefers zstd but falls back to deflate where the runtime lacks it, and is entropy-gated and keep-if-smaller, so already-compressed input (a JPEG, a video) travels uncompressed rather than paying to grow.",
        codeRef: "packages/backup/src/compress.ts",
      },
      {
        id: "cas-s3crane",
        name: "Lazy S3 Crane",
        kind: "crane",
        pos: { x: 78, z: -44 },
        size: { w: 8, h: 11, d: 8 },
        blurb:
          "Blobs replicate out through the outbox; the bounded tier evicts under pressure.",
        detail:
          "Replication to S3 runs on the outbox's own schedule, not on how full the disk is. What the threshold actually drives is eviction: once the local spool crosses its budget, the bounded tier sheds previews first and keeps thumbnails pinned — and never evicts a blob whose remote copy is not confirmed.",
        codeRef: "packages/vault/src/blob/cache.ts, evict.ts, outbox-drain.ts",
      },
      {
        id: "cas-barge",
        name: "Departing Cloud Barge",
        kind: "bridge",
        pos: { x: 104, z: -44 },
        size: { w: 12, h: 5, d: 7 },
        blurb: "The offload path leaving the warehouse for object storage.",
        detail:
          "Represents an in-flight offload batch — chunks that have been minted, staged, and are now streaming out to the pluggable object store backing this vault's bounded tier.",
        codeRef: "packages/vault/src/blob/outbox-drain.ts, s3-pipeline.ts",
      },
    ],
  },
  {
    id: "sync",
    name: "Sync Harbor",
    blurb:
      "Where two devices stay one vault: change batches out, device edits back — no harness involved.",
    color: "#30a46c",
    plate: { x: -85, z: -90, w: 64, d: 40 },
    buildings: [
      {
        id: "sync-lighthouse",
        name: "Relay Lighthouse",
        kind: "tower",
        pos: { x: -60, z: -80 },
        size: { w: 8, h: 10, d: 8 },
        blurb:
          "The rendezvous every endpoint is configured with, direct dial or not.",
        detail:
          "iroh endpoints are always configured with the n0 relays and discovery, and upgrade to a direct path when hole-punching succeeds — which is what keeps pairing working across NATs and mismatched networks without needing the gateway exposed publicly. It is pure transport: it forwards the gateway's ordinary HTTP and never consults a harness.",
        codeRef: "packages/tunnel/src/gateway-endpoint.ts, client.ts",
      },
      {
        id: "sync-bridge",
        name: "Iroh Bridge",
        kind: "bridge",
        pos: { x: -73, z: -84 },
        size: { w: 20, h: 5, d: 7 },
        blurb:
          "Two-way: change batches out to the device, the device's local edits back in.",
        detail:
          "Once paired, a device's ordinary HTTP replica requests are forwarded over this iroh tunnel instead of hitting an exposed port. Traffic runs both ways — row-level change batches stream out against an (epoch, seq) cursor, and edits the device made while it was away drain back as intents when it reconnects. Nothing on this bridge passes through the Harness Runtime Row; sync is a gateway/vault concern end to end.",
        codeRef:
          "packages/tunnel/src/protocol.ts + packages/client/src/replica/shell-transport.ts, shell-session.ts, intents.ts",
      },
      {
        id: "sync-island",
        name: "Replica Standby A",
        kind: "slab",
        pos: { x: -108, z: -74 },
        size: { w: 8, h: 3, d: 8 },
        blurb: "A paired device's offline-capable SQLite replica.",
        detail:
          "Each paired device keeps a windowed SQLite replica — WASM over OPFS in the browser, op-sqlite natively on mobile — seeded by an initial bootstrap and kept current by streamed change batches, so recent vault reads, and some writes, work offline. This is how you see the same vault on your laptop and your phone: the batches do it, not a harness.",
        codeRef:
          "packages/client/src/replica/windowed-bootstrap.ts, sqlite-worker.ts, native.ts",
      },
      {
        id: "sync-island2",
        name: "Replica Standby B",
        kind: "slab",
        pos: { x: -100, z: -76 },
        size: { w: 7, h: 3, d: 7 },
        blurb: "A second paired device, syncing independently.",
        detail:
          "Multiple devices can pair to the same vault; each keeps its own replica cursor and reconciles independently, so one device going offline never blocks another's sync. Convergence is server-authoritative rather than merged: an intent carries the base versions it read, and the gateway rejects it as a conflict if the row has moved since. No model judgment anywhere in it.",
        codeRef:
          "packages/gateway/src/routes/replica-intent-route.ts + packages/client/src/replica/store-core.ts",
      },
    ],
  },
  {
    id: "backup",
    name: "Backup Vaults",
    blurb:
      "Snapshots to pluggable providers — local disk today, remote object storage too.",
    color: "#30a46c",
    plate: { x: 0, z: -112, w: 70, d: 16 },
    buildings: [
      {
        id: "backup-bunker1",
        name: "Snapshot Bunker A",
        kind: "bunker",
        pos: { x: -18, z: -112 },
        size: { w: 10, h: 5, d: 9 },
        blurb: "Encrypted, chunked snapshots of the whole vault.",
        detail:
          "A snapshot chunks, encrypts, and manifests the vault's current state through the provider-agnostic backup engine, so restore and verify run identically regardless of which object store is behind it.",
        codeRef: "packages/backup/src/engine.ts",
      },
      {
        id: "backup-bunker2",
        name: "Snapshot Bunker B",
        kind: "bunker",
        pos: { x: 0, z: -109 },
        size: { w: 10, h: 6, d: 8 },
        blurb: "Older generations, retained for point-in-time recovery.",
        detail:
          "Prior snapshot generations are retained rather than overwritten, giving point-in-time recovery instead of just a single latest copy — bounded by whatever retention the provider declares. The local provider keeps everything; a remote one may run a keep-all / daily / weekly ladder, and never prunes the newest.",
        codeRef: "packages/backup/src/provider.ts, local-provider.ts",
      },
      {
        id: "backup-bunker3",
        name: "Recovery Office",
        kind: "bunker",
        pos: { x: 18, z: -112 },
        size: { w: 9, h: 4, d: 8 },
        blurb: "Restore, verify, and the documented recovery runbooks.",
        detail:
          "Houses the restore and verify paths, plus the exact recovery steps this project documents for vault erase, backup, and pairing recovery — because a backup nobody can restore is not a backup.",
        codeRef:
          "packages/backup/src/engine.ts (restoreSnapshot and verifySnapshot) + docs/recovery",
      },
    ],
  },
] satisfies CityDistrict[];

// The book. Chapters carry a `section`: "walkthrough" follows one user message end to
// end, "scenarios" pins the city into one named regime and tells you what to watch.
// Both live in this one array so every chapter mechanism — Prev/Next, dots, Contents
// rows, #<id> deep links, camera focus, scenario pinning — works on all of them.
export const tour = [
  {
    id: "journey-founding",
    section: "walkthrough",
    title: "Before any of this: a vault gets founded",
    districtId: "vault",
    buildingId: "vault-core",
    scenarioId: "first-run",
    pages: [
      {
        body: 'Nothing in this city can happen until a vault exists, and founding one is deliberately not an event you attend. There is no ceremony, no founding ticket, and no first-run wall: a gateway started over a fresh data directory founds itself. It creates two vaults in order — Shared, the household one, then Personal, which carries a durable personal marker and is the default any unscoped request lands in — and then enrols the host\'s own device in a single gateway.db transaction: member label "You", admin on both, because there is no separate owner role, only admin, write, and read. All of that happens synchronously, before any route can observe a gateway with no vaults.',
      },
      {
        body: "That is what you are watching in the First Run pinning. Each new vault is a sovereign directory with its own vault.db and journal.db, so the schema, the ontology tables, and the first core_party rows all have to be written before anything else is possible. Writes run over three times baseline here while conversation traffic drops, because there is genuinely nothing to talk about yet.",
        buildingId: "vault-journal",
        flows: ["appWrite"],
      },
      {
        body: "Note what founding does not put in the vault: keys. Each vault gets its own independent seal key as keys/<vaultId>.sealkey — a sibling of the vault root, one level above the vault directories, deliberately outside what a copy, export, or backup gesture moves, so a lifted directory cannot unseal anything. gateway.db beside it holds gateway state — sealed provider credentials, hashes, the host's own push key — but never a vault's seal key. Sealing is narrow on purpose: a registry of columns such as Locker item fields and connection credentials, extended at runtime by app-declared bands. Ordinary vault rows stay plaintext and are journalled as written; only the sealed columns reach the journal as hashes. Local blobs stay plaintext too — though blobs pushed to the remote tier are sealed before they leave.",
        buildingId: "vault-sealed",
      },
      {
        body: "The guard on all of this is worth knowing because it is the difference between a helpful default and data loss. A data dir that already holds vault directories is never touched, a vault dir that failed to mount still counts as present so corruption cannot look fresh, and a gateway that has ever enrolled a member is treated as inhabited and awaiting restore. Restoring an existing vault onto a blank machine is the backup plane, not founding. One honest simplification: the city marks founding as a scenario of rates and reset gauges, not as its own animated build-out.",
        buildingId: "vault-spokes",
      },
    ],
  },
  {
    id: "chapter-1",
    section: "walkthrough",
    title: "A message leaves the desktop app",
    districtId: "clients",
    buildingId: "clients-desktop",
    scenarioId: "steady",
    pages: [
      {
        body: "Start at the north edge of the city, where the people are. You type a message into the desktop app — the Desktop Tower here on the left. It holds almost no logic of its own: it is a thin Electron shell around the shared React kit, and the gateway it talks to is already running beside it as a detached child process, which is why a renderer reload never takes the engine down with it.",
      },
      {
        body: "Look along the row. The Web PWA Tower is the same shell served as an installable web app, on the same client — which reaches a remote gateway over iroh compiled to WASM rather than a plain fetch. Nothing about your message is desktop-shaped: it is a conversation id, a body, and a vault to address it to. Whichever door you walked through, the request that leaves is identical.",
        buildingId: "clients-web",
        flows: ["request"],
      },
      {
        body: "The Mobile Tower is a separate React Native shell, and it reaches the gateway through a loopback proxy that forwards every request over an iroh tunnel, so a phone can reach a home gateway with no port-forwarding. Once through, it rides the same routes as everyone else. Watch the cyan particle leave the tower now and run south to Gateway Plaza. Three front doors, one line.",
        buildingId: "clients-mobile",
        flows: ["request"],
      },
    ],
  },
  {
    id: "chapter-2",
    section: "walkthrough",
    title: "The gateway takes the request",
    districtId: "gateway",
    buildingId: "gateway-frontdesk",
    pages: [
      {
        body: "Gateway Plaza is the always-on core, and the Front Desk Hall is the Node HTTP server every API request lands on first — REST for conversations and turns, long-lived SSE for streaming output. It settles CORS and auth, and it strips any identity or companion-grant header a client tried to send, so the versions downstream can only be the ones the gateway stamped itself. It is host-agnostic: the same server runs as a desktop child or as a standalone daemon.",
        flows: ["request"],
      },
      {
        body: "Before a route handler runs, the Vault Registry resolves which vault plane this conversation belongs to. A vault is a sovereign directory with its own vault.db and journal.db, kept warm in an in-memory map and selected from ambient request context — so two clients working two different vaults never read each other's rows even though they share this one door.",
        buildingId: "gateway-vaultregistry",
      },
      {
        body: "Now watch the fork at Route Tower, because the shape of it is the most load-bearing thing in the city. Route Tower itself only matches URL prefixes; the fork you see is what that traffic turns out to be. Most requests are ordinary reads and writes: they stay cyan, run straight down to the Vault Excavation, and come straight back out. Only the handful of routes that open a turn go blue and head west into Harness Runtime Row.",
        buildingId: "gateway-router",
        flows: ["directRead", "directResult", "harness"],
      },
      {
        body: "The Health Board keeps score on the parts that can quietly fail — the event loop, disk, connections, the scheduler, backups, and nineteen more — so an operator sees a sick subsystem before a user does. Keep an eye on the Turns readout on the HUD as the plaza works: it stays low while requests pour through. That gap between request rate and turn rate is the architecture, not an idle moment.",
        buildingId: "gateway-health",
        flows: ["request", "response"],
      },
    ],
  },
  {
    id: "chapter-3",
    section: "walkthrough",
    title: "A turn begins",
    districtId: "runtime",
    buildingId: "runtime-ledger",
    pages: [
      {
        body: "Your message was one of the few that needed a model, so the router hands it west to Harness Runtime Row. The first building it reaches is not a harness — it is the Conversation Ledger Hall, because nothing here executes before it is recorded.",
        flows: ["harness"],
      },
      {
        body: "A new turn opens under your conversation, and your message is appended to it as the item at ordinal 0. That is the whole runtime model: conversation ⊃ turn ⊃ item, ordered, and durable the moment an item opens — a long-running item is later closed in place with its result, but nothing already written is rewritten. Everything the harness does next lands in this same trace, which is what makes a turn replayable and costable after the fact rather than only observable while it runs.",
        flows: ["harness"],
      },
      {
        body: "The ledger is not reserved for people. The automation harness on the far side of the row writes into it identically — a cron-fired turn and a typed turn are the same shape, so accounting and replay do not need two code paths. Watch the Items appended figure on the HUD start moving; it climbs several times faster than Turns, because one turn is many items.",
        buildingId: "runtime-acp2",
        flows: ["automation"],
      },
    ],
  },
  {
    id: "chapter-4",
    section: "walkthrough",
    title: "An ACP harness picks it up",
    districtId: "runtime",
    buildingId: "runtime-acp1",
    pages: [
      {
        body: "A harness process spawns and attaches to the open turn. It speaks the Agent Client Protocol: the gateway does not embed a vendor SDK, it drives a backing CLI over a protocol and translates whatever comes back into items.",
        flows: ["harness"],
      },
      {
        body: "Now the blue particles start. Step and tool-call items append to the turn as they arrive and stream out over SSE to the client that opened it — which is why you watch a response assemble rather than wait for a finished one. Mostly the client is reading the write, not a copy of it. The one thing that streams without being written down is the model's reasoning: you see it pass, and then it is gone.",
        flows: ["response"],
      },
      {
        body: "The Model Shed behind the harness holds the catalog it selects from — enumerated live from what each harness reports over ACP rather than baked into a list here — plus a capability-tier indirection, smart or balanced or fast, that so far only one harness declares. What the shed does not hold is pricing: metering a turn happens over in app-engine. That separation is the point of the ACP seam — swapping which model answers you is a registry change, not a rewrite of the runtime.",
        buildingId: "runtime-models",
      },
    ],
  },
  {
    id: "chapter-5",
    section: "walkthrough",
    title: "The harness requests a tool",
    districtId: "runtime",
    buildingId: "runtime-registry",
    pages: [
      {
        body: "The Harness Registry is the shed that decides what a harness is even allowed to be: which harness kinds are installed on this machine, and which minimum version each is pinned to. Whether your words may leave for a model provider is tracked separately, per conversation, by the runtime itself — first use is implicit in your having chosen the surface, and only an unattended run or a switch to a different provider stops to ask.",
      },
      {
        body: "Past that check, the harness decides it needs your data and emits a tool call — vault_sql to query, vault_invoke to run a declared handler, vault_content to reach an attachment. Those three are the whole of what Centraid exposes into the vault. The harness is still a coding CLI with its own file and shell tools inside its working directory, but none of them is a route to your rows: there is no raw connection and no back channel.",
        buildingId: "runtime-acp1",
        flows: ["tool"],
      },
      {
        body: "Watch where the call goes: not south-east to the vault, but south to the Consent Gate, as a violet particle. The harness cannot address the vault directly by construction. Every particle you see leaving this row toward your data is a request for permission first and a query second.",
        flows: ["tool"],
      },
    ],
  },
  {
    id: "chapter-6",
    section: "walkthrough",
    title: "The consent gate",
    districtId: "consent",
    buildingId: "consent-arch",
    scenarioId: "consent-parking",
    pages: [
      {
        body: "The Checkpoint Arch evaluates that violet particle against your standing grants, and the answer is binary: allow, or deny. The nuance is not in the verdict but in the shape of a grant — it names an entity, the verbs permitted on it, a row filter, a field mask, and the purpose the data may be used for. A call is allowed only if it falls inside all of that. Anything else is denied, and the denial is receipted rather than silent.",
        flows: ["tool"],
      },
      {
        body: "Parking is a second gate, past the first. A command the vault declares as needing confirmation veers into the Parking Lot even though a grant already allowed it — the payload is sealed into a row and the entry appears on your Approvals screen. Denials never park; they just stop. This chapter has pinned the city to Consent Parking so you can watch the lot fill: keep an eye on Pending approvals on the HUD, which goes amber past three.",
        buildingId: "consent-parking",
        flows: ["tool"],
      },
      {
        body: "Whatever you decide lands on the grant row itself — the Grant Ledger is those rows, not a separate log beside them. Because each grant carries its own scope, revoking one closes exactly that entity, those verbs, that purpose, and nothing adjacent. And a revoked grant is not deleted: it keeps its row and gains a revoked-at stamp, because the useful question later is who approved what and when, not only what is live right now.",
        buildingId: "consent-ledger",
      },
      {
        body: "The detail that makes this workable is that a parked call carries its whole sealed payload with it. The harness is told it parked and is told not to retry — parked is a final answer to it, not a pause — and it moves on. Your approval later re-runs exactly that call on your own credential, minutes or days afterwards. Nothing waits, and nothing is lost.",
        flows: ["toolPass"],
      },
    ],
  },
  {
    id: "chapter-7",
    section: "walkthrough",
    title: "Approved, the vault is written",
    districtId: "vault",
    buildingId: "vault-core",
    scenarioId: "steady",
    pages: [
      {
        body: "Granted, the call crosses into the Vault Excavation and reaches core_party — the hub of a star schema that people, apps, and records all resolve back through. This is the reason a blueprint app can see data another app wrote: there is one graph down here, not a database per app.",
        flows: ["toolPass"],
      },
      {
        body: "Around the hub sit the typed spoke tables — places, events, connectors, per-app rows — which is where your write actually lands. Blueprints reach them through declared handlers wherever possible rather than raw SQL, so the shape of a write is checked before it is applied.",
        buildingId: "vault-spokes",
        flows: ["appWrite"],
      },
      {
        body: "The same mutation leaves two other traces. A provenance receipt goes into journal.db, deliberately separate from vault.db's live tables — that is what an audit reads to see who did what, under which grant. And a trigger writes a row into vault.db's own replica change log inside the same transaction. Backup ships neither table: it ships the byte-deltas of both files. Sync reads the change log.",
        buildingId: "vault-journal",
        flows: ["wal"],
      },
      {
        body: "One corner of the excavation your harness never saw: the sealed columns. OAuth tokens and connector secrets are encrypted at rest under a key the gateway custodies and are only ever unsealed server-side to complete a call. The harness can cause a connector to be used; it cannot read the credential that makes it work.",
        buildingId: "vault-sealed",
      },
    ],
  },
  {
    id: "chapter-8",
    section: "walkthrough",
    title: "Amber ink hits the WAL",
    districtId: "wal",
    buildingId: "wal-conveyor",
    pages: [
      {
        body: "That commit did not touch vault.db's main file. The database runs in SQLite WAL mode with autocheckpoint disabled, so the write appends a frame to the write-ahead log — the amber particle you just watched drop onto the conveyor. Every mutation in the city becomes an entry on this belt first.",
        flows: ["wal"],
      },
      {
        body: "The Checkpointer folds frames back into the main file; watch for the pulse. In the real gateway the rollover is mostly a size trigger — a WAL past 16 MiB rolls the group over — while the capture tick beside it runs against a recovery-point objective that defaults to sixty seconds. The city pulses far more often than either so you can see it happen. The convention is that only the shipper checkpoints, and always with TRUNCATE, because a foreign checkpoint backfills frames it never saw. That is not enforced, though — it is verified on every capture, and a stray checkpoint breaks the generation and forces a fresh base rather than leaving a hole. A vault.db copied mid-checkpoint is silently torn; that is a trap this project hit for real.",
        buildingId: "wal-checkpointer",
        flows: ["wal"],
      },
      {
        body: "The Segment Shipper reads the same log for a different purpose: it bundles frames into segments that the uploader seals and drains out to backup. Devices ride a different stream entirely — the replica change log back in the vault — so this belt has exactly one consumer, not two. Neither stream asks a harness what to send. From here on, your write travels without a harness anywhere in the loop.",
        buildingId: "wal-shipper",
        flows: ["ship", "backup"],
      },
    ],
  },
  {
    id: "chapter-9",
    section: "walkthrough",
    title: "A trigger fires",
    districtId: "automation",
    buildingId: "automation-shed1",
    scenarioId: "automation-storm",
    pages: [
      {
        body: "Your write matched a data trigger, so the Automation Yard wakes up. Triggers here are not only clocks: the Data Trigger Shed watches a set of entities and polls the vault's consented provenance feed for changes to them, so a row insert or update is a thing an automation can react to. Its sibling, the condition trigger, is the one that carries a predicate. The city has been pinned to Automation Storm so the yard stays lit while you read.",
        flows: ["automation"],
      },
      {
        body: "The gold particles running down the Deterministic Assembly Line are the fire executing. An automation handler is ordinary code, held to determinism by a lint that bans wall clocks, randomness, and raw I/O and routes everything through a fixed context surface. Most handlers never call a model at all, so most fires cost zero tokens and run the same way every time. Only a handler that reaches for judgment reaches for a harness.",
        buildingId: "automation-line",
        flows: ["automation"],
      },
      {
        body: "A data-trigger fire rides a durable cursor: the batch is written before any side effect and acked element by element, so a restart re-runs at most the one element in flight. Cron is deliberately weaker — a minute the scheduler slept through is skipped, never backfilled, and the Scheduler Ledger's job is to record that gap so you can see it. And note where the yard's own writes go — into the vault, onto the amber conveyor, into the same segments as everything else. Automation is a producer of ordinary writes, not a side channel.",
        buildingId: "automation-scheduler",
        flows: ["automationWrite", "wal"],
      },
    ],
  },
  {
    id: "journey-pairing",
    section: "walkthrough",
    title: "How that other device earned the right to be here",
    districtId: "sync",
    buildingId: "sync-lighthouse",
    scenarioId: "multi-device",
    pages: [
      {
        body: "Before any segment can leave for a second device, that device has to be enrolled — and enrollment starts on the gateway host, not on the phone. Any enrolled member can mint a pair ticket for another device of their own, bounded by roles they already hold; only an admin can invite a different person. The ticket is an id plus a 32-byte secret, kept only as a sha256 hash at rest, valid for fifteen minutes. The thing you scan is that pair, base64url-encoded alongside the gateway's own iroh endpoint ticket, so the device knows exactly which gateway it is looking for.",
      },
      {
        body: "There is no code to read aloud and no emoji to match. The authentication is possession of the one-time secret plus the endpoint identity pinned in the ticket, and it is checked in a strict order: expiry first, then a constant-time compare — of sha256 hashes, since the ticket secret is never stored in the clear — so a wrong guess returns before the real ticket is ever consumed. Redemption then burns the ticket and writes the member roles and the device binding in one immediate transaction — a conditional delete that must affect exactly one row is the single-use authority, and any failure rolls all the way back to zero enrollment.",
      },
      {
        body: "Two details make this hard to spoof. The endpoint the gateway records is the one proved by the QUIC handshake itself, never a field the client claimed, and the device derives its iroh endpoint from one stored secret per gateway, using it for pairing and for every later dial to that gateway — so the identity you paired with is the identity you must keep dialling with. The device also does not get to name its own authority: the pair request carries no role and no member, both are baked into the server-minted invitation. Meanwhile the client pins the gateway back, refusing the result if the gateway that answered is not the one named in the ticket.",
        buildingId: "sync-bridge",
        flows: ["devicePush"],
      },
      {
        body: "What a paired device holds afterwards is not a token — it holds an identity. Authentication here is the transport: the tunnel injects the identity headers and supplies the loopback bearer itself, stripping any copy a client tried to send, and admission on every connection is simply whether that endpoint is still enrolled. That is the real gap between a paired device and a plain HTTP client, and it is why revoking a device drops its live connections mid-stream rather than waiting for a token to lapse. Only now is Replica Standby A eligible for the change stream the next chapter sends it.",
        buildingId: "sync-island",
        flows: ["replica"],
      },
    ],
  },
  {
    id: "chapter-10",
    section: "walkthrough",
    title: "Your other device catches up — with no harness at all",
    districtId: "sync",
    buildingId: "sync-bridge",
    scenarioId: "multi-device",
    pages: [
      {
        body: "The green stream leaving the vault for the harbor is your write on its way out — not WAL segments, which go to backup, but rows from the replica change log, projected into the shapes this device is allowed to see. The Iroh Bridge carries them: a peer-to-peer tunnel, not a fetch to a server in the middle. Everything on this bridge is transport; nothing on it consults a harness.",
        flows: ["ship", "replica"],
      },
      {
        body: "Follow the next leg out to Replica Standby A: the harbor delivers those rows to the device, which applies them to a SQLite replica it keeps locally. The window is on the gateway's side — the change log is kept for thirty days, and a device that falls further behind than that re-bootstraps from scratch. Your phone now shows the change, and it can keep showing it with the network gone. Nothing on the device asked a model what to display.",
        buildingId: "sync-island",
        flows: ["replicaDeliver"],
      },
      {
        body: "Now watch the return leg, which is the half people forget. Edits the device made on its own are pushed back across the same tunnel as intents, and the gateway — still the vault's only writer — applies them. Each intent carries the row versions it was based on: replay is idempotent, and a row that moved underneath comes back as a conflict for the device to refresh and retry, never a guess. A second paired device keeps its own cursor and reconciles independently, and the Relay Lighthouse is the rendezvous when a direct dial cannot get through a NAT.",
        buildingId: "sync-island2",
        flows: ["devicePush", "replicaMerge"],
      },
      {
        body: "The loop is closed: ship, deliver, push, merge. Now look west while it runs. The city is pinned to Two Devices, One Vault, which forces every harness-path rate to exactly zero — Harness Runtime Row and the Consent Gate are dark and the Turns and Items appended readouts sit at nothing — while requests, WAL, and the harbor run hot. Device sync is gateway → vault → change log → harbor. The harness is one optional consumer of that spine, not the spine.",
        flows: ["ship", "replicaDeliver", "replicaMerge"],
      },
    ],
  },
  {
    id: "chapter-11",
    section: "walkthrough",
    title: "A quiet backup",
    districtId: "backup",
    buildingId: "backup-bunker1",
    pages: [
      {
        body: "Down at the south wall, on a cadence that has nothing to do with what you just did, the vault is chunked, compressed, encrypted, and manifested into Snapshot Bunker A. Compression prefers zstd and falls back to deflate on a runtime without it, keeping the chunk raw when squeezing it would not help. The engine underneath is provider-agnostic: local disk today, remote object storage under the same interface, with the same conformance tests behind both.",
        flows: ["backup"],
      },
      {
        body: "The neighbouring bunker holds older generations. Snapshots are retained rather than overwritten, which is the difference between point-in-time recovery and a single latest copy that faithfully mirrors a mistake you made an hour ago.",
        buildingId: "backup-bunker2",
        flows: ["backup"],
      },
      {
        body: "The Recovery Office is the part that justifies the rest: restore and verify paths, plus written runbooks for vault erase, backup, and pairing recovery, because a backup nobody has restored is a hypothesis. Count what has happened to your one message — journal receipt, WAL frame, checkpointed main file, change-log row on its way to a device, encrypted snapshot. Five kinds of durable on three separate paths, none of them requiring a harness to be running.",
        buildingId: "backup-bunker3",
        flows: ["backup", "blobBackup"],
      },
    ],
  },

  // --- Scenarios. Each one pins the city into a named regime (scenarioId) and parks the
  // camera where that regime is legible. Copy here describes what the model actually
  // does — if you retune sim.ts, retune these sentences with it.
  {
    id: "scenario-steady",
    section: "scenarios",
    title: "Steady State",
    districtId: "gateway",
    buildingId: "gateway-frontdesk",
    scenarioId: "steady",
    pages: [
      {
        body: "This is the city with nothing scripted happening to it — a household using its own gateway on an ordinary afternoon. Cyan request particles arrive at the Front Desk Hall in a slow swell rather than a flat stream: the arrival rate breathes up and down on a long sine, which is what real household traffic does.",
        flows: ["request"],
      },
      {
        body: "Watch the split at Route Tower. Most of that traffic turns straight around as reads and writes against the vault and never reaches Harness Runtime Row; only a thin blue trickle heads west into a turn. When it does, the consent gate parks roughly one tool call in twenty, which is why Pending approvals hovers near zero instead of building.",
        buildingId: "gateway-router",
        flows: ["directRead", "directResult", "harness"],
      },
      {
        body: "Underneath that, the city keeps three slow clocks: the checkpointer folding WAL frames back into vault.db, the cron tower coming round, and a CAS barge sailing for the cloud. These are the model's cadences, sped up so you can watch them — the real rollover is mostly triggered by WAL size rather than a timer, and cron fires on whatever schedule an automation declares. None of them are reacting to you; they run whether or not anyone is typing.",
        buildingId: "gateway-health",
        flows: ["wal", "automation", "blob"],
      },
      {
        body: "Use this as the baseline for everything that follows. Each of the scenarios below is this same city with one dial turned hard — more blobs, no harness, a faster clock, a stricter gate — so the useful reading is always the difference from here, not the absolute numbers.",
        flows: ["request", "response"],
      },
    ],
  },
  {
    id: "scenario-first-run",
    section: "scenarios",
    title: "First Run",
    districtId: "vault",
    buildingId: "vault-core",
    scenarioId: "first-run",
    pages: [
      {
        body: "A brand-new vault is being founded, so the Vault Excavation is the busiest place in town and almost nothing else is. Writes run more than three times baseline — schema, ontology tables, the first core_party rows — while conversation traffic sits at a third of normal, because there is nothing to talk about yet.",
        flows: ["appWrite"],
      },
      {
        body: "Watch the HUD reset rather than climb. CAS occupancy snaps down to a nearly empty 4%, Pending approvals to zero, replica lag to zero, and the cron period stretches to a full minute once the tower next chimes. This is the only scenario where the gauges start from a floor, and it is worth watching once just to see what an empty vault actually looks like.",
        buildingId: "vault-journal",
        flows: ["wal"],
      },
      {
        body: "The takeaway is the order of operations. The vault plane exists, is journalling, and is already handing frames to the shipper before a single harness turn has ever been opened against it. Founding is a gateway and storage event; the runtime is something you add on top afterwards.",
        flows: ["wal", "ship"],
      },
    ],
  },
  {
    id: "scenario-harness-builds-app",
    section: "scenarios",
    title: "Harness Builds an App",
    districtId: "apps",
    buildingId: "apps-crane",
    scenarioId: "harness-builds-app",
    pages: [
      {
        body: "You have asked the assistant to build you something, and the Builder Crane holds at full swing for as long as this scenario runs. A build is not a special engine — it is an ordinary turn whose tool calls happen to write app code into the vault's code store.",
        flows: ["appReq"],
      },
      {
        body: "The harness path is the loud one here: turns at roughly double baseline, harness particles at two and a half times, and the Apps Quarter working at nearly two and a half times its usual rate as the scaffold is written, served, and rewritten. The finished neighbours around the crane were all built through this same loop.",
        buildingId: "apps-locker",
        flows: ["harness", "appReq", "appWrite"],
      },
      {
        body: "Because a first-time app does first-time things, about one call in six parks instead of one in twenty — a scaffold reaches for the confirm-gated commands far more often than a settled app does. Pending approvals climbs past three into amber and stays there for the run. That is the design working, not a fault: a new app doing consequential things should cost you a decision each time.",
        flows: ["tool"],
      },
      {
        body: "This is the one scenario where the harness, the consent gate, the vault, and the app engine are all hot simultaneously. If you want a single frame that shows the full optional path lit end to end, take it here — and then compare it to Two Devices, One Vault, where the same city runs with that whole path at zero.",
        flows: ["toolPass", "appWrite"],
      },
    ],
  },
  {
    id: "scenario-photo-flood",
    section: "scenarios",
    title: "Photo Flood",
    districtId: "cas",
    buildingId: "cas-containers",
    scenarioId: "photo-flood",
    pages: [
      {
        body: "A phone library is importing, and slate blob particles pour into the Chunk Containers at about six and a half times baseline. Every one of them is keyed by the hash of its content, so the same photo arriving twice lands once — dedup is a property of the address, not a cleanup job.",
        flows: ["blob"],
      },
      {
        body: "The press frames and compresses chunks, but only on the way out to the remote tier — what lands on local disk is the raw bytes. So volume wins: with the flood on, occupancy accumulates far faster than in steady state and rides up past 85%, where CAS occupancy on the HUD goes amber. This is the one gauge in the city that fills rather than flows.",
        buildingId: "cas-press",
        flows: ["blob"],
      },
      {
        body: "That is what the bounded tier is for. The Lazy S3 Crane starts hauling the moment a blob lands — every ingest joins an eager outbox, so uploading is not what waits on the gauge. What the occupancy threshold triggers is eviction, and a chunk is only evicted after it is confirmed replicated remotely — never before. Filling up is a scheduling problem here, not a failure.",
        buildingId: "cas-s3crane",
        flows: ["blobBackup"],
      },
      {
        body: "Watch the barge cadence tighten from twenty-odd seconds to every nine, each sailing dropping occupancy twice as far as usual — the sawtooth you see on the gauge. Meanwhile turns actually fall below baseline. Bytes and rows are separate stories: the blob goes to content-addressed storage, the vault keeps a small reference, and no model is involved in either.",
        buildingId: "cas-barge",
        flows: ["blobBackup", "appWrite"],
      },
    ],
  },
  {
    id: "scenario-offline-mobile",
    section: "scenarios",
    title: "Mobile Goes Offline",
    districtId: "sync",
    buildingId: "sync-island",
    scenarioId: "offline-mobile",
    pages: [
      {
        body: "Your phone has left the network. The delivery leg from harbor to device stops first: green particles stop landing on Replica Standby A and it goes still. The device is not broken — it is reading its own local replica, which is exactly what the replica is for.",
        flows: ["replicaDeliver"],
      },
      {
        body: "For about fourteen seconds the harbor keeps queueing with nowhere to send. Replica lag on the HUD climbs steadily and accelerates as the outage lengthens, crossing six seconds where it turns red. The gateway and the vault do not slow down for any of it: the backlog is the harbor's problem, not theirs.",
        buildingId: "sync-bridge",
        flows: ["ship"],
      },
      {
        body: "Then the device reconnects and the legs invert. Shipping, delivery, and push rates all jump many times over baseline at once, and the backlog floods green across the Iroh Bridge in both directions — segments out to the replica, the device's own offline edits back toward the vault.",
        flows: ["replicaDeliver", "devicePush"],
      },
      {
        body: "Those returning edits are applied by the gateway, each carrying the row versions it was based on so a replay is idempotent and a moved row comes back as a conflict rather than a guess. Lag drains at a fixed rate back to zero over a few seconds before the scenario settles into ordinary sync. Let it run a full cycle before judging it. And note what never moved throughout: Harness Runtime Row took no part in the outage or the recovery.",
        flows: ["replicaMerge"],
      },
    ],
  },
  {
    id: "scenario-multi-device",
    section: "scenarios",
    title: "Two Devices, One Vault",
    districtId: "sync",
    buildingId: "sync-bridge",
    scenarioId: "multi-device",
    pages: [
      {
        body: "A laptop and a phone are both live on the same vault, and neither is talking to an assistant. This scenario forces every harness-path rate to exactly zero and holds the runtime and consent district lights at zero too — so the legs from the gateway to the runtime and on to the gate carry nothing at all while you watch.",
        flows: ["harness", "tool"],
      },
      {
        body: "Everything else runs hot. Requests arrive at more than three times baseline, vault writes at nearly triple, and the harbor at over two and a half times, so the change log feeds the bridge continuously. Follow the first leg: committed rows projected into shapes and out to the harbor.",
        flows: ["ship", "replica"],
      },
      {
        body: "The harbor delivers to each device's replica, and each device pushes its own edits back on the same tunnel. Two paired devices keep independent cursors and reconcile independently, so neither waits on the other. This is the leg people mean when they say the phone and the laptop show the same thing.",
        buildingId: "sync-island",
        flows: ["replicaDeliver", "devicePush"],
      },
      {
        body: "The returning edits are applied by the gateway, which stays the vault's only writer — no model judgment anywhere in the reconciliation, and a stale base version comes back as a conflict rather than a merge. Read the two numbers together: Turns and Items appended sit at nothing while WAL and replica figures stay busy. Device sync is gateway → vault → change log → harbor, and the harness is an optional consumer of that spine, not the spine itself.",
        buildingId: "sync-island2",
        flows: ["replicaMerge"],
      },
    ],
  },
  {
    id: "scenario-automation-storm",
    section: "scenarios",
    title: "Automation Storm",
    districtId: "automation",
    buildingId: "automation-clock",
    scenarioId: "automation-storm",
    pages: [
      {
        body: "The cron clock tower, normally chiming twice a minute, now fires every couple of seconds. Watch Next cron on the HUD sawtooth down and reset almost immediately instead of counting slowly toward thirty. The tower here really is just a countdown; the real one does more, resolving cron triggers against IANA zones so a seven-in-the-morning automation stays at seven across a daylight-saving shift.",
        flows: ["automation"],
      },
      {
        body: "Each strike drives a burst of gold down the Deterministic Assembly Line at several times baseline. None of these handlers reaches for a model — they are lint-bound deterministic code — so the yard can hammer away all day at zero token cost, which is the only reason firing this often is a sane thing to do.",
        buildingId: "automation-line",
        flows: ["automation"],
      },
      {
        body: "Every burst lands as vault writes. A restart mid-storm re-runs at most the element in flight on the data-trigger cursor, and drops whichever cron minutes it slept through — the Scheduler Ledger records those gaps rather than replaying them. Writes run about twice baseline, so the amber WAL conveyor picks up to match — automation's output is indistinguishable downstream from anything you typed.",
        buildingId: "automation-scheduler",
        flows: ["automationWrite", "wal"],
      },
      {
        body: "Meanwhile conversation traffic drops to half normal, and the harness leg stays thin the whole time. If you want to see the automation engine and the harness runtime as genuinely separate machines rather than two names for one thing, this is the scenario that separates them.",
        flows: ["harness"],
      },
    ],
  },
  {
    id: "scenario-consent-parking",
    section: "scenarios",
    title: "Consent Parking",
    districtId: "consent",
    buildingId: "consent-parking",
    scenarioId: "consent-parking",
    pages: [
      {
        body: "Here the gate is stopping almost everything. Roughly half of all tool calls divert violet into the Parking Lot rather than running — a harness reaching for the confirm-gated commands over and over, which is what a genuinely new task looks like. Note they cleared the arch first: these are calls a grant already allows, held back only because the command itself asks you each time.",
        buildingId: "consent-arch",
        flows: ["tool"],
      },
      {
        body: "This scenario also models a slow human: approvals drain at a fraction of their usual pace. Pending approvals climbs quickly past three into amber and then flattens out around a dozen, well short of the queue's ceiling, because the drain rate rises with queue length. A plateau, not a runaway.",
        flows: ["tool"],
      },
      {
        body: "Now look at what the parked calls do downstream. They come back parked rather than executed — a final answer the harness is told not to retry — so the leg from the gate into the vault thins out to match. Fewer calls get through, so fewer rows are written. The city gets quieter in exactly the places the gate is protecting.",
        flows: ["toolPass"],
      },
      {
        body: "That is the whole point: nothing is written on your behalf while it waits for you, and every decision you eventually make is kept on the grant row as evidence rather than applied as a silent state change. A strict gate is only tolerable because the parked call keeps its own sealed payload — approving it later re-runs exactly that call on your credential, so nothing you queued up is work you have to redo.",
        buildingId: "consent-ledger",
      },
    ],
  },
] satisfies TourChapter[];

export const scenarios = [
  {
    id: "steady",
    name: "Steady State",
    blurb: "Background traffic only — the city idling, no scripted event.",
  },
  {
    id: "first-run",
    name: "First Run",
    blurb: "A brand-new vault gets founded: the excavation fills in live.",
  },
  {
    id: "harness-builds-app",
    name: "Harness Builds an App",
    blurb: "The Builder Crane swings into motion, scaffolding a new blueprint.",
  },
  {
    id: "photo-flood",
    name: "Photo Flood",
    blurb: "A big import floods the CAS Warehouse with slate particles.",
  },
  {
    id: "offline-mobile",
    name: "Mobile Goes Offline",
    blurb:
      "Replica lag climbs red on the harbor gauge, then floods green on reconnect.",
  },
  {
    id: "multi-device",
    name: "Two Devices, One Vault",
    blurb:
      "Your laptop and your phone, both live on the same vault. Requests, WAL, and the harbor run hot while Harness Runtime Row sits dark — proof that device sync goes gateway → vault → change log → harbor and never through a harness.",
  },
  {
    id: "automation-storm",
    name: "Automation Storm",
    blurb:
      "A burst of cron and data triggers lights up the Automation Yard at once.",
  },
  {
    id: "consent-parking",
    name: "Consent Parking",
    blurb: "A wave of tool calls back up in the Parking Lot awaiting approval.",
  },
] satisfies Scenario[];

export const hudStats = [
  { id: "turnsPerSec", label: "Turns", unit: "/s" },
  { id: "itemsPerSec", label: "Items appended", unit: "/s" },
  { id: "walKiBPerSec", label: "WAL", unit: "KiB/s" },
  { id: "pendingApprovals", label: "Pending approvals", unit: "" },
  { id: "replicaLag", label: "Replica lag", unit: "s" },
  { id: "casOccupancy", label: "CAS occupancy", unit: "%" },
  { id: "nextCron", label: "Next cron", unit: "s" },
  { id: "fps", label: "FPS", unit: "" },
] satisfies HudStat[];
