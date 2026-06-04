# Issue #208 — file-naming consistency: cross-module cleanups

Issue: #208

Follow-up to the agent-runtime backend symmetry work (#206). A naming review of
`packages/` surfaced cross-module inconsistencies beyond the backends; this
receipt tracks the layer-1 cleanups, each landed as its own focused commit.

## Checklist
- [x] A — Move design-tokens source under src/ and update package.json + tsconfig
- [ ] B — Drop redundant folder-name prefixes in models/, cli/, handler/, conversation/
- [ ] C — Resolve insights/ analytics-vs-insights prefix question
- [x] D — Rename design-tokens/themes/_shared.ts to shared.ts

## What changed

### A — Move design-tokens source under src/ and update package.json + tsconfig
`design-tokens` was the only source package keeping its `.ts` files at the
package root instead of under `src/`. Moved all nine root modules (`index`,
`palette`, `css`, `density`, `radii`, `typography`, `tile`, `icons`, `apps`)
plus the `themes/` folder into `src/` via `git mv` — the whole tree moves
together so every relative import stays valid (no source edits). Updated the
build config to match: `tsconfig.json` `rootDir` `.` → `./src` and `include`
→ `["src"]`; `package.json` `react-native` `./index.ts` → `./src/index.ts` and
the per-file `files` list → `["dist", "src"]` (which also drops the stale
`themes.ts` entry that never existed). `main`/`types` stay `./dist/index.js` /
`./dist/index.d.ts` — with `rootDir: ./src` the build still emits a flat `dist/`
(`dist/index.js`, `dist/themes/*`), verified by a clean `tsc` build. All
consumers import the package via the `@centraid/design-tokens` barrel, so there
were no subpath importers to update.

### D — Rename design-tokens/themes/_shared.ts to shared.ts
`design-tokens/themes/_shared.ts` was the only underscore-prefixed source file
in the repo — every other internal/shared module uses a plain name or
`index.ts`. Renamed it to `themes/shared.ts` (via `git mv`) and updated the
eight relative importers under `themes/` (`nord`, `github`, `notion`,
`centraid`, `solarized`, `airtable`, `monokai`, and the `index.ts` barrel) from
`'./_shared'` to `'./shared'`.

## Out of scope
- The `-runner` naming drift (`conversation-runner` / `handler-runner` /
  `unified-conversation-runner` / bare `worker/runner`) is intentionally left
  alone — cosmetic, low value.
- Partial-prefix folders (`http/`, `settings/`, `manifest/`, `mock-llm/`,
  `lifecycle/`) are not part of the B sweep: there the prefix disambiguates a
  minority of files rather than redundantly repeating the folder name.

## Verification
- A: `tsc -p tsconfig.json` build on `@centraid/design-tokens` is clean and
  emits a flat `dist/` (`dist/index.js` at root, `dist/themes/*`), so
  `main`/`types` remain valid. Repo-wide grep confirms the only consumers use
  the `@centraid/design-tokens` barrel — no subpath imports broke.
- D: `tsc -p tsconfig.json --noEmit` on `@centraid/design-tokens` is clean;
  repo-wide grep confirms zero remaining `_shared` references.
