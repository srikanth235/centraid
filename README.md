# Centraid

Personal app builder. A monorepo whose backend is a host-agnostic **gateway** that wires an app engine, an agent runtime, SQLite stores, and chat/automation runners together, and whose front ends are an Electron desktop app and an Expo mobile app. The desktop renderer is a **thin client** — it talks to the gateway over HTTP with a Bearer token. The same gateway runs three ways: embedded in the desktop's Electron main process, as a standalone `centraid-gateway` daemon, and as the `@centraid/openclaw-plugin` mounting a `/centraid` prefix on an OpenClaw host.

Build orchestration runs through [Turborepo](https://turbo.build) with [Bun](https://bun.sh) as the package manager.

## Layout

| Path | What it is |
|---|---|
| `apps/desktop` | `@centraid/desktop` — Electron shell (main + preload) + vanilla-TS renderer. Embeds the gateway in-process; renderer is a thin HTTP client. |
| `apps/mobile` | `@centraid/mobile` — Expo app for iOS / Android / web. Connects to a gateway over HTTP; embeds nothing. |
| `packages/gateway` | `@centraid/gateway` — host-agnostic gateway. Wires app-engine + agent-runtime + stores + chat/automation runners against injected paths/secrets. Ships the `centraid-gateway` daemon bin. |
| `packages/app-engine` | `@centraid/app-engine` — runtime engine: handler loader, SQLite-backed apps, the three-tool dispatcher, and the `/centraid` HTTP surface. Transport-agnostic. |
| `packages/agent-runtime` | `@centraid/agent-runtime` — drives one turn through either the codex app-server (JSON-RPC subprocess) or `@anthropic-ai/claude-agent-sdk` (in-process). Ships the `centraid` CLI bin. |
| `packages/automation` | `@centraid/automation` — automation manifest, fire spine, in-process scheduler, webhook ingress, worker-thread handler runner. Backend-agnostic. |
| `packages/blueprints` | `@centraid/blueprints` — blank-app scaffolders, template clone, and the bundled template gallery (Hydrate, Todos, Journal, automation pack). |
| `packages/skills` | `@centraid/skills` — agent grounding: a `skills/` tree of `SKILL.md` units plus dynamic grounding renderers (live design tokens + host-tool list). |
| `packages/design-tokens` | `@centraid/design-tokens` — colors, type, spacing, app metadata, icon paths. Shared across desktop and mobile. |
| `packages/openclaw-plugin` | `@centraid/openclaw-plugin` — mounts a single `/centraid` prefix on an OpenClaw gateway and dispatches to user apps. |
| `packages/tsconfig` | `@centraid/tsconfig` — shared `base`, `electron`, and `expo` tsconfigs. |

## Develop

```sh
bun install
bun run dev:desktop    # turbo run dev --filter=@centraid/desktop
bun run dev:mobile     # turbo run dev --filter=@centraid/mobile
```

To run the gateway as a standalone daemon (after `bun run build`):

```sh
centraid-gateway serve --data-dir ./gw-data --host 127.0.0.1 --port 8765
```

See [reference/cli](docs/reference/cli.mdx) for both bins (`centraid` and `centraid-gateway`).

## Build / check

```sh
bun run build          # turbo run build (all apps + packages)
bun run test           # turbo run test (per-package vitest)
bun run coverage       # vitest run --coverage (repo-wide v8)
bun run typecheck
bun run check          # oxfmt --check + oxlint
bun run lint:types     # type-aware lint (scripts/lint-types.sh)
bun run ci             # check + typecheck + lint:types (what CI runs)
```

See [AGENTS.md](AGENTS.md) for the durable-docs map agents and humans use to orient in this repo.

## License

[MIT](LICENSE).
