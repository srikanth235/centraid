# Issue #208 — file-naming consistency: cross-module cleanups

Issue: #208

Follow-up to the agent-runtime backend symmetry work (#206). A naming review of
`packages/` surfaced cross-module inconsistencies beyond the backends; this
receipt tracks the layer-1 cleanups, each landed as its own focused commit.

## Checklist
- [x] A — Move design-tokens source under src/ and update package.json + tsconfig
- [x] B — Drop redundant folder-name prefixes in models/, cli/, handler/, conversation/
- [x] C — Resolve insights/ analytics-vs-insights prefix question
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

### B — Drop redundant folder-name prefixes in models/, cli/, handler/, conversation/
Dropped the redundant folder-name prefix in the four folders where (nearly)
every file repeated it, via `git mv` + relative-import updates contained within
each package (no cross-package deep imports exist — consumers use barrels):
- `agent-runtime/models/`: `model-catalog`/`model-defaults`/`model-enumerators`/
  `model-tiers` → `catalog`/`defaults`/`enumerators`/`tiers` (+ their tests).
- `gateway/cli/`: `cli-config`/`cli-paths`/`cli-runner-prefs`/`cli-token` →
  `config`/`paths`/`runner-prefs`/`token` (`cli.ts` is the entry, kept).
- `automation/handler/`: `handler-audit`/`handler-ctx`/`handler-lint`/
  `handler-runner` → `audit`/`ctx`/`lint`/`runner` (`agent-answer.ts` already
  unprefixed).
- `app-engine/conversation/`: `conversation-history`/`conversation-runner`/
  `conversation-runner-core`/`conversation-schema`/`conversation-store`/
  `conversation-store-sql`/`conversation-transcript` → `history`/`runner`/
  `runner-core`/`schema`/`store`/`store-sql`/`transcript` (+ tests).

Renames were anchored to import specifiers and file-reference prose only.
Same-named string literals and data files were deliberately preserved: the
`centraid-conversation-runner-sessions` temp-dir name, the
`conversation-history:` error prefix, the `model-catalog.json` /
`model-tiers.json` data files, the `conversation-runner-sessions` gateway dir,
and prose references to *other* files (`openclaw-conversation-runner.ts` in
openclaw-plugin, the separate `app-engine/handlers/handler-runner.ts`, gateway's
`unified-conversation-runner.ts`) are all untouched.

Partial-prefix folders (`http/`, `settings/`, `manifest/`, `mock-llm/`,
`lifecycle/`) were intentionally left — there the prefix disambiguates a
minority of files rather than redundantly repeating the folder name.

### C — Resolve insights/ analytics-vs-insights prefix question
Investigated `app-engine/src/insights/` (`analytics-db.ts`, `analytics-store.ts`
vs `insights-store.ts`) and concluded the split is **intentional — no rename**.
`analytics-*` is the central `centraid-analytics.sqlite` storage and the
push-based **write** ledger (`AnalyticsStore` implements `RunSummarySink`;
`ANALYTICS_MIGRATIONS`); `insights-store.ts` is the read-only **aggregation**
layer (`InsightsStore`, the source for the desktop Insights screen). They are
two distinct nouns/classes, not a redundant prefix: renaming `analytics-*`
would collide with `insights-store.ts` and fight the `AnalyticsStore` /
`centraid-analytics.sqlite` names. The folder is `insights/` because the
sub-module was the former `@centraid/analytics` package (#151) renamed to its
read-facing feature name while keeping the internal Analytics storage concept.

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
- B: each affected package's own `tsc --noEmit` is clean for the renamed files
  (agent-runtime, app-engine, automation; gateway has one pre-existing
  cross-package implicit-any in an untouched `routes/` file from the worktree's
  stale-dist resolution). Tests on the renamed folders pass: agent-runtime
  models 15/15, gateway cli 8/8, app-engine conversation+http 100/100,
  automation handler/mock-llm green. The 5 `fire.test.ts` failures are
  pre-existing — confirmed by stashing this change and reproducing them on the
  prior commit. Repo-wide grep confirms no broken import paths or doc links;
  preserved string literals / data files verified present.
- A: `tsc -p tsconfig.json` build on `@centraid/design-tokens` is clean and
  emits a flat `dist/` (`dist/index.js` at root, `dist/themes/*`), so
  `main`/`types` remain valid. Repo-wide grep confirms the only consumers use
  the `@centraid/design-tokens` barrel — no subpath imports broke.
- D: `tsc -p tsconfig.json --noEmit` on `@centraid/design-tokens` is clean;
  repo-wide grep confirms zero remaining `_shared` references.
