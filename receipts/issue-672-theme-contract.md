# issue-672 — one token contract, semantic text roles, and legible themes
<!-- governance: allow-receipt-per-issue broad-token-migration -->

GitHub issue: [#672](https://github.com/srikanth235/centraid/issues/672)

## Checklist

- [x] Replace numbered ink tokens with semantic text roles across shell, blueprints, and mobile
- [x] Raise light-theme contrast, accent-as-text, borders, shadows, and dark ghost-text floor
- [x] Establish emitter contracts and executable shell/app-surface contrast floors
- [x] Remove density and the kit compatibility shim
- [x] Remove client CSS literals and tighten the token debt budget to the intentional app-identity exceptions
- [x] Regenerate mobile tokens with the teal hue and retire stale brand/wall assets

## What changed

- Replace numbered ink tokens with semantic text roles across shell, blueprints, and mobile.
- Raise light-theme contrast, accent-as-text, borders, shadows, and dark ghost-text floor.
- Establish emitter contracts and executable shell/app-surface contrast floors.
- Remove density and the kit compatibility shim.
- Remove client CSS literals and tighten the token debt budget to the intentional app-identity exceptions.
- Regenerate mobile tokens with the teal hue and retire stale brand/wall assets.

`@centraid/design-tokens` now owns one semantic vocabulary: `--text`,
`--text-soft`, `--text-faint`, `--text-ghost`, and `--text-inv` replace the
ambiguous ink rungs, replacing numbered ink tokens with semantic text roles
across shell, blueprints, and mobile. The shell and portable blueprint emitters
have explicit contracts, while contrast tests establish emitter contracts and
executable shell/app-surface contrast floors for text, accent, success, and
danger values against the surfaces where they render.

The light theme now uses a strong near-black text ramp, visible hairlines, and
an accessible teal text accent, raising light-theme contrast, accent-as-text,
borders, shadows, and the dark ghost-text floor. Blueprint defaults move to
the brand-teal hue; the mobile theme is regenerated from that source and uses
the same role names, retiring stale brand/wall assets.

Density is no longer a preference or CSS emission path. The blueprint kit now
consumes public contract tokens directly, without `--kit-*` aliases or literal
fallback colors, removing density and the kit compatibility shim. Client CSS
no longer carries raw colors or literal font stacks, removing client CSS
literals and tightening the token debt budget to the intentional app-identity
exceptions.

### Review round 2 — correctness fixes

The first round shipped four defects, all found in review:

1. **A CLI flag was renamed by the token sweep.** `--surface` → `--bg-elev`
   also rewrote `scripts/perf/app-weight.mjs`'s *command-line flag*, so
   `perf:app-weight -- --surface desktop|mobile` — how `ci.yml` invokes it —
   failed, taking down the `desktop-e2e` and `mobile-smoke` lanes. The flag and
   the two budget probe strings are restored.
2. **The accent swatches lost hue coherence.** Purging the pre-teal hexes
   remapped each accent's tint/shade onto unrelated palette hues (teal's
   "deep" became a green, rose's "light" a violet). These are applied inline on
   `<html>` and outrank the themes, so hover/pressed states painted the wrong
   colour. `accentRamp()` now derives them from the accent's own hue; only
   BRAND keeps an authored ramp.
3. **`--accent-text` did not follow an accent override.** Picking rose gave
   rose buttons and teal links. `applyPrefsToDocument` now injects it, using the
   deepened shade on light and the accent itself on dark.
4. **Two ramps still failed the floors the issue exists to enforce.** The
   app-surface `--text-faint` measured 3.35:1 (light, on the recessed track)
   and 4.05:1 (dark) where it carries body-sized captions. Fixed to 42% / 59%
   lightness — 4.51:1 and 4.55:1. The dark miss was found by the rewritten
   test, not by hand.

**The kit fold finished the vocabulary.** Removing `--kit-*` left kit.css
reading two names no emitter has ever defined: `var(--warn)` and `var(--ok)`.
Three blueprint apps happened to declare `--warn`/`--ok` locally, so the badge
and bar tones painted there and silently resolved to nothing everywhere else,
including in the client shell. `--warning` is now a shell contract token (it
already existed on the app surface), `--success` joins the app surface, and all
30 `var(--warn)`/`var(--ok)` references across the client, kit and blueprints
move onto the contract names. `--ok`/`--warn` no longer exist.

**One design package, two layers.** With the vocabulary unified, the split
between `packages/design-tokens` and `packages/blueprints/kit` had no remaining
justification: the kit held no design decisions of its own, and living under
"app templates" mislabelled the shared UI substrate the templates render on.
The package is now `packages/design` (`@centraid/design`) with a **token
layer** (`src/`, imported) and a **kit layer** (`kit/`, served to app surfaces
via `KIT_DIR` / `sharedAssetsDir`). `KIT_DIR` moves out of `@centraid/blueprints`
into `@centraid/design/kit`; the seven kit-layer test files move with the code;
blueprints keeps its templates and drops `@centraid/blob-format`, which only the
kit used. `docs/traps/design-tokens.md` documents which layer a change belongs
in, so the two never re-fragment.

`contrast.test.ts` was the reason (2) and (4) could hide: it re-typed the
values it was guarding instead of reading them. It now parses the emitted CSS
from `toCss()` / `toBlueprintCss()`, resolves `var()`/`calc()` the way mobile's
generator does, and measures every rung against *every* surface it can land
on — plus a ramp-ordering assertion so a failing rung cannot be "fixed" by
flattening the ramp into four identical greys.

## Decisions

- Text roles describe purpose rather than brightness, so call sites cannot
  accidentally choose an illegible rung for real prose.
- A fixed spacing system replaces density variants: one interface layout is
  easier to scan, test, and keep in parity across hosts.
- Per-blueprint identity colors remain intentional and are the sole budgeted
  raw CSS colors; shell and shared-kit colors are contract-owned.

## Out of scope

- Changing individual blueprint identity palettes beyond migrating the shared
  vocabulary they consume.
- Redesigning product flows or adding new animation beyond existing behavior.

### Files

- `packages/design-tokens/src/color.ts` (new) — WCAG contrast maths + accent ramp derivation
- `packages/design-tokens/src/contrast.test.ts` — rewritten to measure the emitted CSS
- `packages/design-tokens/src/color-accent.test.ts` (new) — hue-coherence + legibility of derived ramps
- `packages/design-tokens/src/contract.ts` — `--warning` added to the shell contract, `--success` to the app surface
- `packages/design-tokens/src/css.ts` — emits `--warning`
- `packages/design-tokens/src/blueprint.ts` — `--text-faint` 42% light / 59% dark; `--success` added
- `packages/design-tokens/src/themes/shared.ts` — `ACCENT_TEXT_LIGHT`, `SUCCESS_LIGHT`, `WARNING`, `WARNING_LIGHT`, `Theme.warning`
- `packages/design-tokens/src/themes/centraid.ts` — named constants, light `sidebarDivider` on the current ink base
- `packages/design-tokens/src/themes/index.ts`, `packages/design-tokens/src/index.ts` — accent exports
- `packages/client/src/app-shell-context.ts` — `ACCENT_PALETTE` derived via `accentRamp`
- `packages/client/src/react/shell/appearance.ts` — injects `--accent-text` with an accent override
- `packages/client/src/react/shell/appearance.test.ts` — asserts that injection
- `packages/client/src/react/screens/localUsageView.ts` — stale `--icon-*` comment
- `packages/blueprints/kit/kit.css` — `--warn`/`--ok` → `--warning`/`--success`
- `packages/blueprints/apps/{agenda,locker,people}/Chrome.module.css` — same rename for the local overrides
- `apps/mobile/src/kit/theme/tokens.generated.ts` — regenerated from the corrected app surface
- `scripts/perf/app-weight.mjs`, `tests/experience-budgets/{desktop,mobile}.json` — `--surface` CLI flag restored
- `.design-sync/ds-src/styles/bridge.css` — dead `--ink*`/`--surface*` mappings dropped
- `packages/design/**` (was `packages/design-tokens/**`) — renamed package, `@centraid/design`
- `packages/design/kit/**` (was `packages/blueprints/kit/**`) — the kit layer, moved with history
- `packages/design/src/kit.ts` (new) — `KIT_DIR`, the kit layer's one seam
- `packages/design/src/{assistant-rich,assistant-sanitize,code-highlight,conversation-client,edge-upload,kit-smoke,turn-stream}.test.ts` — kit-layer tests moved from blueprints
- `packages/design/tsconfig.test.json` — ESM typecheck program (the kit layer is browser ESM; the build still emits CJS)
- `packages/gateway/src/serve/build-gateway.ts` — `KIT_DIR` from `@centraid/design/kit`
- `packages/blueprints/{package.json,vitest.config.ts,tsconfig.apps.json,types/virtual-kit/kit.ts,src/index.ts,src/app-boot-harness.ts,src/locker-online-only.test.ts,visual-harness/server.mjs}` — kit handed over
- `apps/{web,desktop}/vite.config.ts`, `packages/client/{tsconfig.json,vitest.config.ts,vitest.mutation.config.ts}` — anchored root alias + kit directory alias
- `tests/mutation-floors.json` — floor key follows the directory rename (value unchanged at 93)
- `README.md`, `AGENTS.md`, `ARCHITECTURE.md`, `TESTING.md`, `docs/traps/design-tokens.md` — two-layer model documented

## Verification

```sh
bun run check:fast
bun run --cwd packages/design-tokens test
NODE_PATH=$PWD/node_modules bun run --cwd apps/mobile test -- src/kit/theme/generate.test.ts src/kit/theme/resolve.test.ts
node scripts/lint-design-tokens.mjs
```

`bun run check:push` — 25/25 gates green (round 2, including the `lint`,
`typecheck:affected` and `test:affected` gates that the flag rename had broken).
The semantic-token suite is 81 tests across 8 files. The desktop Electron smoke build
completed; the live renderer did not reach its readiness selector in this
headless session, so visual regression remains covered by the PR’s automated
desktop Playwright lane.

## Audit

Verdict: PASS. The issue’s token-contract, contrast, density-removal, brand
purge, client literal-tokenization, and mobile-regeneration requirements are
represented in the staged diff, with executable contract and contrast tests.

## Steering

PASS — Evidence: the operator asked the agent to create a PR containing all
current changes after the initial commit-hook status check; this redirected the
handoff from diagnosis to completing the governed commit and draft PR.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| codex-019fbc6b-05b-1785574158-1 | codex | 019fbc6b-05bf-72d1-9acd-c246218b38eb | #672 | gpt-5.6-terra | 376206 | 0 | 16264192 | 46829 | 423035 | 5.7090 | 376206 | 0 | 16264192 | 46829 | feat(theme): unify token contract and improve legibility (#672) |
| codex-019fbc6b-05b-1785574807-1 | codex | 019fbc6b-05bf-72d1-9acd-c246218b38eb | #672 | gpt-5.6-terra | 19839 | 0 | 1886464 | 3251 | 23090 | 0.5700 | 396045 | 0 | 18150656 | 50080 | feat(theme): unify token contract and improve legibility (#672) |
| codex-019fbc6b-05b-1785574869-1 | codex | 019fbc6b-05bf-72d1-9acd-c246218b38eb | #672 | gpt-5.6-terra | 12053 | 0 | 321792 | 1416 | 13469 | 0.1318 | 408098 | 0 | 18472448 | 51496 | feat(theme): unify token contract and improve legibility (#672) |
| codex-019fbc6b-05b-1785574961-1 | codex | 019fbc6b-05bf-72d1-9acd-c246218b38eb | #672 | gpt-5.6-terra | 19779 | 0 | 993280 | 1306 | 21085 | 0.3174 | 427877 | 0 | 19465728 | 52802 | feat(theme): unify token contract and improve legibility (#672) |
| codex-019fbc6b-05b-1785575180-1 | codex | 019fbc6b-05bf-72d1-9acd-c246218b38eb | #672 | gpt-5.6-terra | 22157 | 0 | 1496320 | 1158 | 23315 | 0.4468 | 450034 | 0 | 20962048 | 53960 | test(client): cover teal orbit logo (#672) |
| claude-code-cbc1504a-314-1785577918-1 | claude-code | cbc1504a-3144-4890-8d32-899615939189 | #672 | claude-opus-5 | 776 | 1642727 | 59632329 | 283586 | 1927089 | 47.1767 | 776 | 1642727 | 59632329 | 283586 |  |
| claude-code-cbc1504a-314-1785580278-1 | claude-code | cbc1504a-3144-4890-8d32-899615939189 | #672 | claude-opus-5 | 276 | 642331 | 41713126 | 90761 | 733368 | 27.1415 | 1052 | 2285058 | 101345455 | 374347 |  |

### Steering

| steer-key | session | issue | type | tier | user-reason | commit | ordinal | timestamp |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
