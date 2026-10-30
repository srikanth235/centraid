# Issue #1155 — the root files and settings left from the retired JS apps

An audit of the repository root against a repo-wide grep. The public site (Astro, pagefind, `wrangler.json`, `scripts/docs-site`, `scripts/home-site`) is out of scope by the owner's word.

## What changed

- `.env.example`: deleted. Its one variable, `OPENCLAW_GATEWAY_TOKEN`, was read nowhere.
- `package.json` (and `bun.lock`): the `shell-quote` and `tar` overrides are gone, because neither package is in the lockfile. `tinypool` stays: it lifts oxfmt's 2.1.0 to 2.1.2.
- `oxlint.config.ts`: the `ultracite/oxlint/react` preset and its eleven `react/*` and `react-perf/*` rule settings are gone, because the repo holds no `.tsx` or `.jsx` file. The stale Playwright sentence is gone too.
- `.dockerignore`: the header now names what the gateway image copies. The patterns for `apps/{desktop,mobile,extension}`, `packages/{data-plane,tunnel,server}`, turbo, `*.test.tsx` and `playwright.config.ts` are gone, since none of these exist.
- `.gitignore`: `.turbo`, `.meridian-cache`, `test-results`, `playwright-report`, `output/playwright/`, `.vitest-reports`, `*.module.css.map.json` and `docs/design/handoff-binding-layer/` are gone, since nothing produces them.
- `bunfig.toml`: **kept**, with a corrected comment. The audit called it dead because its reason ("React Native / Metro / Electron") was. Deleting it made `bun run scripts:test` fail: `Cannot find package '@centraid/test-kit/temp-dir'` from `scripts/release/sync-versions.test.mjs`. The root's scripts import a workspace package that the root `package.json` does not declare, and only the hoisted layout links it. The comment now says so.

## Verification

```sh
rm -rf node_modules packages/*/node_modules && bun install   # 366 packages
bun run check     # exit 0: format, lint, lint:product, typecheck, design 402 + test-kit 22 tests, scripts 49 tests
cargo xtask rules # every rule ok
```

Not run: a Docker build of the gateway image, because there is no Docker here. The `.dockerignore` edits only remove patterns that match no path in the tree.
