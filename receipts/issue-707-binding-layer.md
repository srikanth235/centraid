# Issue #707 — adopt the Binding Layer design system

Issue: #707

## Checklist

Mirrors the Action items of issue #707.

Phase 0 — Assets + matrix

- [x] Make the handoff bundle available as the acceptance reference (superseded: the bundle is reference-only and is deliberately NOT committed — see Decisions)
- [x] Update `tests/design-grammar-matrix.json` where invariants change (M7 notification→status line is the largest; check M8 loading, M12 offline, M19 progress)
- [x] Record the brief↔repo role-name mapping and the hue table (Decision §1/§4) as the working reference

Phase 1 — Token layer flip (`packages/design/src`)

- [x] New color values in `themes/` (ink ramp, `line`/hairline, `surf`, `onAccent`; `--accent` = ink; dark values per brief)
- [x] New roles in `roles.ts`: `--net`, `--link`, surface tones, density tiers, component metrics; retire accent-hue roles
- [x] 12-slot OKLCH app palette replacing the 8 named hex hues; resolve to hex at build time
- [x] 7-role type ramp in `typography.ts` with CJK fallback stacks; retire `hero`, `greeting`, 10px `eyebrow`; add the Reading register
- [ ] Vendor woff2 for the four faces; emit `@font-face`; confirm served-blueprint CSP allows same-origin fonts (fonts vendored + emitter done; host wiring and CSP confirmation pending in Phases 3–4)
- [x] Radii/spacing/motion values per brief; retire old spellings
- [ ] Update every lockstep literal site; regenerate `tokens.generated.ts` (design-side sites done; mobile regeneration blocked until Phase 5 rewrites `generate.ts`)
- [x] Recompute all pinned tests

Phase 2 — Constitution rewrite

- [x] Rewrite DESIGN.md around the five invariants plus the explicit freedom table
- [x] Rewrite `design-md.test.ts` in lockstep; `bun run lint:design-md` stays green

Phase 3 — Control vocabulary (recipes + kit)

- [ ] Recipe table: retire `destructiveFilled` and `Toast`; add `StatusLine`; `Loading` becomes determinate-only
- [ ] Re-skin `kit.css` and `emitRecipeCss()`; retire `kit-toast` usage in blueprints
- [ ] Text actions rule (ink step + hover ground + trailing arrow); one hue reserved for links/selection/focus ring
- [ ] Update `scripts/accessibility-contract.test.mjs` for the status line

Phase 4 — Shell chrome (`packages/client`)

- [ ] `ShellFrame`/`Sidebar`/`navModel` → stem + per-app app bar + persistent status line
- [ ] Redistribute per Decision §2
- [ ] All-apps sheet: searchable 44px rows, pin switch
- [ ] Cross-app search: ⌘K + stem Search control
- [ ] RTL audit: logical properties only; physical-direction check in `lint:design-tokens`
- [ ] Focus ring 2px via custom property; offline banner + disabled commits with inline reason
- [ ] Compact ≤720px becomes the mobile-band composition

Phase 5 — Mobile (`apps/mobile`)

- [ ] GlassDock → bottom band (5 + More), assistant as an ordinary slot; iOS + Android together
- [ ] Font swap via `@expo-google-fonts`; `bun run generate:theme`; mobile lint re-ratchet
- [ ] Density one tier looser; 44px minimum targets; full-screen search, bottom-sheet All apps

Phase 6 — App surfaces (client screens + blueprints)

- [ ] Per-app surface tone, density tier, and register declared per the brief's freedom table
- [ ] Home springboard: invariant tile header + structurally distinct per-app bodies; first-run dashed placeholders
- [ ] Agenda: month grid desktop, agenda list on mobile/compact
- [ ] Backup/storage and Privacy/grants screens aligned to the brief's designs
- [ ] States: first-run, working, device-conflict, out-of-room
- [ ] Sweep the blueprint CSS modules onto the new ramp/metrics; shrink the token budget with `--write`
- [ ] Numerics everywhere mono + tabular

Phase 7 — Acceptance gates

- [ ] Re-baseline all `design:gallery` screenshots against the committed reference HTML
- [ ] New mechanical gates: 11px floor, container-opacity, logical-properties, band cap, focus ring on filled ink
- [ ] `aria-label` only on icon-only controls; decorative SVG `aria-hidden`
- [ ] Receipt with Checklist / What changed / Out of scope / Verification

## What changed

Phase 0: the design-agent handoff bundle (five `.dc.html` design references, `README.md`, and the generated prototype runtime `support.js`/`doc-page.js`) is vendored byte-for-byte at `docs/design/handoff-binding-layer/`, matching the SHA-256 manifest in issue #707 Appendix A except for a one-line governance file-size waiver prepended to the two generated `.js` runtime files. `oxfmt.config.ts` and `oxlint.config.ts` exclude the bundle so the design tool's output is never reformatted or linted as repo source.

Superseded by a later commit in this branch: the bundle is **reference-only and is not kept in the repo**. `docs/design/handoff-binding-layer/` is untracked and git-ignored, the oxfmt/oxlint exclusions for it are removed, and DESIGN.md now cites issue #707 (which quotes the brief in full) instead of the vendored path. The eight files below appear in this branch's history as add-then-remove.

Checklist evidence:

- Make the handoff bundle available as the acceptance reference (superseded: the bundle is reference-only and is deliberately NOT committed — see Decisions)

Changed files:

- `docs/design/handoff-binding-layer/Centraid System - Binding Layer.dc.html`
- `docs/design/handoff-binding-layer/Centraid - Three Own Directions.dc.html`
- `docs/design/handoff-binding-layer/Centraid Design Directions.dc.html`
- `docs/design/handoff-binding-layer/Centraid Discover - Refinements.dc.html`
- `docs/design/handoff-binding-layer/Centraid Discover - Symphony.dc.html`
- `docs/design/handoff-binding-layer/README.md`
- `docs/design/handoff-binding-layer/support.js`
- `docs/design/handoff-binding-layer/doc-page.js`
- `oxfmt.config.ts`
- `oxlint.config.ts`
- `receipts/issue-707-binding-layer.md`

Phases 1+2: the token layer in `packages/design/src` now carries the Binding Layer values — ink ramp themes (`--accent` = ink `#141414`/`#EDEDEC`), new roles `--net` and `--link`, five `--bg-tone-*` surface tones, `[data-density]` tiers, component metrics (`--h-control` 34, `--h-row` 44, `--h-segmented` 28, `--w-stem` 92), an OKLCH app palette resolved to hex at build time by a new gamut-aware `oklchToHex()` (unit-tested in `oklab.test.ts`), the 7-size type ramp with a new `--t-reading` register and a `display` font genus with CJK fallback stacks, radii 7/12 (controls/containers) with a 26% icon-chip helper, motion 140/280ms with two easings and one global reduced-motion rule, and four vendored `@fontsource` faces (10 woff2 under `packages/design/fonts/` with a `toFontFaceCss(baseUrl)` emitter and byte-equality tests). Multi-accent machinery (`ACCENT_PALETTE`, `accentKey`) and the `--bg-l` greyscale dark-ramp anchor are retired; both dark ramps are literal warm-tinted values. DESIGN.md is rewritten around the five invariants plus the freedom table, the brief↔repo role-name mapping and the app hue table; `design-md.test.ts` pins the new values, and `tests/design-grammar-matrix.json` M7/M8/M12/M19 now speak status-line/determinate language. All 27 `packages/design` test files (270 tests) pass, `lint:design-md` green.

Checklist evidence (Phases 0–2 items completed this commit):

- Update `tests/design-grammar-matrix.json` where invariants change (M7 notification→status line is the largest; check M8 loading, M12 offline, M19 progress)
- Record the brief↔repo role-name mapping and the hue table (Decision §1/§4) as the working reference
- New color values in `themes/` (ink ramp, `line`/hairline, `surf`, `onAccent`; `--accent` = ink; dark values per brief)
- New roles in `roles.ts`: `--net`, `--link`, surface tones, density tiers, component metrics; retire accent-hue roles
- 12-slot OKLCH app palette replacing the 8 named hex hues; resolve to hex at build time
- 7-role type ramp in `typography.ts` with CJK fallback stacks; retire `hero`, `greeting`, 10px `eyebrow`; add the Reading register
- Radii/spacing/motion values per brief; retire old spellings
- Recompute all pinned tests
- Rewrite DESIGN.md around the five invariants plus the explicit freedom table
- Rewrite `design-md.test.ts` in lockstep; `bun run lint:design-md` stays green

Changed files (Phases 1+2):

- `DESIGN.md`
- `bun.lock`
- `tests/design-grammar-matrix.json`
- `packages/design/package.json`
- `packages/design/fonts/dm-mono-latin-400-normal.woff2` (new)
- `packages/design/fonts/dm-mono-latin-ext-400-normal.woff2` (new)
- `packages/design/fonts/instrument-sans-latin-400-normal.woff2` (new)
- `packages/design/fonts/instrument-sans-latin-500-normal.woff2` (new)
- `packages/design/fonts/instrument-sans-latin-ext-400-normal.woff2` (new)
- `packages/design/fonts/instrument-sans-latin-ext-500-normal.woff2` (new)
- `packages/design/fonts/instrument-serif-latin-400-normal.woff2` (new)
- `packages/design/fonts/instrument-serif-latin-ext-400-normal.woff2` (new)
- `packages/design/fonts/source-serif-4-latin-400-normal.woff2` (new)
- `packages/design/fonts/source-serif-4-latin-ext-400-normal.woff2` (new)
- `packages/design/src/apps.ts`
- `packages/design/src/blueprint.ts`
- `packages/design/src/color.ts`
- `packages/design/src/contract.ts`
- `packages/design/src/css.ts`
- `packages/design/src/density.ts`
- `packages/design/src/fonts.ts` (new)
- `packages/design/src/identity.ts`
- `packages/design/src/index.ts`
- `packages/design/src/library.ts`
- `packages/design/src/native.ts`
- `packages/design/src/oklab.ts`
- `packages/design/src/palette.ts`
- `packages/design/src/radii.ts`
- `packages/design/src/roles.ts`
- `packages/design/src/tile.ts`
- `packages/design/src/typography.ts`
- `packages/design/src/recipes/index.ts`
- `packages/design/src/themes/shared.ts`
- `packages/design/src/themes/centraid.ts`
- `packages/design/src/themes/index.ts`
- `packages/design/src/contrast.test.ts`
- `packages/design/src/contrast-shell-palette.test.ts`
- `packages/design/src/css.test.ts`
- `packages/design/src/css-properties.test.ts`
- `packages/design/src/design-md.test.ts`
- `packages/design/src/native-contract.test.ts`
- `packages/design/src/tokens.test.ts`
- `packages/design/src/type-role-parity.test.ts`
- `packages/design/src/themes/themes.test.ts`
- `packages/design/src/fonts.test.ts` (new)
- `packages/design/src/oklab.test.ts` (new)
- `packages/design/src/color-accent.test.ts` (deleted)

Bundle-untracking commit: `.gitignore`, `DESIGN.md`, `oxfmt.config.ts`, `oxlint.config.ts`, `packages/design/src/design-md.test.ts`, `receipts/issue-707-binding-layer.md`, and the removal of the eight `docs/design/handoff-binding-layer/*` files listed above.

## Out of scope

- App renames (Sift/Ledger/Almanac/Vault stay out; repo app names are kept — issue #707 Decision §1).
- The assistant's full design and cross-store consent surface; multi-window/split panes (flagged "not yet designed" in the brief).
- Marketing assets; brand teal may persist there outside the token system.
- Backward compatibility or alias layers (pre-v0).

## Decisions

- Keep repo app names and role names; adopt the brief's values and semantics (issue #707 Decisions §1–§4, settled 2026-08-03).
- **The handoff bundle is reference-only and is not committed** (maintainer decision, mid-implementation). The prototypes are a design-time artifact, not a repo asset: they are ~420 KB of generated prototype runtime with an external owner, they would need permanent governance waivers to stay, and the normative content — the full brief text — is already quoted verbatim in issue #707, which is the durable reference. `docs/design/handoff-binding-layer/` is git-ignored so a local copy stays browsable without ever entering the tree; the earlier vendoring commit stands in branch history as add-then-remove.
- With the bundle untracked, its oxfmt/oxlint exclusions and the DESIGN.md link to the vendored path are removed; DESIGN.md and `design-md.test.ts` now cite issue #707 instead.
- Light `ink3` ships as `#6C6C69`, not the brief's `#70706D`: the brief validates against `surf` only, but against the deeper `mat` tone (which an app may declare) `#70706D` measures 4.32:1 — a real WCAG 1.4.3 failure. The shipped value clears 4.58 on mat. Documented in `themes/shared.ts` and DESIGN.md.
- `line`↔`lineS` mapping inverted relative to naive reading: the repo's `--line` was already the weaker hairline rung, so brief `lineS`→`--line` and brief `line`→`--line-strong`.
- Hairline/wash roles carried a false `floor: 3` that no test had ever measured (true before this change); the number is removed in favour of the real obligation ("never the only signal"), and `--text-disabled` now cites the WCAG inactive-control exemption. Honesty corrections, not loosenings.
- Palette keys survive with re-slotted OKLCH hues (rose 0, amber 28, ochre 70, forest 150, teal 210, slate 255, indigo 290, violet 320); apps remap per the issue's hue table. Spacing rung 7 (48px) retired (3 consumers, fixed in later phases). `--bg-l` retired because warm-tinted dark tones cannot be expressed by a one-knob greyscale calc ramp.

## Verification

- `shasum -a 256` over the vendored bundle matches issue #707 Appendix A for the six untouched files; the two `.js` files differ only by the prepended waiver line.
- Governance repo-hygiene: waiver headers accepted (file-size-limit), no debug statements, no merge markers, all files under 5 MB.

- `packages/design`: 27 test files / 270 tests pass (re-run independently by the orchestrator after the implementing agent reported green); emitted CSS spot-checked for `--accent: #141414`, `--net`, `--w-stem: 92px`, `--dur-2: 280ms`, `tabular-nums`, tone tokens, reduced-motion, and zero `#3EC8B4`.
- Known, intentional downstream breakage for later phases: `@centraid/client` build (4 errors: retired `ACCENT_PALETTE`/`AccentKey`/`bgL`), `packages/blueprints` token-purity (2 × `--sp-7`), `apps/mobile` theme freshness (regeneration blocked on `generate.ts` rewrite in Phase 5).

```sh
bun run format:check
git diff --check
bun run --cwd packages/design test
bun run lint:design-md
```

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code-8ac80ba9-318-1785757105-1 | claude-code | 8ac80ba9-318d-4598-a125-4ad8b77bda7d | #707 | claude-fable-5 | 229 | 1426930 | 15368439 | 189833 | 1616992 | 42.6990 | 229 | 1426930 | 15368439 | 189833 | docs(design): vendor Binding Layer handoff bundle (#707)Vendors the design-agent |
| claude-code-8ac80ba9-318-1785757205-1 | claude-code | 8ac80ba9-318d-4598-a125-4ad8b77bda7d | #707 | claude-fable-5 | 6 | 3297 | 558612 | 1455 | 4758 | 0.6726 | 235 | 1430227 | 15927051 | 191288 | docs(design): vendor Binding Layer handoff bundle (#707)Vendors the design-agent |
| claude-code-8ac80ba9-318-1785757641-1 | claude-code | 8ac80ba9-318d-4598-a125-4ad8b77bda7d | #707 | claude-fable-5 | 32 | 64892 | 3100146 | 25396 | 90320 | 5.1814 | 267 | 1495119 | 19027197 | 216684 | docs(design): vendor Binding Layer handoff bundle (#707)Vendors the design-agent |
| claude-code-8ac80ba9-318-1785761542-1 | claude-code | 8ac80ba9-318d-4598-a125-4ad8b77bda7d | #707 | claude-fable-5 | 88 | 118264 | 9934347 | 70669 | 189021 | 14.9470 | 355 | 1613383 | 28961544 | 287353 | feat(design): flip token layer to Binding Layer ink system (#707)Replaces the te |
| claude-code-8ac80ba9-318-1785761594-1 | claude-code | 8ac80ba9-318d-4598-a125-4ad8b77bda7d | #707 | claude-fable-5 | 2 | 3330 | 246951 | 432 | 3764 | 0.3102 | 357 | 1616713 | 29208495 | 287785 | feat(design): flip token layer to Binding Layer ink system (#707)Replaces the te |
| claude-code-8ac80ba9-318-1785761644-1 | claude-code | 8ac80ba9-318d-4598-a125-4ad8b77bda7d | #707 | claude-fable-5 | 2 | 500 | 250281 | 231 | 733 | 0.2681 | 359 | 1617213 | 29458776 | 288016 | feat(design): flip token layer to Binding Layer ink system (#707)Co-Authored-By: |
| claude-code-8ac80ba9-318-1785761714-1 | claude-code | 8ac80ba9-318d-4598-a125-4ad8b77bda7d | #707 | claude-fable-5 | 8 | 14163 | 1007194 | 5905 | 20076 | 1.4796 | 367 | 1631376 | 30465970 | 293921 | feat(design): flip token layer to Binding Layer ink system (#707)Replaces the te |
| claude-code-8ac80ba9-318-1785762927-1 | claude-code | 8ac80ba9-318d-4598-a125-4ad8b77bda7d | #707 | claude-opus-5 | 90 | 732176 | 10644498 | 79606 | 811872 | 11.8889 | 457 | 2363552 | 41110468 | 373527 | docs(design): keep the handoff bundle out of the repo (#707)The design-agent pro |
| claude-code-8ac80ba9-318-1785762989-1 | claude-code | 8ac80ba9-318d-4598-a125-4ad8b77bda7d | #707 | claude-opus-5 | 2 | 418 | 258198 | 190 | 610 | 0.1365 | 459 | 2363970 | 41368666 | 373717 | docs(design): keep the handoff bundle out of the repo (#707)governance: allow-to |
| claude-code-8ac80ba9-318-1785763061-1 | claude-code | 8ac80ba9-318d-4598-a125-4ad8b77bda7d | #707 | claude-opus-5 | 6 | 3633 | 777385 | 1214 | 4853 | 0.4418 | 465 | 2367603 | 42146051 | 374931 | docs(design): keep the handoff bundle out of the repo (#707)The design-agent pro |

### Steering

| steer-key | session | issue | type | tier | user-reason | commit | ordinal | timestamp |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| steer-8ac80ba9-1785756384-1 | 8ac80ba9-318d-4598-a125-4ad8b77bda7d | #707 | interrupt | structural |  | pending | 1 | 2026-08-03T11:26:24.927Z |
| steer-8ac80ba9-1785760103-2 | 8ac80ba9-318d-4598-a125-4ad8b77bda7d | #707 | correction | classifier | handoff-bindings are reference-only, not committed | pending | 2 | 2026-08-03T13:08:23.710Z |

## Steering

- Every human-steering event is recorded as a row: **PASS** — Structural JSON parse of session 8ac80ba9-318d-4598-a125-4ad8b77bda7d confirms two user steering events: (1) "[Request interrupted by user]" at 2026-08-03T11:26:24.927Z (ordinal 1), (2) "handoff-bindings needn't be committed...they are only for reference" at 2026-08-03T13:08:23.710Z (ordinal 2, a mid-task correction redirecting the bundle vendoring work already done in commit 68351e3f).
- No non-steering message is recorded as a steering event: **PASS** — only these two events are in the Steering table; 137 other user messages in the transcript are routine task messages or tool results, not corrections.

## Audit

- '## What changed' faithfully describes the staged diff: **PASS** — The "Bundle-untracking commit" paragraph accurately states the eight files are staged for deletion, `.gitignore` adds the directory, `oxfmt.config.ts` and `oxlint.config.ts` remove their exclusions, `DESIGN.md` replaces the vendored README link with issue #707, and `design-md.test.ts` updates its expect() assertion to cite the issue instead. The "Superseded" paragraph correctly explains: untracked + git-ignored, tool exclusions removed, DESIGN.md now cites issue #707 (which quotes the brief in full).
- Each '- [x]' checklist item is realized: **PASS** — Phase 0 item "Make the handoff bundle available as the acceptance reference" reads "(superseded: the bundle is reference-only and is deliberately NOT committed — see Decisions)"; the receipt's Decisions section (§2) explains the maintainer's mid-task reversal and justifies it (prototypes are design-time artifacts, external-owner generated code, require permanent waivers, brief is durable in issue #707). The receipt prose fully supports this divergence from the issue's original Phase-0 wording.
- The '## Checklist' mirrors issue #707's Action items (divergence explained): **PASS** — The receipt's 38-item checklist spans all 7 phases; issue #707's Phase-0 original text still reads "Commit the handoff bundle" (issue edit is deferred to the orchestrator), but the receipt correctly diverges per the Decisions section's mid-implementation maintainer direction and explains the reversal in both the Superseded paragraph and Decisions §2 with full justification.

