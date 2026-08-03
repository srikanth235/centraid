# Issue #707 — adopt the Binding Layer design system

Issue: #707

## Checklist

Mirrors the Action items of issue #707.

Phase 0 — Assets + matrix

- [x] Commit the handoff bundle to `docs/design/handoff-binding-layer/` (8 files; verify against the SHA-256 manifest in Appendix A)
- [ ] Update `tests/design-grammar-matrix.json` where invariants change (M7 notification→status line is the largest; check M8 loading, M12 offline, M19 progress)
- [ ] Record the brief↔repo role-name mapping and the hue table (Decision §1/§4) as the working reference

Phase 1 — Token layer flip (`packages/design/src`)

- [ ] New color values in `themes/` (ink ramp, `line`/hairline, `surf`, `onAccent`; `--accent` = ink; dark values per brief)
- [ ] New roles in `roles.ts`: `--net`, `--link`, surface tones, density tiers, component metrics; retire accent-hue roles
- [ ] 12-slot OKLCH app palette replacing the 8 named hex hues; resolve to hex at build time
- [ ] 7-role type ramp in `typography.ts` with CJK fallback stacks; retire `hero`, `greeting`, 10px `eyebrow`; add the Reading register
- [ ] Vendor woff2 for the four faces; emit `@font-face`; confirm served-blueprint CSP allows same-origin fonts
- [ ] Radii/spacing/motion values per brief; retire old spellings
- [ ] Update every lockstep literal site; regenerate `tokens.generated.ts`
- [ ] Recompute all pinned tests

Phase 2 — Constitution rewrite

- [ ] Rewrite DESIGN.md around the five invariants plus the explicit freedom table
- [ ] Rewrite `design-md.test.ts` in lockstep; `bun run lint:design-md` stays green

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

Checklist evidence:

- Commit the handoff bundle to `docs/design/handoff-binding-layer/` (8 files; verify against the SHA-256 manifest in Appendix A)

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

## Out of scope

- App renames (Sift/Ledger/Almanac/Vault stay out; repo app names are kept — issue #707 Decision §1).
- The assistant's full design and cross-store consent surface; multi-window/split panes (flagged "not yet designed" in the brief).
- Marketing assets; brand teal may persist there outside the token system.
- Backward compatibility or alias layers (pre-v0).

## Decisions

- Keep repo app names and role names; adopt the brief's values and semantics (issue #707 Decisions §1–§4, settled 2026-08-03).
- Vendor the prototype runtime with governance file-size waivers rather than zipping it, so the acceptance reference stays browsable in-repo; the two waiver headers are the only bytes that differ from the design agent's bundle.
- Exclude the bundle from oxfmt/oxlint: the files are the design tool's generated output with an external owner, matching the existing generator-owned exclusions.

## Verification

- `shasum -a 256` over the vendored bundle matches issue #707 Appendix A for the six untouched files; the two `.js` files differ only by the prepended waiver line.
- Governance repo-hygiene: waiver headers accepted (file-size-limit), no debug statements, no merge markers, all files under 5 MB.

```sh
bun run format:check
git diff --check
```

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code-8ac80ba9-318-1785757105-1 | claude-code | 8ac80ba9-318d-4598-a125-4ad8b77bda7d | #707 | claude-fable-5 | 229 | 1426930 | 15368439 | 189833 | 1616992 | 42.6990 | 229 | 1426930 | 15368439 | 189833 | docs(design): vendor Binding Layer handoff bundle (#707)Vendors the design-agent |
| claude-code-8ac80ba9-318-1785757205-1 | claude-code | 8ac80ba9-318d-4598-a125-4ad8b77bda7d | #707 | claude-fable-5 | 6 | 3297 | 558612 | 1455 | 4758 | 0.6726 | 235 | 1430227 | 15927051 | 191288 | docs(design): vendor Binding Layer handoff bundle (#707)Vendors the design-agent |
| claude-code-8ac80ba9-318-1785757641-1 | claude-code | 8ac80ba9-318d-4598-a125-4ad8b77bda7d | #707 | claude-fable-5 | 32 | 64892 | 3100146 | 25396 | 90320 | 5.1814 | 267 | 1495119 | 19027197 | 216684 | docs(design): vendor Binding Layer handoff bundle (#707)Vendors the design-agent |

### Steering

| steer-key | session | issue | type | tier | user-reason | commit | ordinal | timestamp |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| steer-8ac80ba9-1785756384-1 | 8ac80ba9-318d-4598-a125-4ad8b77bda7d | #707 | interrupt | structural |  | pending | 1 | 2026-08-03T11:26:24.927Z |

## Steering

- Every human-steering event in the transcript is recorded as a row: **PASS** — one interrupt at 2026-08-03T11:26:24.927Z ("[Request interrupted by user]") is recorded.
- No non-steering message is recorded as a steering event: **PASS** — other user messages (task requests, questions about file attachments, local /model commands) are not mid-task redirects and are not recorded.

## Audit

- '## What changed' faithfully describes the diff: **PASS** — receipt accurately describes 5 `.dc.html` files + README.md + two `.js` files with governance waivers, plus config exclusions, matching the staged diff exactly.
- Each '- [x]' item in '## Checklist' is realized in the diff: **PASS** — Phase 0 (vendor handoff bundle) is checked and the bundle is fully vendored in the diff.
- The '## Checklist' mirrors the issue's checklist: **PASS** — 38 items across 7 phases match issue #707 Action items (P0: 3, P1: 8, P2: 2, P3: 4, P4: 7, P5: 3, P6: 7, P7: 4).

