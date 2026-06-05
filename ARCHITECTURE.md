# Architecture

## Overview

Centraid is a personal app builder. Its backend is a single host-agnostic **gateway** (`@centraid/gateway`) that wires together the app engine, the agent runtime, the SQLite stores, and the chat/automation runners against injected paths and secrets. It never reaches for Electron APIs or env conventions itself — the host supplies absolute paths. That gateway runs three ways from the same code:

- **Embedded** in the Electron desktop's main process (`apps/desktop`). The renderer is a **thin client** that talks to the embedded gateway over HTTP with a Bearer token; Electron IPC is reserved for genuinely native operations (token storage, keychain, reveal-in-Finder, gateway lifecycle).
- **Standalone** as the `centraid-gateway` daemon (a bin shipped by `@centraid/gateway`), serving the same HTTP surface under a config-file `dataDir`.
- **As an OpenClaw plugin** (`@centraid/openclaw-plugin`) that mounts a single `/centraid` prefix on an OpenClaw host and owns auth itself.

`serve()` boots a gateway and fronts it with a loopback HTTP listener plus Bearer auth; `buildGateway()` constructs the same host-agnostic graph without a socket (the OpenClaw plugin mounts that composed handler directly). The mobile app (`apps/mobile`, Expo) embeds no gateway — it connects to one over HTTP. `@centraid/design-tokens` and `@centraid/tsconfig` are the cross-surface shared packages.

The monorepo is orchestrated by [Turborepo](https://turbo.build) and run on [Bun](https://bun.sh) (`packageManager` pinned at the root). Linting and formatting use [oxlint](https://oxc.rs/docs/guide/usage/linter) and [oxfmt](https://github.com/oxc-project/oxfmt); type checking is TypeScript per workspace; tests run on [vitest](https://vitest.dev) with v8 coverage.

## Runtime model: `conversation ⊃ turn ⊃ item`

Centraid's first principle is that **everything is agentic chat** — automation is a conversation whose other side is a deterministic script instead of a person, and whose transcript is durable. A chat window, an automation, and a builder session are each a single-kind conversation, recorded in one ledger (the per-app `runtime.sqlite`). The vocabulary, per `packages/app-engine/src/conversation/schema.ts` and `packages/app-engine/src/stores/gateway-db.ts`:

| Layer            | What it is                                                                 | Chat                   | Automation                       |
| ---------------- | ------------------------------------------------------------------------- | ---------------------- | -------------------------------- |
| **conversation** | the durable thread. `kind` ∈ `{chat, build, automation}` lives here.       | the chat session       | each fire is its own conversation, tagged with the automation ref |
| **turn**         | one execution under it — `conversation_id` is a NOT-NULL, FK'd, CASCADE spine | one reply round | one fire / `ctx.agent` round     |
| **item**         | the ordered trace. `kind` ∈ `{message_in, step, tool, agent}`             | inbound message + steps + tool calls | inbound trigger + steps + tool/agent calls |

`kind` lives on the **conversation**, not re-stamped per turn — a thread is single-kind. The inbound message (a person typing, a webhook firing, a cron tick) is a first-class `item` (`kind='message_in'`, ordinal 0); `step` is one primary model-inference call (per-call token + cost accounting); `tool`/`agent` are per-call audit rows. Attachments ride the `message_in` item, content-addressed on disk. The tables are `conversations`, `turns`, `items`, `attachments`, `automation_state` (see `RUNTIME_MIGRATIONS` in `gateway-db.ts`). There is no `run` layer and no `run_nodes` table — those were collapsed in issue #190.

## Tool surface: the three-tool dispatcher

Every non-chat caller (UI buttons, webhooks, automations) and every agent reaches an app's data through three generic tools — `centraid_describe`, `centraid_read`, `centraid_write` — implemented once in `packages/app-engine/src/handlers/dispatcher.ts`. An app declares **queries** (read-only) and **actions** (writes) in its `app.json`; the dispatcher validates input against the per-handler JSON Schema with Ajv, then runs the handler in a worker thread (or the `_sql` built-in escape hatch). The read/write split is enforced by a governance directive. See `docs/reference/three-tool-dispatcher.mdx`.

## Workspace layout

```
.
├── apps/
│   ├── desktop/                   # @centraid/desktop — Electron main + preload + vanilla-TS renderer; embeds the gateway
│   └── mobile/                    # @centraid/mobile — Expo; HTTP client to a gateway
├── packages/
│   ├── gateway/                   # @centraid/gateway — host-agnostic gateway; centraid-gateway daemon bin
│   ├── app-engine/                # @centraid/app-engine — handler loader, dispatcher, /centraid HTTP surface, stores
│   ├── agent-runtime/             # @centraid/agent-runtime — codex/Claude SDK turn driver; centraid CLI bin
│   ├── automation/                # @centraid/automation — manifest, fire spine, scheduler, webhook ingress
│   ├── blueprints/                # @centraid/blueprints — scaffolders + bundled template gallery
│   ├── skills/                    # @centraid/skills — SKILL.md grounding + dynamic renderers
│   ├── design-tokens/             # @centraid/design-tokens — colors, type, spacing, icons
│   ├── openclaw-plugin/           # @centraid/openclaw-plugin — /centraid prefix on an OpenClaw host
│   └── tsconfig/                  # @centraid/tsconfig — base.json, electron.json, expo.json
├── turbo.json                     # task graph (build / dev / typecheck / lint / test)
└── package.json                   # workspaces, top-level scripts, devDependencies
```

### Dependency shape

`@centraid/app-engine` is the foundation (depends only on `ajv`). `@centraid/automation` builds on app-engine + blueprints; `@centraid/agent-runtime` on app-engine + automation; `@centraid/gateway` on app-engine + agent-runtime + automation + blueprints + skills. `@centraid/openclaw-plugin` depends on the gateway; the desktop app depends on gateway + agent-runtime + app-engine + automation + design-tokens. Both apps share `@centraid/design-tokens` (mobile resolves it from `src` for React Native).

## On-disk layout

Each gateway host derives its own paths and passes absolute slots to the gateway (it never derives them itself — see `packages/gateway/src/paths.ts`):

- **Desktop embed**: every gateway gets a subtree at `<userData>/gateways/<id>/` (the local gateway has the fixed id `local`). App **code** lives in a per-gateway git store (`code-store/`, issue #137); app **data** lives at `apps/<appId>/` (`data.sqlite` + per-app `runtime.sqlite`), outside any worktree so it survives version swaps. Identity (`identity.sqlite`), analytics (`analytics.sqlite`), chat-runner session state, and the template cache are per-gateway siblings.
- **Daemon**: a flat tree under the config `dataDir` — `apps/`, `identity.sqlite`, `analytics.sqlite`, `conversation-runner-sessions/`, `model-catalog.json`, and a persistent `token.bin` (mode 0600). See `packages/gateway/src/cli/paths.ts`.

App-engine owns two SQLite migration ladders (`packages/app-engine/src/stores/gateway-db.ts`): a gateway-scoped identity store (`users`, `user_prefs`) and the per-app `runtime.sqlite` (the conversation ledger above). A third ladder — one `run_summary` row per run — lives in the `insights/` sub-module. The host picks the on-disk filenames: both the desktop and the daemon write the identity store to `identity.sqlite` and the analytics store to `analytics.sqlite` (see the on-disk layout above).

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
