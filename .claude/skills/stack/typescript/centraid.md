# Static sites (Astro / JS) in Centraid

Repository tooling is written in Rust (`crates/xtask`), not TypeScript or Bun; see [../toolchain.md](../toolchain.md). JavaScript and Astro remain **only** for the two static web sites: `scripts/docs-site` and `scripts/home-site`.

## Workflow and done criteria

```sh
bun install --frozen-lockfile
bun run docs:build
bun run docs:smoke
cargo xtask design --check
```

The gate's `sites` step runs `bun install --frozen-lockfile && bun run docs:build && bun run docs:smoke` in `nightly` and `release`, and in `pr` whenever `docs/**`, `contracts/schema/**`, or `scripts/*-site/**` changed.

## Site constraints

- **Tokens have one source: `design/tokens.toml`.** Hardcoded hex or `rgb()`, a parallel CSS variable, or a literal `font-family` override in a site's CSS all cause drift across the shells and the two web sites. Use `var(--...)` from the `centraid-tokens.css` sheet `cargo xtask design` generates. After a token edit run `cargo xtask design` and commit the regenerated files; `cargo xtask design --check` lints the sites' authored files for font CDNs, literal `font-family`, retired `paper`/`night` theme names, and unresolved `var()` references.
- **Themes are `light` and `dark`.** The sites key on `[data-theme='dark']` (no attribute follows the system). Write an inline theme override only when the member chose one and remove it otherwise.
- **One page and one face.** The sites and the shells share `--bg` / `colors.bg`. Every role is Instrument Sans; `--t-mono` is tabular figures, not monospace; `--font-code` is only for code, an inline literal, or a path.
- **No tooling packages.** `package.json` holds only `astro`, `jsdom`, and `pagefind` for the sites. Do not add `oxfmt`, `oxlint`, `vitest`, or `typescript`.
