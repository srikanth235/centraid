# Centraid

Personal app builder. A monorepo containing a desktop app (Electron + vanilla TypeScript), a mobile app (Expo / React Native), and a shared design-tokens package consumed by both surfaces. Build orchestration runs through [Turborepo](https://turbo.build) with [Bun](https://bun.sh) as the package manager and runtime.

## Layout

| Path | What it is |
|---|---|
| `apps/desktop` | `@centraid/desktop` — Electron shell + vanilla-TS renderer. Consumes design tokens. |
| `apps/mobile` | `@centraid/mobile` — Expo app for iOS / Android / web. |
| `packages/design-tokens` | `@centraid/design-tokens` — colors, type, spacing, app metadata, icon paths. Shared across both apps. |
| `packages/tsconfig` | `@centraid/tsconfig` — shared `base`, `electron`, and `expo` tsconfigs. |

## Develop

```sh
bun install
bun run dev:desktop    # turbo run dev --filter=@centraid/desktop
bun run dev:mobile     # turbo run dev --filter=@centraid/mobile
```

## Build / check

```sh
bun run build          # turbo run build (all apps + packages)
bun run typecheck
bun run check          # oxfmt --check + oxlint
bun run ci             # check + typecheck (what CI runs)
```

See [AGENTS.md](AGENTS.md) for the durable-docs map agents and humans use to orient in this repo.

## License

[MIT](LICENSE).
