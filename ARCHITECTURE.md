# Architecture

## Overview

Centraid is personal software over a sovereign vault. Its backend is a single host-agnostic **gateway** (`@centraid/gateway`) that wires together the vault plane, the app engine, the agent runtime, and the chat/automation runners against injected paths and secrets. It never reaches for Electron APIs or env conventions itself — the host supplies absolute paths. That gateway runs two ways from the same code:

- **Embedded** in the Electron desktop's main process (`apps/desktop`). The renderer is a **thin client** that talks to the embedded gateway over HTTP with a Bearer token; Electron IPC is reserved for genuinely native operations (token storage, keychain, reveal-in-Finder, gateway lifecycle).
- **Standalone** as the `centraid-gateway` daemon (a bin shipped by `@centraid/gateway`), serving the same HTTP surface under a config-file `dataDir`.

`serve()` boots a gateway and fronts it with a loopback HTTP listener plus Bearer auth; `buildGateway()` constructs the same host-agnostic graph without a socket. The mobile app (`apps/mobile`, Expo) embeds no gateway — it connects to one over HTTP. `@centraid/design-tokens` and `@centraid/tsconfig` are the cross-surface shared packages.

The web app (`apps/web`) is an installable Vite PWA and, like mobile, embeds no backend. It shares the browser-safe React shell in `packages/client` with desktop. It supports two data planes: direct HTTP (the gateway serves the PWA from a dedicated origin and the shell uses an Origin-bound HttpOnly control session), or ticket-only Iroh through an application-specific Rust/WASM client. Browsers have no UDP access, so Iroh/WASM is relay-only. A service-worker bridge carries generated-app documents, assets, and streams over the same tunnel; their one-time app sessions remain vault- and app-scoped, and the tunnel deliberately defers those requests to cookie authorization instead of injecting its broader device bearer.

The monorepo is orchestrated by [Turborepo](https://turbo.build) and run on [Bun](https://bun.sh) (`packageManager` pinned at the root). Linting and formatting use [oxlint](https://oxc.rs/docs/guide/usage/linter) and [oxfmt](https://github.com/oxc-project/oxfmt); type checking is TypeScript per workspace; tests run on [vitest](https://vitest.dev) with v8 coverage.

## Runtime model: `conversation ⊃ turn ⊃ item`

Centraid's first principle is that **everything is agentic chat** — automation is a conversation whose other side is a deterministic script instead of a person, and whose transcript is durable. A chat window, an automation, and a builder session are each a single-kind conversation, recorded in one ledger (the conversation-ledger band of the per-vault `journal.db` — the old per-app `runtime.sqlite` and central `analytics.sqlite` became a per-vault `transcripts.db` in #280, then folded into `journal.db` as a second band beside its audit stream). The vocabulary, per `packages/app-engine/src/conversation/schema.ts` and `packages/app-engine/src/stores/gateway-db.ts`:

| Layer            | What it is                                                                 | Chat                   | Automation                       |
| ---------------- | ------------------------------------------------------------------------- | ---------------------- | -------------------------------- |
| **conversation** | the durable thread. `kind` ∈ `{chat, build, automation}` lives here.       | the chat session       | one long-lived conversation per automation ref |
| **turn**         | one execution under it — `conversation_id` is a NOT-NULL, FK'd, CASCADE spine | one reply round | one headless compile or fire / `ctx.agent` round |
| **item**         | the ordered trace. `kind` ∈ `{message_in, step, tool, agent}`             | inbound message + steps + tool calls | inbound trigger + steps + tool/agent calls |

`kind` lives on the **conversation**, not re-stamped per turn — a thread is single-kind. The inbound message (a person typing, a webhook firing, a cron tick) is a first-class `item` (`kind='message_in'`, ordinal 0); `step` is one primary model-inference call (per-call token + cost accounting); `tool`/`agent` are per-call audit rows. Attachments ride the `message_in` item, content-addressed on disk. The tables are `conversations`, `turns`, `items`, `attachments`, `automation_state`, `run_summary` (see `TRANSCRIPTS_MIGRATIONS` in `gateway-db.ts`). There is no `run` layer and no `run_nodes` table — those were collapsed in issue #190.

## Tool surface: declared handlers + the vault register

An app declares **queries** (bounded reads) and **actions** (typed writes) in its `app.json`; the dispatcher (`packages/app-engine/src/handlers/dispatcher.ts`) validates input against the per-handler JSON Schema with Ajv, then runs the handler in a worker thread. The handler holds no database — every data touch goes through `ctx.vault`, crosses to the host, walks the consent pipeline, and comes back `executed` / `denied` / `parked` with a receipt id (issue #286 deleted the per-app `data.sqlite`, the `_sql` escape hatch, and the old `centraid_describe`/`centraid_read`/`centraid_write` tool trio). Agents see exactly one tool family — the **vault register**: `vault_sql` (one read-only statement over the whole vault), `vault_invoke` (one typed command, including every app's declared handlers), `vault_content` (the text of one document). UI buttons and `vault_invoke` land on the same handler — one calling convention. See the Apps § agents and Data § assistant docs at `https://centraid.dev/docs/apps/#agents` and `https://centraid.dev/docs/data/#assistant`.

## Workspace layout

```
.
├── apps/
│   ├── desktop/                   # @centraid/desktop — Electron host; embeds the gateway
│   ├── web/                       # @centraid/web — installable Vite PWA; HTTP or relay-only Iroh/WASM
│   └── mobile/                    # @centraid/mobile — Expo; HTTP client to a gateway
├── packages/
│   ├── client/                    # @centraid/client — shared React shell + browser-safe HTTP clients
│   ├── gateway/                   # @centraid/gateway — host-agnostic gateway; centraid-gateway daemon bin
│   ├── vault/                     # @centraid/vault — the ontology: vault.db+journal.db DDL, consent gateway, typed commands
│   ├── app-engine/                # @centraid/app-engine — handler loader, dispatcher, /centraid HTTP surface, stores
│   ├── agent-runtime/             # @centraid/agent-runtime — codex/Claude SDK turn driver; centraid CLI bin
│   ├── automation/                # @centraid/automation — manifest, fire spine, scheduler, webhook ingress
│   ├── blueprints/                # @centraid/blueprints — scaffolders + bundled template gallery
│   ├── skills/                    # @centraid/skills — SKILL.md grounding + dynamic renderers
│   ├── tunnel/                    # @centraid/tunnel — iroh QUIC device tunnel + pairing wire protocol
│   ├── design-tokens/             # @centraid/design-tokens — colors, type, spacing, icons
│   └── tsconfig/                  # @centraid/tsconfig — base.json, electron.json, expo.json
├── turbo.json                     # task graph (build / dev / typecheck / lint / test)
└── package.json                   # workspaces, top-level scripts, devDependencies
```

### Dependency shape

`@centraid/app-engine` is the foundation (depends only on `ajv`). `@centraid/backup` is a Node-builtins-only leaf containing both the opaque provider seam and the pure authenticated WAL codecs; `@centraid/vault` depends on that codec surface for capture and otherwise stands beside app-engine. The gateway is where the vault and app engine meet (handlers reach the vault through an injected `ctx.vault` bridge, never an app-engine package import). `@centraid/automation` builds on app-engine + blueprints; `@centraid/agent-runtime` on app-engine + automation; `@centraid/gateway` on app-engine + agent-runtime + automation + backup + blueprints + skills + vault. The desktop app depends on gateway + agent-runtime + app-engine + automation + design-tokens + tunnel. Both apps share `@centraid/design-tokens` (mobile resolves it from `src` for React Native).

## On-disk layout

Each gateway host derives its own paths and passes absolute slots to the gateway (it never derives them itself — see `packages/gateway/src/paths.ts`):

- **Desktop embed**: every gateway gets a subtree at `<userData>/gateways/<id>/` (the local gateway has the fixed id `local`). Issue #280 made the **vault the unit**: everything personal lives inside `vault/<vaultId>/` — the sovereign pair (`vault.db` + `journal.db`, the journal carrying both the audit stream and the conversation ledger + run rollup), per-app workspace dirs (`apps/`), the app **code** store (`code/` — a bare git repo + worktrees, issue #137), and chat-runner scratch (`runner-sessions/`). What remains at the gateway level is plumbing: `prefs.json` (the old `identity.sqlite` is gone — the vault owner *is* the user), the model catalog, and the template cache. The vault's sealing key lives in a `keys/` sibling, deliberately outside backup scope.
- **Daemon**: the same tree under the config `dataDir` — `vault/`, `prefs.json`, `model-catalog.json` — plus daemon-only plumbing: a persistent `token.bin` (mode 0600) and the device-pairing files (`devices.json`, `pairing-tickets.json`, `endpoint-key.bin`, `endpoint.json`; issue #289). See `packages/gateway/src/cli/paths.ts`.

App-engine owns the conversation-ledger band of the per-vault `journal.db` (`packages/app-engine/src/stores/gateway-db.ts`): conversations, turns, items, attachments, automation KV, and the `run_summary` VIEW that feeds Insights — derived from the ledger tables, no write-through (the old per-app `runtime.sqlite` and central `analytics.sqlite` became a standalone `transcripts.db` in #280, then folded into `journal.db`). The band is ensured idempotently on open and never touches `PRAGMA user_version`. The vault package owns its own files' DDL: `vault.db` (all ontology schemas, one ACID boundary) and `journal.db`'s audit band (the append-only receipt/provenance stream, versioned by the vault's ladder).

## Byte custody, backup, and device compute

Attachments use one primary-store seam per vault. With no CAS destination, the gateway filesystem is primary and custody is `local-only`. With own S3 or a provider `cas` grant, the remote is primary: new fallback-door bytes enter a bounded, separately-accounted outbox as `pending-offsite`, drain continuously, and become `replicated`/`remote-only` only after provider verification. The gateway filesystem is then a cache plus transit spool. Admission considers real free space, the outbox budget, active reservations, and reserved WAL/snapshot/journal headroom; pending bytes are never evictable. A snapshot of a remote-primary vault carries only the still-undrained outbox bytes.

There are two byte doors with one custody model. A capable paired device hashes and preflights locally, seals CBSF v2 frames with a gateway-issued per-blob key, then uploads ciphertext through per-object presigned URLs; multipart receipts are durable and the gateway HEAD- and AEAD-verifies the object before accepting the metadata claim. The Expo bridge schedules sealed parts with native background transfers so iOS/Android uploads survive WebView suspension. Thin clients and `curl` use the permanent gateway fallback: incremental SHA verification, resumable sessions, bounded framed sealing, durable multipart progress, and temp-to-content-address promotion for stream-through uploads. `casAck: receipt|replicated` changes when the client calls the operation complete, not the transport or claim transaction: provider downtime never rolls back a locally durable receipt.

`BackupPolicy` is the single per-vault owner setting for WAL RPO, snapshot and restore-verification cadence, attachment acknowledgment, cache/outbox/headroom budgets, bandwidth/storage class, and WAL base roll. WAL capture, offsite drain, scheduled snapshot/verify, and 2× health alarms all derive from it. Providers that implement `centraid-storage-provider/1` receive the cadence declaration; rejected policy and echo drift remain visible in health and the Backup screen.

Provider inventory is a safety control as well as a transparency surface. Scheduled reconciliation compares the provider-attested inventory (or a raw bucket LIST fallback) with snapshot/WAL ledgers and the local CAS replica index. A missing remote CAS object synchronously demotes replica evidence before another eviction can trust it; orphans and WAL gaps are surfaced but never auto-deleted. The same persisted report feeds object/byte totals, snapshot history, PITR span, prune/credential events, attestation labels, and the explicit “verify against bucket” action.

Derivative work follows **device-preferred, gateway-backstop** placement. `thumb`, `preview`, `poster`, `text`, `transcript`, `embedding`, and `phash` share one validated contribution registry. Opted-in paired devices advertise capabilities and lease queued work with TTLs only while charging and unmetered; vanished leases re-enter the pool and duplicate contributions are idempotent. Devices hardware-decode video posters and may transcribe/OCR/embed, while the Pi-class gateway only performs bounded raster/text backstops and parse-only MP4/WebM/audio metadata. Video/audio remain progressive Range media—no gateway transcoding, HLS/DASH, or ffmpeg.

## Cron catch-up policy

The gateway's cron scheduler is in-process and intentionally does not backfill
after sleep, restart, or downtime. Missed fire times are skipped rather than
burst-executed; one bounded missed-window ledger entry per affected automation
records the earliest missed fire for operator visibility. The next ordinary
minute resumes normal scheduling. `scheduler-ledger.test.ts` is the executable
contract for this policy.

## Build orchestration

`turbo.json` declares five tasks:

- `build` — depends on upstream `^build`; outputs `dist/**`.
- `dev` — non-cached, persistent; depends on `^build`.
- `typecheck` — depends on `^build` and `^typecheck`.
- `lint` — depends on `^lint`; run via `oxlint .` at the root.
- `test` — depends on `^build` and `build`; per-package `vitest run`.

The desktop app builds its main process, preload bundle, and shared client renderer. The web app builds the same React shell as a service-worker-backed Vite PWA; its checked-in WASM binding is regenerated from `apps/web/iroh-wasm` with `bun run --cwd apps/web build:iroh`. The gateway daemon bundles the static assets and serves them on a dedicated origin. The gateway, app-engine, agent-runtime, automation, skills, and blueprints packages each emit `dist/` via `tsc` (blueprints first builds a template manifest). The mobile app delegates dev/build to the Expo CLI.

## Cross-surface design tokens

`@centraid/design-tokens` is the single source of truth for visual + identity decisions that render consistently across desktop and mobile. Both apps depend on it via the workspace protocol, so a token change recompiles both targets through the turbo task graph.
