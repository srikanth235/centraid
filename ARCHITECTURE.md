# Architecture

## Overview

Centraid is personal software over a sovereign vault. Its backend is a single host-agnostic **gateway** (`@centraid/gateway`) that wires together the vault plane, the app engine, the agent runtime, and the chat/automation runners against injected paths and secrets. It never reaches for Electron APIs or env conventions itself — the host supplies absolute paths. That gateway runs two ways from the same code:

- **Embedded** in the Electron desktop's main process (`apps/desktop`). The renderer is a **thin client** that talks to the embedded gateway over HTTP with a Bearer token; Electron IPC is reserved for genuinely native operations (token storage, keychain, reveal-in-Finder, gateway lifecycle).
- **Standalone** as the `centraid-gateway` daemon (a bin shipped by `@centraid/gateway`), serving the same HTTP surface under a config-file `dataDir`.

`serve()` boots a gateway and fronts it with a loopback HTTP listener plus Bearer auth; `buildGateway()` constructs the same host-agnostic graph without a socket. The mobile app (`apps/mobile`, Expo) embeds no gateway — it connects to one over HTTP. `@centraid/design-tokens` and `@centraid/tsconfig` are the cross-surface shared packages.

The monorepo is orchestrated by [Turborepo](https://turbo.build) and run on [Bun](https://bun.sh) (`packageManager` pinned at the root). Linting and formatting use [oxlint](https://oxc.rs/docs/guide/usage/linter) and [oxfmt](https://github.com/oxc-project/oxfmt); type checking is TypeScript per workspace; tests run on [vitest](https://vitest.dev) with v8 coverage.

## Runtime model: `conversation ⊃ turn ⊃ item`

Centraid's first principle is that **everything is agentic chat** — automation is a conversation whose other side is a deterministic script instead of a person, and whose transcript is durable. A chat window, an automation, and a builder session are each a single-kind conversation, recorded in one ledger (the conversation-ledger band of the per-vault `journal.db` — the old per-app `runtime.sqlite` and central `analytics.sqlite` became a per-vault `transcripts.db` in #280, then folded into `journal.db` as a second band beside its audit stream). The vocabulary, per `packages/app-engine/src/conversation/schema.ts` and `packages/app-engine/src/stores/gateway-db.ts`:

| Layer            | What it is                                                                 | Chat                   | Automation                       |
| ---------------- | ------------------------------------------------------------------------- | ---------------------- | -------------------------------- |
| **conversation** | the durable thread. `kind` ∈ `{chat, build, automation}` lives here.       | the chat session       | each fire is its own conversation, tagged with the automation ref |
| **turn**         | one execution under it — `conversation_id` is a NOT-NULL, FK'd, CASCADE spine | one reply round | one fire / `ctx.agent` round     |
| **item**         | the ordered trace. `kind` ∈ `{message_in, step, tool, agent}`             | inbound message + steps + tool calls | inbound trigger + steps + tool/agent calls |

`kind` lives on the **conversation**, not re-stamped per turn — a thread is single-kind. The inbound message (a person typing, a webhook firing, a cron tick) is a first-class `item` (`kind='message_in'`, ordinal 0); `step` is one primary model-inference call (per-call token + cost accounting); `tool`/`agent` are per-call audit rows. Attachments ride the `message_in` item, content-addressed on disk. The tables are `conversations`, `turns`, `items`, `attachments`, `automation_state`, `run_summary` (see `TRANSCRIPTS_MIGRATIONS` in `gateway-db.ts`). There is no `run` layer and no `run_nodes` table — those were collapsed in issue #190.

## Tool surface: declared handlers + the vault register

An app declares **queries** (bounded reads) and **actions** (typed writes) in its `app.json`; the dispatcher (`packages/app-engine/src/handlers/dispatcher.ts`) validates input against the per-handler JSON Schema with Ajv, then runs the handler in a worker thread. The handler holds no database — every data touch goes through `ctx.vault`, crosses to the host, walks the consent pipeline, and comes back `executed` / `denied` / `parked` with a receipt id (issue #286 deleted the per-app `data.sqlite`, the `_sql` escape hatch, and the old `centraid_describe`/`centraid_read`/`centraid_write` tool trio). Agents see exactly one tool family — the **vault register**: `vault_sql` (one read-only statement over the whole vault), `vault_invoke` (one typed command, including every app's declared handlers), `vault_content` (the text of one document). UI buttons and `vault_invoke` land on the same handler — one calling convention. See the Apps § agents and Data § assistant docs at `https://centraid.dev/docs/apps/#agents` and `https://centraid.dev/docs/data/#assistant`.

## Workspace layout

```
.
├── apps/
│   ├── desktop/                   # @centraid/desktop — Electron main + preload + vanilla-TS renderer; embeds the gateway
│   └── mobile/                    # @centraid/mobile — Expo; HTTP client to a gateway
├── packages/
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

`@centraid/app-engine` is the foundation (depends only on `ajv`), and `@centraid/vault` stands beside it with no workspace dependencies — the gateway is where the two meet (handlers reach the vault through an injected `ctx.vault` bridge, never a package import). `@centraid/automation` builds on app-engine + blueprints; `@centraid/agent-runtime` on app-engine + automation; `@centraid/gateway` on app-engine + agent-runtime + automation + blueprints + skills + vault. The desktop app depends on gateway + agent-runtime + app-engine + automation + design-tokens + tunnel. Both apps share `@centraid/design-tokens` (mobile resolves it from `src` for React Native).

## On-disk layout

Each gateway host derives its own paths and passes absolute slots to the gateway (it never derives them itself — see `packages/gateway/src/paths.ts`):

- **Desktop embed**: every gateway gets a subtree at `<userData>/gateways/<id>/` (the local gateway has the fixed id `local`). Issue #280 made the **vault the unit**: everything personal lives inside `vault/<vaultId>/` — the sovereign pair (`vault.db` + `journal.db`, the journal carrying both the audit stream and the conversation ledger + run rollup), per-app workspace dirs (`apps/`), the app **code** store (`code/` — a bare git repo + worktrees, issue #137), and chat-runner scratch (`runner-sessions/`). What remains at the gateway level is plumbing: `prefs.json` (the old `identity.sqlite` is gone — the vault owner *is* the user), the model catalog, and the template cache. The vault's sealing key lives in a `keys/` sibling, deliberately outside backup scope.
- **Daemon**: the same tree under the config `dataDir` — `vault/`, `prefs.json`, `model-catalog.json` — plus daemon-only plumbing: a persistent `token.bin` (mode 0600) and the device-pairing files (`devices.json`, `pairing-tickets.json`, `endpoint-key.bin`, `endpoint.json`; issue #289). See `packages/gateway/src/cli/paths.ts`.

App-engine owns the conversation-ledger band of the per-vault `journal.db` (`packages/app-engine/src/stores/gateway-db.ts`): conversations, turns, items, attachments, automation KV, and the `run_summary` VIEW that feeds Insights — derived from the ledger tables, no write-through (the old per-app `runtime.sqlite` and central `analytics.sqlite` became a standalone `transcripts.db` in #280, then folded into `journal.db`). The band is ensured idempotently on open and never touches `PRAGMA user_version`. The vault package owns its own files' DDL: `vault.db` (all ontology schemas, one ACID boundary) and `journal.db`'s audit band (the append-only receipt/provenance stream, versioned by the vault's ladder).

## Build orchestration

`turbo.json` declares five tasks:

- `build` — depends on upstream `^build`; outputs `dist/**`.
- `dev` — non-cached, persistent; depends on `^build`.
- `typecheck` — depends on `^build` and `^typecheck`.
- `lint` — depends on `^lint`; run via `oxlint .` at the root.
- `test` — depends on `^build` and `build`; per-package `vitest run`.

The desktop app builds the main process (`tsc`), the preload bundle (`bun build`, CommonJS, `electron` external), and copies static renderer assets. The gateway, app-engine, agent-runtime, automation, skills, and blueprints packages each emit `dist/` via `tsc` (blueprints first builds a template manifest). The mobile app delegates dev/build to the Expo CLI.

## Cross-surface design tokens

`@centraid/design-tokens` is the single source of truth for visual + identity decisions that render consistently across desktop and mobile. Both apps depend on it via the workspace protocol, so a token change recompiles both targets through the turbo task graph.
