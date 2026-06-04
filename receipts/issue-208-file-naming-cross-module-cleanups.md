# Issue #208 — file-naming consistency: cross-module cleanups

Issue: #208

Follow-up to the agent-runtime backend symmetry work (#206). A naming review of
`packages/` surfaced cross-module inconsistencies beyond the backends; this
receipt tracks the layer-1 cleanups, each landed as its own focused commit.

## Checklist
- [ ] A — Move design-tokens source under src/ and update package.json + tsconfig
- [ ] B — Drop redundant folder-name prefixes in models/, cli/, handler/, conversation/
- [ ] C — Unify analytics-* vs insights-* in app-engine insights/
- [x] D — Rename design-tokens/themes/_shared.ts to shared.ts

## What changed

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
- D: `tsc -p tsconfig.json --noEmit` on `@centraid/design-tokens` is clean;
  repo-wide grep confirms zero remaining `_shared` references.
