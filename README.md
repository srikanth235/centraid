# Centraid

**Personal app builder. Your apps. Your data. Your devices.**

Describe an app in a sentence — an agent builds it, a local gateway runs it, and it shows up on your desktop and phone. Each app is a folder of HTML + JS handlers + its own SQLite, versioned in a local git store, operable by you or an AI.

[Docs](docs/index.mdx) · [Quickstart](docs/quickstart.mdx) · [Architecture](ARCHITECTURE.md) · [Agents map](AGENTS.md)

## What it does

- **Build apps by chatting** — describe a new app or a change; the builder agent edits a draft branch, you preview, **Publish** flips it live.
- **Clone templates** — 3 app templates (Hydrate, Todos, Journal) + 10 automation templates (Briefing, Email triage, PR review digest, …). Click and deploy, no compile step.
- **Run automations** — cron- or webhook-triggered background jobs. A generated handler runs in a worker thread with a curated `ctx` surface (`ctx.tool`, `ctx.agent`, KV state, run history).
- **Chat with your data** — every app has one `/centraid/<id>/_turn` surface that can rewrite a handler *and* answer a data question in the same conversation.
- **Run it anywhere** — one gateway core, three hosts: embedded in the Electron desktop, the standalone `centraid-gateway` daemon, or the OpenClaw plugin. Mobile (Expo) is a thin HTTP client.
- **Local-first** — per-app SQLite on your machine, single Bearer token, nothing leaves your devices unless you point it somewhere.

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
 │  three-tool        codex subprocess   cron+webhook│
 │  dispatcher        or Claude SDK      fire spine  │
 │      │             (in-process)            │      │
 │      ▼                                     ▼      │
 │  per-app data.sqlite + runtime.sqlite  scheduler  │
 └───────────────────────────────────────────────────┘
```

- **Apps are folders**: `index.html` + `queries/*.js` + `actions/*.js` + `migrations/*.sql` + `automations/<id>/` + `app.json`. Code lives in a per-gateway git store; drafts are session branches; Publish fast-forwards `main`.
- **Three generic tools** (`centraid_describe` / `centraid_read` / `centraid_write`) fan out to every app's declared handlers — agents, automations, and the UI share one calling convention.
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

Mobile companion: `bun run dev:mobile` (Expo), then point it at a gateway URL.

Full tour: [Quickstart](docs/quickstart.mdx) — clone Hydrate and watch a write round-trip through the dispatcher and change stream in five minutes.

## Layout

| Path | What it is |
|---|---|
| `apps/desktop` | Electron shell + vanilla-TS renderer (thin HTTP client). Embeds the gateway in-process. |
| `apps/mobile` | Expo app for iOS / Android / web. Connects to a gateway over HTTP; embeds nothing. |
| `packages/gateway` | Host-agnostic gateway: wires everything below against injected paths/secrets. Ships the `centraid-gateway` daemon. |
| `packages/app-engine` | Runtime engine: handler loader, SQLite-backed apps, three-tool dispatcher, conversation ledger, `/centraid` HTTP surface. |
| `packages/agent-runtime` | Drives one turn through the codex app-server (JSON-RPC subprocess) or the Claude Agent SDK (in-process). Ships the `centraid` CLI. |
| `packages/automation` | Manifest schema, fire spine, in-process scheduler, webhook ingress, worker-thread handler runner. |
| `packages/blueprints` | Template gallery: 3 app + 10 automation templates, blank-app scaffolders, clone flow. |
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

| | |
|---|---|
| [Quickstart](docs/quickstart.mdx) | Clone a template, see the round-trip, in five minutes |
| [Concepts](docs/concepts/architecture.mdx) | Gateway, apps, automations, chat, agent runtime, change stream |
| [Build an app](docs/build/app-anatomy.mdx) | File layout, `app.json`, queries, actions, migrations, UI |
| [Automations](docs/automations/index.mdx) | Manifest, triggers, handler contract, webhooks, run history |
| [Templates](docs/templates/index.mdx) | The bundled gallery, cloning, authoring your own |
| [Deploy](docs/deploy/local.mdx) | Desktop embed, standalone daemon, OpenClaw plugin, SQLite layout |
| [Reference](docs/reference/http-api.mdx) | HTTP API, both CLIs, three-tool dispatcher, error codes |

[AGENTS.md](AGENTS.md) maps the durable docs agents and humans use to orient in this repo.

## License

[MIT](LICENSE).
