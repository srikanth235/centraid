# Centraid

**Personal software. Your data. Your apps. Your devices.**

Describe an app in a sentence — an agent builds it, a local gateway runs it, and it shows up on your desktop and phone. Every app is a thin projection over one **vault** on your machine — a shared personal ontology where your people, money, documents and plans live once, borrowed through grants you sign. App code is a folder of HTML + JS handlers, versioned in a local git store, operable by you or an AI.

[Docs](https://centraid.dev/docs/) · [Get started](https://centraid.dev/docs/start/) · [Architecture](ARCHITECTURE.md) · [Agents map](AGENTS.md)

## What it does

- **Build apps by chatting** — describe a new app or a change; the builder agent edits a draft branch, you preview, **Publish** flips it live.
- **Clone templates** — 8 blueprint apps (Docs, Photos, Notes, People, Locker, Tally, Agenda, Tasks) + 24 automation templates (Gmail pull, Briefing, Email triage, photo captioner, …). Click and deploy, no compile step.
- **Run automations** — cron-, webhook-, condition- or data-change-triggered background agents. A generated handler runs in a worker thread with a curated `ctx` surface (`ctx.vault`, `ctx.agent`, `ctx.fetch`, KV state, run history).
- **Chat with your data** — every app has one `/centraid/<id>/_turn` surface that can rewrite a handler *and* answer a data question in the same conversation; the vault-wide assistant reads across all of them.
- **Run it anywhere** — one gateway core, three hosts: embedded in the Electron desktop, the standalone `centraid-gateway` daemon, or the OpenClaw plugin. Mobile (Expo) is a thin client over an iroh p2p tunnel.
- **Local-first** — the vault is SQLite files on your machine, single Bearer token, consent checked and receipted on every access, nothing leaves your devices unless you point it somewhere.

## How it works (30 seconds)

```
  Electron desktop              Expo mobile
  (renderer = thin client)           │
        │        HTTP + Bearer       │
        ▼                            ▼
 ┌─────────────────── gateway ───────────────────────┐
 │ buildGateway() — same core, three hosts:          │
 │ desktop embed · centraid-gateway daemon · openclaw│
 │                                                   │
 │  app-engine        agent-runtime      automation  │
 │  declared-handler  codex subprocess   cron+webhook│
 │  dispatcher        or Claude SDK      fire spine  │
 │      │             (in-process)            │      │
 │      ▼                                     ▼      │
 │  vault plane: vault.db + journal.db  scheduler    │
 │  (consent-checked commands, receipts)             │
 └───────────────────────────────────────────────────┘
```

- **Apps are folders**: `index.html` + `queries/*.js` + `actions/*.js` + `automations/<id>/` + `app.json`. No migrations and no private database — handlers reach the vault through `ctx.vault` under granted scopes (a declared **ext band** inside `vault.db` covers genuinely app-local tables). Code lives in a per-vault git store; drafts are session branches; Publish fast-forwards `main`.
- **One agent tool family** — the vault register: `vault_sql` (read-only SQL over the whole vault), `vault_invoke` (typed commands, including every app's declared handlers), `vault_content` (document text). UI buttons dispatch to the same handlers `vault_invoke` does — one calling convention.
- **Live data, no plumbing**: every action invalidates the tables it touched and pushes SSE on `/centraid/<id>/_changes`; subscribed iframes re-fetch.

## Get started (60 seconds)

Prereqs: [Bun](https://bun.sh) ≥ 1.3, Node ≥ 24 (built-in `node:sqlite`).

```sh
bun install
bun run dev:desktop    # Electron shell with the local gateway embedded
```

Headless / always-on instead:

```sh
bun run build
centraid-gateway serve --data-dir ./gw-data --host 127.0.0.1 --port 8765
centraid-gateway print-token --data-dir ./gw-data   # Bearer token for clients
```

Mobile companion: `bun run dev:mobile` (Expo dev build), then pair it via Settings → Phone on the desktop (one-time QR).

Full tour: [Get started](https://centraid.dev/docs/start/) — install → vault → first app → phone → always-on, in one page.

## Layout

| Path | What it is |
|---|---|
| `apps/desktop` | Electron shell + vanilla-TS renderer (thin HTTP client). Embeds the gateway in-process. |
| `apps/mobile` | Expo app for iOS / Android / web. Connects to a gateway over HTTP; embeds nothing. |
| `packages/gateway` | Host-agnostic gateway: wires everything below against injected paths/secrets. Ships the `centraid-gateway` daemon. |
| `packages/vault` | The personal ontology: `vault.db` + `journal.db` DDL, consent gateway, typed commands, sealed columns, sync/outbox spine. |
| `packages/app-engine` | Runtime engine: handler loader, declared-handler dispatcher, conversation ledger, `/centraid` HTTP surface. |
| `packages/agent-runtime` | Drives one turn through the codex app-server (JSON-RPC subprocess) or the Claude Agent SDK (in-process); ships the vault-register tools and the `centraid` CLI. |
| `packages/automation` | Manifest schema, fire spine, in-process scheduler, webhook ingress, worker-thread handler runner. |
| `packages/tunnel` | iroh QUIC wire protocol — device tunnel + one-time pairing; the TS reference the Swift/Kotlin mobile ports mirror. |
| `packages/blueprints` | Template gallery: 8 blueprint apps + 24 automation templates, blank-app scaffolders, clone flow. |
| `packages/skills` | Agent grounding: `SKILL.md` units + dynamic renderers (live design tokens, host-tool list). |
| `packages/design-tokens` | Colors, type, spacing, app metadata, icons — shared across desktop and mobile. |
| `packages/openclaw-plugin` | Mounts the `/centraid` prefix on an OpenClaw gateway. |
| `packages/tsconfig` | Shared `base` / `electron` / `expo` tsconfigs. |

## Build / check

Turborepo + Bun. What CI runs is `bun run ci`.

```sh
bun run build          # all apps + packages
bun run test           # per-package vitest (87 test files)
bun run coverage       # repo-wide v8 coverage
bun run typecheck
bun run check          # oxfmt --check + oxlint
bun run lint:types     # type-aware lint
bun run ci             # check + typecheck + lint:types
```

Desktop e2e: 59 Playwright tests across 14 scenario sections, driving the real Electron app against a mock gateway — see [apps/desktop/tests/e2e](apps/desktop/tests/e2e/README.md).

## Documentation

The docs ([centraid.dev/docs](https://centraid.dev/docs/)) are Astro-built static HTML in [`scripts/docs-site`](scripts/docs-site/) — two personas, three pillars:

| | |
|---|---|
| [Start](https://centraid.dev/docs/start/) | Install → vault → first app → pair a phone → always-on → key backup |
| [Data](https://centraid.dev/docs/data/) | The vault, consent & the outbox, sealed columns, connections & sync, automations, the assistant, blobs, search |
| [Apps](https://centraid.dev/docs/apps/) | The eight blueprints, app anatomy, the builder, attach & link, the agent surface, mobile |
| [Devices](https://centraid.dev/docs/devices/) | Star topology, (gateway, vault) addressing, pairing, iroh, desktop & mobile clients, agent runtimes |
| [Ontology](https://centraid.dev/docs/ontology/) | The full logical model — schemas, entity map, ownership matrix, gateway contract, rules |

[AGENTS.md](AGENTS.md) maps the durable docs agents and humans use to orient in this repo.

## License

[MIT](LICENSE).
