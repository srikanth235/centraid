# issue-82 — Refined Screens redesign

GitHub issue: [#82](https://github.com/srikanth235/centraid/issues/82)

Applies the **Refined Screens** handover (`ds-update/Handover - Refined
Screens.md`) — the product redesign that sits on top of design-system
v0.5. The DS v0.5 token layer (lighter blue-tinted dark ramp with
`--bg-l`, sidebar tokens, chrome primitives `.cd-window` / `.cd-tb-btn`
/ `.cd-sb-item` / `.cd-status`) already landed in prior work; this issue
applies the screen-level redesign, landed as one commit per step.

## Checklist

- [x] design-tokens — refined-screen icons + Send glyph fix
- [ ] Step 2 — Sidebar restructure (G2/G3)
- [ ] Step 3 — Home redesign (A1/A2/A3)
- [ ] Step 4 — Builder B1–B6
- [ ] Step 5 — Settings monolith split (C)
- [ ] Step 6 — App view copilot (D)
- [ ] Step 7 — Per-app settings tabbed popover (E)
- [ ] Step 8 — ⌘K command palette (F)

## What changed

**design-tokens — refined-screen icons + Send glyph fix.** The redesign
introduces a command palette, a Discover destination, the Builder pane
toolbar, and a rebuilt Cloud surface — all needing glyphs absent from
the shared icon set. Added `Refresh`, `Copy`, `Star`, `Compass`,
`Bolt`, `Globe`, `Phone`, `Tablet`, `Monitor`, and `Command` to
`packages/design-tokens/icons.ts` (the single source of truth for
desktop + mobile). The `Send` icon — previously a plain right-arrow
visually identical to the forward-nav glyph, flagged in §B2 of the
handover — was replaced with a proper paper-plane.

## Out of scope

- The DS v0.5 token + chrome-primitive layer (already landed).
- Mobile-side adoption of the new screens (desktop renderer only).

## Verification

- `bun --filter @centraid/design-tokens run typecheck` — clean
