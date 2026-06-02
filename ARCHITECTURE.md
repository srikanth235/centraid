# Architecture

## Overview

Centraid is a personal app builder shipped as two end-user surfaces backed by a shared design vocabulary:

- A desktop app (`apps/desktop`) built on Electron with a vanilla-TypeScript renderer.
- A mobile app (`apps/mobile`) built on Expo, targeting iOS, Android, and the web.
- A shared `@centraid/design-tokens` package that owns the cross-surface look and feel.
- A shared `@centraid/tsconfig` package that owns the per-runtime TypeScript configurations.

The monorepo is orchestrated by [Turborepo](https://turbo.build) and run end-to-end on [Bun](https://bun.sh) (`packageManager` pinned at the root). Linting and formatting use [oxlint](https://oxc.rs/docs/guide/usage/linter) and [oxfmt](https://github.com/oxc-project/oxfmt); type checking uses TypeScript per workspace.

## Runtime model: `conversation ⊃ run ⊃ turn ⊃ node`

Centraid's first principle is that **everything is agentic chat** — automation is a conversation whose other side is a deterministic script instead of a person, and whose transcript is durable. Chat, automation, and builder iterations are the same object, an agent run, recorded in one ledger. The runtime ledger speaks one cohesive vocabulary:

| Layer            | What it is                                          | Chat                   | Automation                       |
| ---------------- | -------------------------------------------------- | ---------------------- | -------------------------------- |
| **prompt**       | the versioned definition                           | ad-hoc                 | manifest + handler script        |
| **conversation** | the durable container, re-entered by triggers      | the chat session       | the automation (spans its fires) |
| **run**          | one activation (one trigger)                       | one user-message cycle | one fire                         |
| **turn**         | one model exchange / loop round (documented; nodes are flat today) | the reply round | one `ctx.agent` round    |
| **node**         | one recorded trace entry                           | message / tool         | tool / agent / invoke            |

A `Runner` executes one `run`; `ChatRunner` and the automation fire spine are two runners over the same structure. They differ on only three axes — **driver** (person vs script), **trigger** (message vs cron/webhook/manual), and **fan-out** (chat ≈ one turn per run; automation = many). The ledger lives in `@centraid/app-engine` (`runs` ⊃ `run_nodes` tables); `runs.conversation_id` is the polymorphic conversation handle (a chat-session id or an automation id). `ctx.agent` runs one model turn inside the current run.

## Workspace layout

```
.
├── apps/
│   ├── desktop/                   # @centraid/desktop — Electron main + preload + renderer
│   └── mobile/                    # @centraid/mobile — Expo
├── packages/
│   ├── design-tokens/             # @centraid/design-tokens — colors, type, spacing, icons
│   └── tsconfig/                  # @centraid/tsconfig — base.json, electron.json, expo.json
├── turbo.json                     # task graph (build / dev / typecheck / lint)
├── package.json                   # workspaces, top-level scripts, devDependencies
└── bunfig.toml                    # bun-specific configuration
```

## Cross-surface design tokens

`@centraid/design-tokens` is the single source of truth for visual + identity decisions that need to render consistently across surfaces. The package exposes:

- `palette.ts` — color tokens.
- `index.ts` — the public token barrel (type, spacing, app metadata).
- `icons.ts` — icon-path manifests both apps consume.

Both `apps/desktop` and `apps/mobile` depend on the package via the workspace protocol, so a token change recompiles both targets through the turbo task graph.

## Build orchestration

`turbo.json` declares four tasks:

- `build` — depends on upstream `^build`; outputs are emitted to `dist/**`.
- `dev` — non-cached, persistent; depends on upstream `^build` so design-token changes propagate before the app dev server starts.
- `typecheck` — depends on upstream `^build` and `^typecheck`.
- `lint` — depends on upstream `^lint`; run via `oxlint .` at the root.

The desktop app builds the main process (`tsc`), the preload bundle (`bun build`, CommonJS, `electron` external), and copies static assets in three sub-tasks. The mobile app delegates dev / build to the Expo CLI.
