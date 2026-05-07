# Architecture

## Overview

Centraid is a personal app builder shipped as two end-user surfaces backed by a shared design vocabulary:

- A desktop app (`apps/desktop`) built on Electron with a vanilla-TypeScript renderer.
- A mobile app (`apps/mobile`) built on Expo, targeting iOS, Android, and the web.
- A shared `@centraid/design-tokens` package that owns the cross-surface look and feel.
- A shared `@centraid/tsconfig` package that owns the per-runtime TypeScript configurations.

The monorepo is orchestrated by [Turborepo](https://turbo.build) and run end-to-end on [Bun](https://bun.sh) (`packageManager` pinned at the root). Linting and formatting use [oxlint](https://oxc.rs/docs/guide/usage/linter) and [oxfmt](https://github.com/oxc-project/oxfmt); type checking uses TypeScript per workspace.

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

## Governance overlay

Independent of the product code, the repo carries a governance-kit installation:

- `CONSTITUTION.md` — the directive set every change must satisfy.
- `.governance/` — directive folders + the runner.
- `.githooks/` — generated dispatchers wired into `core.hooksPath`.
- `.github/workflows/governance.yml` — CI backstop that re-enforces the directives.
- `COSTS.md`, `QUALITY.md`, `STEERING.md` — durable ledgers for agent-token spend, open quality issues, and human steering events.

The governance overlay does not couple to bun / turbo; it runs in pure bash and python (`uv`) so the directive suite is not tied to the project's runtime choices.
