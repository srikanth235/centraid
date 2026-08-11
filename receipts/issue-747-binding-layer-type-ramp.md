# issue-747 — The binding layer: one type ramp that holds on web, desktop, and native

<!-- governance: allow-receipt-per-issue (#747) the ramp only holds if call sites use it, so this change set is a cross-cutting role migration across ~150 CSS module files in packages/client and packages/blueprints that carry no decision of their own — each swaps a hand-rolled size/weight pair for `font: var(--t-<role>)`. This receipt names every file that carries a judgment (the ramp, the faces, the native theme, the gate, the docs, the founding companion) and records the migrated surface by owned directory; enumerating 150 mechanically identical CSS paths would bury the audit narrative rather than serve it. -->

GitHub issue: [#747](https://github.com/srikanth235/centraid/issues/747)

Body text read thin on a dark ground. Measured rather than guessed: the old
sans at 400 lays down ~18% less ink per pixel than the faces beside it, while
the same text measures 8.08:1 against its ground — above AAA. The face was
light; contrast and smoothing were not the problem.

Raising the weight was gated by native. React Native cannot combine
`fontFamily` with `fontWeight` and cannot reach a variable font's axes, so
every weight must exist as a separately-named **static** file. That constraint
picked the face.

## Checklist

- [x] Faces swapped and vendored
- [x] The ramp re-cut on two registers
- [x] Native parity
- [x] Call-site adoption
- [x] The gate tightened
- [x] Docs updated
- [x] Founding creates one vault

## What changed

**Faces swapped and vendored.** `packages/design/src/typography.ts` moves
`fonts.sans` to **Schibsted Grotesk** and `fonts.mono` to **Spline Sans Mono**;
**Instrument Serif** enters as the display cut and **Source Serif 4** stays as
the reading register. `packages/design/src/font-faces.ts` re-slugs both and
declares the shipped instances; `packages/design/src/fonts.ts` resolves the new
Fontsource roots; `packages/design/package.json` + `bun.lock` follow. Ten woff2
land under `packages/design/fonts/` (five faces × latin/latin-ext) and the old
`instrument-sans-*` / `dm-mono-*` binaries are deleted. Net ~23 KB, inside the
existing 520 KB first-paint ceiling — `apps/web/tests/e2e/perf-budgets.ts`
records the new faces and the headroom.

Schibsted Grotesk was chosen for one decisive property: it ships real **static**
500/600/700. No other OFL candidate closed the ink gap at 400 — each was
equivalent to a small weight bump on the face we had — so the answer was weight,
and weight on native means static cuts.

**The ramp re-cut on two registers.** The sans draws at exactly two weights:
500 is regular, 600 is strong. The serifs and the mono are 400-only.

| role | size/leading | face | weight |
| --- | --- | --- | --- |
| `display` | 34/40 | Instrument Serif | 400, −0.01em |
| `title` | 20/26 | sans | 600 |
| `reading` | 19/33 | Source Serif 4 | 400 |
| `body` | 15/22 | sans | 500 |
| `bodyStrong` | 15/22 | sans | 600 |
| `small` | 13/19 | sans | 500 |
| `smallStrong` | 13/19 | sans | 600 |
| `control` | 11/15 | sans | 500 |
| `eyebrow` | 11/15 | sans | 500, caps, +0.06em |
| `mono` | 11.5/16 | Spline Sans Mono | 400, tabular |

Native steps `display` and `reading` down by 4 (`NATIVE_DELTA_OVERRIDES`), so
`display` renders at 30/36 on phones. Parity and CSS-shape tests move with it:
`packages/design/src/type-role-parity.test.ts`,
`packages/design/src/css-properties.test.ts`,
`packages/design/src/native-contract.test.ts`.

**Native parity.** `apps/mobile/App.tsx` registers each cut by direct
sub-path — Metro cannot resolve the package barrels — and
`apps/mobile/src/kit/theme/generate.ts` maps the two genera onto them.
`apps/mobile/src/kit/theme/index.ts` rekeys `FAMILY_BY_WEIGHT.sans` to
`{500 → SchibstedGrotesk_500Medium, 600 → SchibstedGrotesk_600SemiBold}` and
reorders the fallback chain so a stale `400` resolves to the regular cut rather
than nothing. `apps/mobile/src/kit/theme/tokens.generated.ts` is regenerated;
`generate.test.ts` and `resolve.test.ts` assert the new family names.
`apps/mobile/src/ErrorBoundary.tsx` and `apps/extension/static/popup.css` drop
their hand-rolled 600s — neither surface is inside the theme.

**Call-site adoption.** ~150 CSS modules across `packages/client/src/react`
(shell, screens, kit) and `packages/blueprints/apps` (agenda, docs, locker,
notes, people, photos, and the shared scaffolds) swap hand-rolled
size/weight pairs for `font: var(--t-<role>)`. `apps/web/src/web.css` and
`packages/client/src/react/screens/AssistantScreen.module.css` are the two worth
reading: the assistant answer is the longest-form reading on any screen and now
takes the `body` role outright, taking that file from 11 raw font-sizes to 0.

**The gate tightened.** `scripts/lint-design-tokens.mjs` sanctions `600` — and
only because `font-faces.ts` now vendors that instance; the comment says so,
because the previous state was 245 declarations accumulated against a file
nobody shipped while the gate reported zero regressions. Two new metrics land:
`typeSizeRung` (taking `--t-<role>-size` alone gets the size while weight,
leading and family fall back to whatever an ancestor set — native cannot express
this at all) and `roleModifierGap`. `rawFontWeight` now also reads the `font:`
shorthand, whose first slot the longhand scan never saw —
`font: 600 14px var(--font-sans)` sat on the shell's own action button while the
gate reported clean. `tests/design-token-css-budget.json` re-baselines every
touched file downward.

**Docs updated.** `DESIGN.md` front matter carries the per-role
`fontFamily`/`fontWeight`/`fontSize`, the `--t-*` role table, the 34px display
rung, and the native step-down prose.

**Founding creates one vault.** `packages/gateway/src/serve/build-gateway.ts`
founds `Personal` only on a fresh data dir. [#726](https://github.com/srikanth235/centraid/issues/726)
made the vault the unit of sharing — a destination is a vault you own — which
left `Shared` an ordinary vault that founding conjured for no reason, so every
new gateway opened on a room nobody asked for. `build-gateway.test.ts`,
`serve.test.ts`, `apps/desktop/tests/e2e/onboarding-home.spec.ts`, and
`apps/web/tests/e2e/server.ts` follow, as do `ARCHITECTURE.md`, `CHANGELOG.md`,
`docs/decisions.md`, `docs/glossary.md`, and `docs/dev-environment.md` (which
also gains the `centraid-gateway pair --port` note that cost a debugging session).

## Decisions

- **Weight, not face, was the fix — but the face had to change to allow it.**
  The complaint was thinness; the measurement said the face was light; the
  native constraint said extra weights must be static files. Schibsted Grotesk
  is the choice that makes 500-as-regular possible with no variable-font
  machinery. This is the one decision the whole change set hangs on.
- **The strong register is 600, not 700.** The first pass moved the registers by
  unequal amounts (400→500 is +18.9% ink; 500→700 is +27.5%) and the sidebar
  came out shouting — reported as a regression during review. 600 makes the step
  +13.5% and even.
- **`control` is regular, not strong.** 203 call sites — every button label,
  every chip. Stroke weight does not scale down linearly, so an 11px/600 label
  out-weighs the 13px/600 label above it: a hierarchy inversion on every screen.
  Schibsted 500 at 11px measures 2.606 ink against the old control's 2.659,
  within 2%, so nothing loses presence. Affordance was never carried by weight
  anyway — buttons get it from background and border.
- **`mono` sits at 11.5px because it cannot sit at 11.** Forced, not chosen: the
  11px floor blocks going lower, and `typeSizeRungs` dedupes by value, so at 11px
  `control` claims the rung and `--t-mono-size` stops being emitted entirely.
- **`eyebrow` stays at 500.** The +19.9% ink figure that argued for lowering it
  was measured in full-strength ink; eyebrow draws in `--text-soft`/`--text-faint`
  everywhere it appears, so colour carries the recession, and there is no lighter
  sans rung to reach for without breaking the two-register rule.
- **The founding change rides this branch deliberately.** It is unrelated to
  type. It is small, it is already reflected in the docs this branch touches, and
  splitting it into its own branch would have meant re-editing the same
  `CHANGELOG.md` and `docs/decisions.md` lines twice.

## User impact

Text stops reading thin. Body copy, list rows, and the assistant's answers sit
on a heavier regular cut, so a dark screen at 13–15px no longer asks the reader
to lean in; headings and emphasis step up by an even amount instead of jumping,
so nothing shouts. The home greeting picks up a serif display cut — the one
place the product speaks in its own voice — and secrets, paths, and recovery
codes move to a warmer mono with a slashed zero. The same ramp renders on web,
desktop, and the phone; native is not a second system.

One behaviour changes with it: a brand-new gateway now opens with a single
vault of your own rather than a `Personal` and a `Shared` you did not ask for.
Sharing is something you do with a vault you own, so a household space is one
you create deliberately.

First-run: onboarding is unchanged in shape. The changed desktop harness lands
on the fresh Home and emits
`artifacts/e2e/ui-impact/issue-747-binding-layer-type-ramp.png`, which carries
the whole ramp in one frame — greeting in the display serif, tile titles in the
strong register, labels and chips in the regular one. The same harness now
asserts the single auto-founded vault.

## Out of scope

- **~375 raw font-sizes and ~78 bare size rungs repo-wide.** Ratcheted, not
  fixed — each needs a human to pick the right role, which is exactly what the
  new `typeSizeRung` metric is for.
- **`--t-display` scope.** 18 call sites, including persistent chrome
  (`.appTitle` in `packages/client/src/react/shell/chrome.module.css`, Notes
  `.editorTitle`), not only the greeting. Narrowing it to the greeting would push
  17 editorial headlines down to 20px sans, so the scope stands. `.appTitle` is
  the one site that may want a special case — flagged, not changed.
- **`fontFamily: "monospace"`** in `apps/mobile/src/screens/SharingLinkRow.tsx`.
- **`design:gallery` baselines.** `mo-advisory-dark` fails on pristine `main` in
  this environment (local rendering drift), so no snapshot is re-baselined here;
  CI is the authority.

## Verification

```sh
bun run test          # design 334 · client 2031 (230 files) · mobile 1093 (134 files) · blueprints 3335 · gateway
bun run typecheck     # client, mobile, design, gateway
bun run lint:design-md # 0 errors
node scripts/lint-design-tokens.mjs   # 0 off-scale font-weight(s), zero regressions
node scripts/lint-type-floor.mjs      # 207 CSS + 464 mobile files, nothing below 11px
```

Live in the browser pane, against the running dev server, the emitted role
custom properties read:

```json
{
  "control": "500 0.6875rem/0.9375rem",
  "eyebrow": "500 0.6875rem/0.9375rem",
  "smallStrong": "600 0.8125rem/1.1875rem",
  "title": "600 1.25rem/1.625rem"
}
```

Native tokens regenerated and inspected — `control {fontSize: 13, lineHeight:
17, weight: '500'}`, `body {17/24, '500'}`, `display {30/36}`,
`title {22/28, '600'}`.

## Session

<!-- Session identifiers are maintained by the agent-session-identity pre-commit hook. -->

### Identifiers

| date | harness | session |
| --- | --- | --- |
| 2026-08-11 | claude-code | 3afafe8e-09fe-4557-bad2-68b6e36b7252 |
