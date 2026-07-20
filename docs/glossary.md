# Glossary

Authoritative product vocabulary. Prefer these terms in code, docs, commits, and review. When a concept has a canonical type, the pointer is listed.

## Runtime model (never "chat" for the ledger)

| Term | Meaning | Code |
| --- | --- | --- |
| **conversation** | Durable thread. Single-kind: `kind ∈ {chat, build, automation}`. | `packages/app-engine/src/conversation/schema.ts`; tables in `gateway-db.ts` |
| **turn** | One execution under a conversation (`conversation_id` NOT NULL, FK, CASCADE). One reply round for chat; one compile/fire / `ctx.agent` round for automation. | same |
| **item** | Ordered trace element under a turn. `kind ∈ {message_in, step, tool, agent}`. Inbound is `message_in` ordinal 0. | same |
| **run_summary** | Derived VIEW over the ledger for Insights — not a separate write path. | `packages/app-engine/src/stores/gateway-db.ts` |

There is **no `run` layer** and no `run_nodes` table (collapsed in #190). Automation is a conversation whose other side is a deterministic script; its transcript is the same ledger.

### Forbidden synonyms (runtime model)

| Avoid | Use instead | Why |
| --- | --- | --- |
| "chat" for the ledger / schema | **conversation** / **turn** / **item** | Chat is one `conversation.kind`, not the model name |
| "session" for durable agent history | **conversation** | Session often means runner scratch or HTTP session |
| "message" as the unit of agent work | **item** (or `message_in` item) | Messages are one item kind |
| "run" / "run node" as a ledger layer | **turn** / **item** | Pre-#190 vocabulary |
| "thread" as a table name | **conversation** | Informal synonym only |

"Chat" remains fine in **UI copy** ("Ask your vault") and when `conversation.kind === 'chat'`.

## Core product nouns

| Term | Meaning | Code |
| --- | --- | --- |
| **vault** | Sovereign personal ontology for one owner. Unit of custody: `vault.db` + `journal.db` (+ apps/, code/, …). | `packages/vault`; on-disk under `vault/<vaultId>/` |
| **gateway** | Host-agnostic backend that mounts vaults, serves HTTP, runs automation and agent turns. Same core embedded or as `centraid-gateway` daemon. | `packages/gateway` — `buildGateway()`, `serve()` |
| **app** | Installed projection over the vault. Code serves from the release (UI blueprints) or cloned automation sources. Declared handlers in `app.json`. | `packages/app-engine`, `packages/blueprints` |
| **blueprint** | Shipped template: UI app under `packages/blueprints/apps/` (install-in-place) or automation under `automations/` (clone). | `packages/blueprints` |
| **automation** | Headless conversation + manifest + handler that fires on schedule, webhook, condition, or vault data change. | `packages/automation` |
| **handler** | Declared query (read) or action (write) in `app.json`, validated by Ajv, run in a worker with `ctx.vault`. | `packages/app-engine/src/handlers/` |
| **consent / grant** | Owner-signed permission for an app or device to touch vault scopes. | `packages/vault` consent gateway |
| **journal** | `journal.db` — audit/receipt stream **and** conversation ledger bands. | vault package + app-engine `gateway-db.ts` |
| **replica** | Consent-scoped, read-mostly device copy; intents for offline writes; gateway is sole canonical writer. | `packages/vault` replica schema; `packages/client/src/replica/` |
| **pairing** | One-time ticket ceremony that enrolls a device key to a vault over the tunnel. | `packages/gateway` pairing/enrollment stores; `packages/tunnel` |
| **tunnel / relay** | Iroh QUIC device path; browsers are relay-only (no UDP). | `packages/tunnel`, `packages/data-plane` |
| **CAS / custody** | Content-addressed blob store; local-only vs remote-primary lifecycle. | `packages/vault` blob; backup package |
| **skill** | Agent grounding unit (`SKILL.md`) loaded by the agent runtime. | `packages/skills` |
| **design tokens** | Shared colors, type, spacing, icons across desktop/web/mobile. | `packages/design-tokens` |
| **receipt** | (1) Vault write receipt id from consent pipeline; (2) repo `receipts/issue-N-*.md` for issue work. | context-dependent |
| **prefs** | Device-level gateway prefs (`prefs.json`) — runner, theme, etc. Not the vault owner identity. | `GatewayPaths.prefsFile` |

## Hosts and clients

| Term | Meaning |
| --- | --- |
| **desktop** | Electron host; embeds or (policy H1) supervises the local gateway; thin React renderer. `apps/desktop` |
| **web / PWA** | Installable Vite client; no embedded gateway; HTTP or ticket-only Iroh/WASM. `apps/web` |
| **mobile** | Expo client; HTTP/tunnel to a gateway; native Photos/Docs/Agenda over replica. `apps/mobile` |
| **client package** | Shared React shell + browser-safe HTTP. `packages/client` |
| **daemon** | Standalone `centraid-gateway` process under a `dataDir`. |

## Forbidden / discouraged synonyms (broader)

| Avoid | Prefer |
| --- | --- |
| "database" for the personal ontology | **vault** (`vault.db` is the file) |
| "server" for the product backend | **gateway** |
| "template app" after install | **app** (blueprint is the shipped source) |
| "plugin" for declared handlers | **handler** / **query** / **action** |
| "identity.sqlite" / multi-user gateway identity | vault owner *is* the user (#280) |
| `com.centraid.*` identifiers | **`dev.centraid.*`** ([identifiers.md](identifiers.md)) |

## Related

- Runtime model detail: [ARCHITECTURE.md](../ARCHITECTURE.md)
- Identifier table: [identifiers.md](identifiers.md)
- Decisions: [decisions.md](decisions.md)
