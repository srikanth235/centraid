# Issue #1155 — the root files and settings left from the retired JS apps

An audit of the repository root against a repo-wide grep. The public site (Astro, pagefind, `wrangler.json`, `scripts/docs-site`, `scripts/home-site`) is out of scope by the owner's word.

## What changed

- `.env.example`: deleted. Its one variable, `OPENCLAW_GATEWAY_TOKEN`, was read nowhere.
- `package.json` (and `bun.lock`): the `shell-quote` and `tar` overrides are gone, because neither package is in the lockfile. `tinypool` stays: it lifts oxfmt's 2.1.0 to 2.1.2.
- `oxlint.config.ts`: the `ultracite/oxlint/react` preset and its eleven `react/*` and `react-perf/*` rule settings are gone, because the repo holds no `.tsx` or `.jsx` file. The stale Playwright sentence is gone too.
- `.dockerignore`: the header now names what the gateway image copies. The patterns for `apps/{desktop,mobile,extension}`, `packages/{data-plane,tunnel,server}`, turbo, `*.test.tsx` and `playwright.config.ts` are gone, since none of these exist.
- `.gitignore`: `.turbo`, `.meridian-cache`, `test-results`, `playwright-report`, `output/playwright/`, `.vitest-reports`, `*.module.css.map.json` and `docs/design/handoff-binding-layer/` are gone, since nothing produces them.
- `bunfig.toml`: first kept, with a corrected comment. The audit called it dead because its reason ("React Native / Metro / Electron") was. Deleting it made `bun run scripts:test` fail: `Cannot find package '@centraid/test-kit/temp-dir'` from `scripts/release/sync-versions.test.mjs`. The root's scripts import a workspace package that the root `package.json` does not declare, and only the hoisted layout links it. The comment now says so.

## Verification

```sh
rm -rf node_modules packages/*/node_modules && bun install   # 366 packages
bun run check     # exit 0: format, lint, lint:product, typecheck, design 402 + test-kit 22 tests, scripts 49 tests
cargo xtask rules # every rule ok
```

Not run: a Docker build of the gateway image, because there is no Docker here. The `.dockerignore` edits only remove patterns that match no path in the tree.

## Second slice: `packages/test-kit` removed (owner, same PR)

Three of its eight exports had callers: `temp-dir` (3 release tests), `fake-clock` (3 design element suites) and `vitest`'s `nodeProject` (design's config). The other five had none, and neither did the 267-line `automation-handler-harness`, `jsdomProject` with its React act setup, `random`, the `fast-check` re-export, `flush` and `sequential`. The live parts moved beside their only callers, with their own tests:

- `scripts/release/temp-dir.mjs` (plain JS) and `temp-dir.test.mjs`. Its 2 tests are the old kit's tempDir cases.
- `packages/design/src/elements/fake-clock.test-support.ts` and `fake-clock.test.ts`. Its 8 tests are the old `seams.test.ts` clock cases, the leak probe included. Both build programs (`tsconfig.json`, `tsconfig.elements.json`) exclude `*.test-support.ts`, so the helper never ships: `bun run build` → no `fake-clock` in `dist`.
- `packages/design/vitest.config.ts` states its node project directly: `environment: "node"`, forks, `requireAssertions`. The kit's `node:sqlite` externalisation plugin is gone, because nothing in design imports `node:sqlite`.
- `bunfig.toml` is deleted after all. The hoisted layout existed only so the root scripts could resolve `@centraid/test-kit`, and they now import `./temp-dir.mjs`.
- The oxlint seam rules are unchanged in force. Their messages name the new helpers, and the `Math.random` ban now points at the seeded LCG in `tile-properties.test.ts`, because `seededRandom` had no caller.
- Docs to current state: `AGENTS.md`, `ARCHITECTURE.md`, `README.md`, `docs/{coding-standards,toolchain,dev-environment,multi-agent}.md`, `docs/decisions.md` X-801, and the `ts-static` comment in `crates/xtask/src/gate.rs`. `coding-standards.md` also drops its paragraph on `@centraid/test-kit/vault`'s `bootstrappedVault()`, which did not exist.
- Left as written: `QUALITY.md`, `tests/journeys.json` and receipts. They are records, and their test-kit mentions are history.

### Verification

```sh
rm -rf node_modules packages/*/node_modules && bun install
bun run check     # exit 0: design 34 files / 410 tests (402 + 8 clock), scripts 7 / 51 (49 + 2 temp-dir)
cargo xtask rules # every rule ok;  cargo xtask doc-links → 0 findings
```

## Third slice: more of the root (owner, same PR)

- `flake.nix` deleted (owner). Nothing evaluated it: `v1-handoffs.md` 3.3, "the first `nix flake check`", had never been done. Each toolchain keeps its own version file. `docs/decisions.md` R-1020-10 now says so and D-1020-G6 is marked superseded. Hand-off 3.3 is withdrawn, and `docs/toolchain.md`, `docs/dev-environment.md` and `rust-toolchain.toml`'s header drop the flake. The header also drops the v0 `apps/web/iroh-wasm` note, whose tree is gone.
- `assets/` deleted: 13 icons (`.icns`, `.ico`, tray template, Expo adaptive icon and splash) from the retired Electron and Expo shells. A grep of every file name finds no reference outside the directory; the phone apps carry their own icons under `mobile/`.
- `buf.gen.yaml` deleted. It was "DOCUMENTATION ONLY" with `plugins: []`, so nothing ran `buf generate`. Its consumer table moved into `crates/api-proto/README.md`, and `buf.yaml`, `build.rs`'s doc comment, the gateway `Dockerfile` (`COPY buf.yaml ./`) and `v1-handoffs.md` 1.2 no longer name it.

### Verification

```sh
bun run check                     # exit 0
cargo xtask rules                 # every rule ok
cargo xtask doc-links             # 0 findings
cargo test -p centraid-api-proto  # pass
buf lint                          # clean (buf 1.75.0 via npm)
```

Not run: `docker build` (no Docker here). The Dockerfile change only drops a COPY of a deleted documentation file.
