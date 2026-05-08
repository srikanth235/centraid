# AGENTS.md

Map of the durable docs an agent (or human) should read before working in this repo. Start at the constitution; everything else is a pointer.

## What this repo is

Centraid is a personal app builder shipped as two surfaces — an Electron desktop app under [`apps/desktop`](apps/desktop) and an Expo mobile app under [`apps/mobile`](apps/mobile). Both surfaces share visual identity through [`packages/design-tokens`](packages/design-tokens) and per-runtime TypeScript settings through [`packages/tsconfig`](packages/tsconfig). The full layout, build orchestration, and design-token sharing model live in [ARCHITECTURE.md](ARCHITECTURE.md).

The runtime stack is [Bun](https://bun.sh) (package manager + runtime, pinned in `packageManager`), [Turborepo](https://turbo.build) (task graph), and TypeScript. Linting and formatting are [oxlint](https://oxc.rs) and [oxfmt](https://github.com/oxc-project/oxfmt). See [README.md](README.md) for the develop / build / check commands.

## Conventions agents should know

- **Conventional Commits.** Commit messages match `<type>(scope)?!?: subject`.
