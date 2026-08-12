# issue-747 — Binding layer v4s + v7: four faces to two, sixteen type pairs to nine

GitHub issue: [#747](https://github.com/srikanth235/centraid/issues/747)

Two rulings were made against the binding layer and both are applied here.

- **v4s — standardization.** The system had four typefaces an app could end up
  drawing in and five page tones it could choose between. Both are withdrawn.
  There are now **two bundled faces**, and the face a piece of text takes is a
  property of its **role**, not of the app it appears in. (The tone axis was
  already retired in this repo — see `themes/shared.ts` — so v4s's colour half
  needed documentation, not code.)
- **v7 — simplification.** An audit found a second, undocumented system living
  inside the first: 122 hand-branched surface decisions, 16 weight+size pairs
  against a ramp of 7 sizes, 8 radius values against a scale of 4, and gaps
  below the 4px base. This repo had already folded the radius scale and the
  spacing scale; what remained was the type fold, the two named sub-base seams,
  and the touch floor.

**No screen changes shape.** Every value here resolves to what was already
drawn, with the three deliberate exceptions listed under Verification.

**On the issue number — read this before the checklist.** #747 is the binding-
layer umbrella issue, and this work is filed under it because governance
requires a trailing issue reference. It is **not** an implementation of #747 as
written: that issue proposes the OPPOSITE ramp — five faces, Schibsted Grotesk,
Spline Sans Mono, weights 500/600, display 34/40, ten `.woff2` — and argues
explicitly that `mono` must stay at 11.5 *so that `--t-mono-size` keeps being
emitted*, which is the exact rung this change deletes. The v4s and v7 rulings
supersede it. [#748](https://github.com/srikanth235/centraid/pull/748), which
implemented the five-face ramp, was **closed unmerged on 2026-08-12** — so there
is no competing branch to reconcile, and its receipt is absent from this tree.
Nothing here closes #747 either: the issue's own text still describes the
superseded ramp, and a maintainer should amend or re-file it. The checklist
below is this change's own, not a mirror of that issue's sections.
Issue §B's three new ratchet metrics and §C (founding creates one vault) are
untouched here.

## Checklist

- [x] Typography — the two bundled faces; `display` draws in serif, `mono` in sans
- [x] Type scale — `reading` 19/33 to 19/31; the numeric role 11.5/16 to 11/15
- [x] Size rungs — seven to six; `--t-mono-size` folds onto `--t-control-size`
- [x] Fonts — un-vendor `Instrument Serif` and `DM Mono`; ten files to six
- [x] Space — `--sp-hair` and `--sp-gutter` are the only sub-base values
- [x] Surface — `--target-min` is 44 on touch and 34 (not 32) under a pointer
- [x] Native parity — Expo loads the same two faces, and a test enforces it
- [x] DESIGN.md — front matter, ramp table, invariant 2, freedom table
- [x] Docs — `docs/traps/design-tokens.md` and `docs/platform-gating.md`

## What changed

**Typography — four faces to two.** `packages/design/src/typography.ts` splits
what used to be one `FontFamily` union into `BundledFace` (`sans`, `serif` —
the two the package ships `.woff2` bytes for) and `FontFamily`, which adds
`mono`. The `display` role now draws in `serif`, and the `mono` role — the
NUMERIC role — draws in `sans` and keeps its `variantNumeric`, `direction` and
`unicodeBidi` modifiers. Both role names survive: ~470 sites spell them, and
what changed is what they mean, not what they are called.

`mono` as a FAMILY survives too, but it is no longer a face: `fontStacks.mono`
is the platform code stack (`ui-monospace, SFMono-Regular, Menlo, …`) and
downloads nothing. See Out of scope for why.

**Type scale — 16 pairs to 9.** `reading` moves 19/33 → **19/31**. The numeric
role moves 11.5/16 → **11/15**: half a pixel from 11 is not a step, and 11.5px
lowers to `.71875rem`, which is where a ladder stops being a ladder. It
therefore shares the 11px rung with `control`, so `typeSizeRungs` publishes
**six** rungs instead of seven and `--t-mono-size` is gone. **54** files move
to `--t-control-size` — the one name for that number — removing 160
`--t-mono-size` lines; 52 are stylesheets, the other two `DESIGN.md` and
`scripts/lint-design-tokens.test.mjs`, whose fixture spelled the retired rung.
`packages/design/src/css-properties.test.ts` also drops it from the expected
rung list, but that is the assertion moving, not a call site. The `--t-mono`
shorthand and its modifiers are untouched; only the bare size rung folded.

**Fonts — ten files to six.** `font-faces.ts`, `fonts.ts` and the vendored
`packages/design/fonts` directory drop `instrument-serif` and `dm-mono` (four
`.woff2` files), and `packages/design/package.json` drops the two `@fontsource`
dependencies that provided them. `fonts.test.ts` pins the count at six and
asserts no bytes exist for the code stack, so the two-download win cannot be
quietly undone.

**Space — the two named seams.** `density.ts` gains `subBase = { hair: 1,
gutter: 2 }`, emitted by both sheets as `--sp-hair` / `--sp-gutter` on the same
`--sp-` namespace as the six rungs and added to the token contract. Bound at the
sites the ruling names: the Photos mosaic seam (`Timeline`, `LoadingGrid`,
`Picker`, `Duplicates`, `DuplicateReview` — the repo already called this "the
one place content touches content") and three tight text stacks.

**Surface — one axis, and the touch floor is a floor.** `metrics` gains
`controlTouch: 44`. `--target-min` now starts from it and the `(pointer: fine)`
override lowers it to `metrics.control` — **34px, not the 32px literal it used
to carry**, which sat off the scale in both directions. `blueprint.ts` stops
re-typing `--h-control` / `--h-row` / `--h-segmented` as literals and reads
`metrics`, matching what `css.ts` already did.

**Native parity (desktop must not diverge from Expo).** The generated theme is
the seam, so it is where the parity is enforced:

- `apps/mobile/src/kit/theme/generate.ts` — `FONT_ROLES` is now exactly the two
  bundled genera; `tokens.generated.ts` regenerates with `display` drawing in
  `serif`, `mono` in `sans` with `['tabular-nums']`, and `reading` at 17.5/29.
- `apps/mobile/App.tsx` — `useFonts` loads three `.ttf` files instead of seven;
  `apps/mobile/package.json` drops `@expo-google-fonts/dm-mono` and
  `@expo-google-fonts/instrument-serif`.
- `apps/mobile/src/kit/theme/index.ts` — `family.displayRegular` /
  `displayItalic` are deleted, along with the `FAMILY_BY_WEIGHT.display` row;
  **10** call sites across 8 files move to `family.serifRegular`;
  `family.monoRegular` / `monoMedium` become the platform monospace via
  `Platform.select`, matching `--font-mono` on the web sheet and loading nothing.
- `generate.test.ts` gains a test that every role's family is a key the shared
  `fontStacks` publishes — the assertion that makes a future web-only face
  deletion fail on the phone instead of drifting.

**DESIGN.md.** Front matter re-pinned (`display` → Source Serif 4, `reading`
lineHeight 31, `mono` → Instrument Sans 11/15). Invariant 2 becomes "One ramp,
two faces" and drops the register choice. The freedom table loses **Primary
register** and gains **Surface**, marked FIXED; the prose explains both
removals. `design-md.test.ts` asserts the new shape, including that a
`| Primary register |` row cannot come back.

**Harness grounding.** `packages/gateway/src/skills/ui-grounding.ts` rewrites
the type line a generating harness is grounded on. It now says plainly that
`--t-mono` is the NUMERIC role — the sans with tabular figures — and that
`var(--font-mono)` is the platform CODE stack that belongs only on code, a path
or a key shown verbatim, never on a number. Without this the ruling holds for
hand-written CSS and leaks straight back in through generated apps.

**Desktop preload.** `apps/desktop/src/main/preload-core.test.ts` moves its
`@font-face` assertion from `toHaveLength(10)` to `toHaveLength(6)`, on both the
source list and the `fonts/`-prefixed filter. It is the desktop's own proof that
the faces are declared ahead of the first `var(--font-sans)` lookup and served
from the app bundle, so the count is part of the contract, not an incidental
number.

**CHANGELOG.** Two entries under `### Changed` and `### Removed`, both citing
#747 — the ramp/register change and the two withdrawn faces with their shipped
file counts on each surface. CHANGELOG is the release-notes source (D3), so the
user-visible half of this change has to land there or it never reaches a
release body.

**Native numeric leading.** Beyond the three web pixel changes tabled under
Verification, the phone's numeric role moves 12.5/18 → **13/17** in
`tokens.generated.ts`. That is not a separate decision: the role changed genus
from `mono` (native delta +1/+2) to `sans` (+2/+2), so the lowering follows the
web fold rather than being tuned.


### File manifest
Every path in this change set, so nothing lands unnamed.
**The design package — the token source** (16)
- `packages/design/fonts/dm-mono-latin-400-normal.woff2`
- `packages/design/fonts/dm-mono-latin-ext-400-normal.woff2`
- `packages/design/fonts/instrument-serif-latin-400-normal.woff2`
- `packages/design/fonts/instrument-serif-latin-ext-400-normal.woff2`
- `packages/design/kit/kit.css`
- `packages/design/package.json`
- `packages/design/src/blueprint.ts`
- `packages/design/src/contract.ts`
- `packages/design/src/css-properties.test.ts`
- `packages/design/src/css.ts`
- `packages/design/src/density.ts`
- `packages/design/src/design-md.test.ts`
- `packages/design/src/font-faces.ts`
- `packages/design/src/fonts.test.ts`
- `packages/design/src/fonts.ts`
- `packages/design/src/typography.ts`
**Expo native — the parity surface** (14)
- `apps/mobile/App.tsx`
- `apps/mobile/package.json`
- `apps/mobile/src/apps/assistant/Assistant.styles.ts`
- `apps/mobile/src/apps/automations/AutomationThread.tsx`
- `apps/mobile/src/apps/automations/Automations.styles.ts`
- `apps/mobile/src/apps/insights/GatewayAlerts.tsx`
- `apps/mobile/src/apps/insights/Insights.styles.ts`
- `apps/mobile/src/kit/theme/generate.test.ts`
- `apps/mobile/src/kit/theme/generate.ts`
- `apps/mobile/src/kit/theme/index.ts`
- `apps/mobile/src/kit/theme/tokens.generated.ts`
- `apps/mobile/src/screens/Settings.tsx`
- `apps/mobile/src/screens/home/VaultHeader.tsx`
- `apps/mobile/src/screens/home/VaultsSwitcher.tsx`
**Desktop and web hosts** (2)
- `apps/desktop/src/main/preload-core.test.ts`
- `apps/web/tests/e2e/perf-budgets.ts`
**Shell stylesheets — the rung fold** (46)
- `packages/client/src/react/screens/AppSettingsPanel.module.css`
- `packages/client/src/react/screens/ApprovalsScreen.module.css`
- `packages/client/src/react/screens/AssistantScreen.module.css`
- `packages/client/src/react/screens/AtlasBrowseTab.module.css`
- `packages/client/src/react/screens/AtlasRelationsTab.module.css`
- `packages/client/src/react/screens/AtlasScreen.module.css`
- `packages/client/src/react/screens/AutomationCompilePane.module.css`
- `packages/client/src/react/screens/AutomationEditorScreen.module.css`
- `packages/client/src/react/screens/AutomationTemplatesScreen.module.css`
- `packages/client/src/react/screens/AutomationThreadScreen.module.css`
- `packages/client/src/react/screens/AutomationsOverviewScreen.module.css`
- `packages/client/src/react/screens/BackupCard.module.css`
- `packages/client/src/react/screens/BuilderChatPane.module.css`
- `packages/client/src/react/screens/DevicePairPanel.module.css`
- `packages/client/src/react/screens/DevicesCard.module.css`
- `packages/client/src/react/screens/GatewayScreen.module.css`
- `packages/client/src/react/screens/InsightsScreen.module.css`
- `packages/client/src/react/screens/LocalFootprintCard.module.css`
- `packages/client/src/react/screens/LogsScreen.module.css`
- `packages/client/src/react/screens/PaletteScreen.module.css`
- `packages/client/src/react/screens/RecoverScreen.module.css`
- `packages/client/src/react/screens/ResourceDialogs.module.css`
- `packages/client/src/react/screens/RunViewScreen.module.css`
- `packages/client/src/react/screens/SettingsConnectionsScreen.module.css`
- `packages/client/src/react/screens/SettingsDiagnosticsScreen.module.css`
- `packages/client/src/react/screens/SettingsStorageScreen.module.css`
- `packages/client/src/react/screens/StorageLimitsPanel.module.css`
- `packages/client/src/react/screens/WhatsNewModal.module.css`
- `packages/client/src/react/shell/CaptureOverlay.module.css`
- `packages/client/src/react/shell/routes/AppViewRoute.module.css`
- `packages/client/src/react/shell/routes/ConnectFlow.module.css`
- `packages/client/src/react/shell/routes/VaultModal.module.css`
- `packages/client/src/react/shell/routes/assistantRich.module.css`
- `packages/client/src/react/shell/routes/builder/BuilderAutomationPane.module.css`
- `packages/client/src/react/shell/routes/builder/BuilderCloud.module.css`
- `packages/client/src/react/shell/routes/builder/BuilderCode.module.css`
- `packages/client/src/react/shell/routes/builder/BuilderHistory.module.css`
- `packages/client/src/react/shell/routes/builder/BuilderPreview.module.css`
- `packages/client/src/react/shell/routes/builder/BuilderShell.module.css`
- `packages/client/src/react/shell/webhookReveal.module.css`
- `packages/client/src/react/styles/automation.module.css`
- `packages/client/src/react/styles/chatMessage.module.css`
- `packages/client/src/react/styles/controls.module.css`
- `packages/client/src/react/styles/linkBtn.module.css`
- `packages/client/src/react/styles/seg.module.css`
- `packages/client/src/react/styles/vault.module.css`
**Blueprint apps — the rung fold and the mosaic seam** (10)
- `packages/blueprints/apps/locker/components/List.module.css`
- `packages/blueprints/apps/locker/components/Sidebar.module.css`
- `packages/blueprints/apps/photos/components/DuplicateReview.module.css`
- `packages/blueprints/apps/photos/components/Duplicates.module.css`
- `packages/blueprints/apps/photos/components/LoadingGrid.module.css`
- `packages/blueprints/apps/photos/components/Picker.module.css`
- `packages/blueprints/apps/photos/components/PlaceMap.module.css`
- `packages/blueprints/apps/photos/components/Timeline.module.css`
- `packages/blueprints/apps/tasks/components/Capture.module.css`
- `packages/blueprints/apps/tasks/components/Detail.module.css`
**Gateway — harness grounding** (1)
- `packages/gateway/src/skills/ui-grounding.ts`
**Root docs** (5)
- `CHANGELOG.md`
- `DESIGN.md`
- `bun.lock`
- `docs/platform-gating.md`
- `docs/traps/design-tokens.md`
**Receipts and scripts** (2)
- `receipts/issue-747-binding-layer-v4s-v7.md`
- `scripts/lint-design-tokens.test.mjs`

## Decisions

**The code face is kept, against a literal reading of the ruling.** v4s deletes
`DM Mono` because numerics become sans+tabular. It says nothing about code,
because the design reference contains none. This repo has a fenced-code
highlighter, the builder's editor pane, keyboard chips, and recovery keys and
tickets shown verbatim. Setting those in a proportional face is a regression the
ruling never asked for, so `--font-mono` survives — repointed at the platform
stack, which ships no bytes. The ruling's own measured win, two fewer font
downloads, is unaffected. If this is wrong, the fix is one line in `fontStacks`.

**The issue number is a container, not a claim of implementing #747.** #747
describes the opposite ramp and its PR was closed unmerged. Governance requires
a trailing issue reference on every commit; #747 is the binding-layer umbrella,
so this rides under it and says so in the open. The independent audit below
records REFUTED on "checklist mirrors the issue" for exactly this reason, and
that verdict is correct and deliberately left standing.

**`--t-mono-size` was folded rather than preserved by reordering.** The 11.5 →
11 fold makes the numeric role share a rung with `control`, and `typeSizeRungs`
publishes one name per distinct size. Declaration order decides which name wins,
so `--t-mono-size` could have been kept by moving `mono` ahead of `control` —
at the cost of deleting `--t-control-size`, which has 407 call sites against
`--t-mono-size`'s 174. Keeping the more-used name and moving the other is the
smaller, and the semantically honest, change: there is one 11px rung.

**`--target-min` under a pointer moved 32px → 34px, which is a real change.**
The ruling's `CTL = touch ? 44 : 34` made the old 32 literal visible as
off-scale — smaller than `metrics.control`, and reached by a hard-coded number
rather than the metric. Corrected rather than preserved, and called out under
Verification as one of the deliberate pixel changes.

**The `SURF` resolver was not added.** §C says resolve the surface once into a
token set and read the object everywhere. There is no single surface state in
this repo to resolve into, and Knip fails an exported resolver with no call
site. The two halves that do have call sites — the 44px floor and the one-word
surface rule — are implemented and documented instead. See Out of scope.

## Out of scope

- **The code face is kept, deliberately.** The handoff deletes `DM Mono`
  because numerics become sans+tabular; it says nothing about code, because the
  design reference has no code in it. This repo does: a fenced-code
  highlighter, the builder's editor pane, keyboard chips, and recovery keys and
  tickets shown verbatim — ~473 `var(--font-mono)` sites. Rendering those in a
  proportional face is a regression the ruling never asked for, so `--font-mono`
  survives as the **platform** stack. Both webfont downloads are still removed,
  which is the ruling's own measured win.
- **The numeric sites still spelled `font-family: var(--font-mono)`.** Ratcheted,
  not fixed. Those that are numbers rather than code should move to `font:
  var(--t-mono)` with its modifiers; each needs a human to decide which it is.
  Same posture #747 already takes for the ~375 raw font-sizes. `--t-mono` itself
  is correct today wherever it is used.
- **The `SURF` resolver.** §C's "resolve the surface once into a token set" has
  no call site in this repo to resolve *into* — there is no single surface state
  today (see `docs/platform-gating.md`, judgment-only). Adding an unused
  exported resolver would fail Knip. The ruling is documented as the rule, and
  the two mechanical halves that *do* have call sites — the 44px touch floor and
  the one-word surface enum — are enforced and written down.
- **The six enforcement lint rules.** Documented in `docs/platform-gating.md`
  and `docs/traps/design-tokens.md`; not yet mechanical. `lint-design-tokens`
  already covers literal font stacks and raw sizes.

## Verification

### Commands a reviewer can re-run

```sh
# The design package: ramp, rungs, emitted sheets, DESIGN.md pinning.
bun run --cwd packages/design test
bun run --cwd packages/design typecheck

# Native parity: the generated module must match the shared lowering byte for
# byte, and every role must draw in a genus `fontStacks` publishes.
bun run --cwd apps/mobile generate:theme && git diff --exit-code apps/mobile/src/kit/theme/tokens.generated.ts
bun run --cwd apps/mobile test src/kit/theme/generate.test.ts

# Six .woff2 files ship, not ten; no bytes for the code stack.
ls packages/design/fonts | wc -l          # 6
ls packages/design/fonts | grep -c 'dm-mono\|instrument-serif'   # 0

# The retired rung is gone from every call site.
rg -c -- '--t-mono-size' packages apps scripts DESIGN.md   # no matches

# The whole push-tier gate.
bun run check:push
```

### Checklist crosswalk

Each checked item, and where the work behind it is described.

- **Typography — the two bundled faces; `display` draws in serif, `mono` in sans** — see `## What changed`.
- **Type scale — `reading` 19/33 to 19/31; the numeric role 11.5/16 to 11/15** — see `## What changed`.
- **Size rungs — seven to six; `--t-mono-size` folds onto `--t-control-size`** — see `## What changed`.
- **Fonts — un-vendor `Instrument Serif` and `DM Mono`; ten files to six** — see `## What changed`.
- **Space — `--sp-hair` and `--sp-gutter` are the only sub-base values** — see `## What changed`.
- **Surface — `--target-min` is 44 on touch and 34 (not 32) under a pointer** — see `## What changed`.
- **Native parity — Expo loads the same two faces, and a test enforces it** — see `## What changed`.
- **DESIGN.md — front matter, ramp table, invariant 2, freedom table** — see `## What changed`.
- **Docs — `docs/traps/design-tokens.md` and `docs/platform-gating.md`** — see `## What changed`.


- `bun run --cwd packages/design test` — **308 passed**. `edge-upload` /
  `kit-smoke` fail to *collect* on an unbuilt workspace (`@centraid/blob-format`
  unresolved) both before and after this change.
- `bun run --cwd packages/design typecheck` — clean.
- `bun run --cwd apps/mobile test` — **985 passed, 0 failed**. The 15 file-level
  collection failures are unbuilt-workspace imports (`@centraid/protocol`,
  `@centraid/time-engine`), unrelated and pre-existing.
- `bun run --cwd apps/mobile generate:theme` — regenerated; the freshness test
  (`keeps the checked-in native module fresh`) passes, so the committed native
  module and the shared lowering agree byte for byte.

**The three deliberate pixel changes**, all folds the audit named:

| What | Was | Now | Where |
| --- | --- | --- | --- |
| Numeric role | 11.5/16 DM Mono | 11/15 sans, tabular | every `--t-mono` site |
| Reading leading | 19/**33** | 19/**31** | prose in Docs, Notes, empty states |
| Pointer target floor | 32px | 34px | `--target-min` under `(pointer: fine)` |

Everything else resolves to what was already drawn. The display role changes
FACE (Instrument Serif → Source Serif 4) at the same 31/36; that is the one
visible-but-unmeasured change, and it is the ruling's whole point.

`apps/web/tests/e2e/perf-budgets.ts` is annotated but **not** re-baselined: its
ceilings are measured in CI, not derived. The next web-e2e run should come in
~4 requests and ~30 KB under them, and that measurement is what a tightening
ratchet should be written from.

## Audit

Independent attestation of the staged diff against this receipt and against
[#747](https://github.com/srikanth235/centraid/issues/747). Round 2: the first
pass refuted checks 1 and 3, the receipt prose was corrected, and every figure
below was re-measured from the staged tree rather than read from the receipt.
The code diff is byte-identical between rounds — 95 files, +526/−332 excluding
this receipt — so nothing here rests on a re-run.

### 1. `## What changed` faithfully describes the diff — **PASS**

Both counts that were wrong in round 1 are now right, and the four files that
were described nowhere are now described. Re-measured:

```
for f in $(git diff --cached --name-only); do
  r=$(git diff --cached -U0 -- "$f" | grep -c '^-.*--t-mono-size')
  a=$(git diff --cached -U0 -- "$f" | grep -c '^+.*--t-control-size')
  [ "$r" -gt 0 ] && [ "$a" -gt 0 ] && echo "$f"
done | wc -l                                    → 54   (52 of them `*.css`)
git diff --cached -U0 -- . ':(exclude)receipts/*' \
  | grep -c '^-.*--t-mono-size'                 → 160
git diff --cached -U0 -- apps/mobile \
  | grep -c '^-.*fontFamily: family.display'    → 10   (across 8 files)
```

The two non-stylesheet members of the 54 are exactly `DESIGN.md` and
`scripts/lint-design-tokens.test.mjs`, as written; the added
`+ fontFamily: family.serifRegular` count is also 10, in `Assistant.styles.ts`,
`AutomationThread.tsx`, `Automations.styles.ts`, `GatewayAlerts.tsx`,
`Insights.styles.ts` (2), `Settings.tsx`, `home/VaultHeader.tsx` and
`home/VaultsSwitcher.tsx` (2). `FAMILY_BY_WEIGHT.display` is indeed deleted
alongside the two `family` map entries, which is what makes 12 deletions read as
10 call sites.

The four added paragraphs check out against the diff:

- **Harness grounding** — `packages/gateway/src/skills/ui-grounding.ts` rewrites
  exactly one grounding line, and the replacement says what the paragraph says
  it says (`--t-mono` is the numeric role in the sans; `var(--font-mono)` is the
  platform code stack, "never on a number").
- **Desktop preload** — `apps/desktop/src/main/preload-core.test.ts` moves
  `toHaveLength(10)` → `toHaveLength(6)` on both the `src: url(…)` match list
  and the `fonts/`-prefixed filter. Both halves, as claimed.
- **CHANGELOG** — two entries, one under `### Changed` and one under
  `### Removed`, both citing #747.
- **Native numeric leading** — `tokens.generated.ts` moves `mono` from
  `12.5/18` to `13/17`, and the stated cause is arithmetically right:
  `NATIVE_DELTA_BY_FAMILY.mono` is `{size: 1, lineHeight: 2}` and `.sans` is
  `{size: 2, lineHeight: 2}`, so the web fold 11.5/16 → 11/15 lowers to
  11.5+1/16+2 → 11+2/15+2.

Folding `scripts/lint-design-tokens.test.mjs` into the rung-fold sentence rather
than giving it a paragraph is **sufficient**: it is named, its role is stated
(its fixture spelled the retired rung), and it is a one-line test fixture with
no behaviour behind it — `scripts/lint-design-tokens.mjs` itself is untouched.

Two things deliberately checked and accepted rather than flagged:
`docs/platform-gating.md` (+9) and `docs/traps/design-tokens.md` (+28) have no
paragraph under `## What changed`, but both are named in `## Checklist` and
their content is described in `## Out of scope`; nothing about them is hidden.
`bun.lock` is a mechanical consequence of the two `package.json` edits.

One nit, recorded not charged: "**54** files move to `--t-control-size` … removing
160 `--t-mono-size` lines" attributes all 160 to the 54, when 159 come from them
and the 160th is the `css-properties.test.ts` assertion — which the very next
sentence discloses. 160 is the correct diff-wide total; only the clause order is
loose.

Spot-checked approximations, both fair: `rg 'var\(--font-mono\)'` outside
`node_modules`/`dist`/`receipts` returns **467** against the receipt's "~473",
and `--t-mono*`/`--t-display*` spellings return **444** against "~470".

### 2. Every `- [x]` in `## Checklist` is realized in the diff — **PASS**

The checklist and the diff are both unchanged from round 1; the evidence stands.

| Item | Evidence |
| --- | --- |
| Typography — four faces to two | `packages/design/src/typography.ts`: `fonts` loses `display`/`mono`; `BundledFace` added; `type.display.family` `"display"` → `"serif"`; `type.mono.family` `"mono"` → `"sans"` keeping `variantNumeric: "tabular-nums"` |
| Type scale | same file: `reading.lineHeight` 33 → 31; `mono` 11.5/16 → 11/15 |
| Size rungs seven → six | `css-properties.test.ts` expected rung list drops `--t-mono-size` and `0.71875rem`; 54 files move to `--t-control-size` |
| Fonts un-vendored | four `.woff2` deleted (`git diff --cached --diff-filter=D --name-only`), `packages/design/fonts` 10 → 6, `FONT_FILES` `toHaveLength(10)` → `(6)`, new `fonts.test.ts` case "vendors no bytes for the platform code stack", both `@fontsource` deps dropped |
| Space — the two sub-base names | `density.ts` `subBase = { gutter: 2, hair: 1 }`; emitted by `css.ts` and `blueprint.ts`; added to `contract.ts`; bound at 5 Photos components (`--sp-gutter`) and exactly 3 text stacks — `AtlasBrowseTab`, `AutomationThreadScreen`, `InsightsScreen` (`--sp-hair`) |
| Surface — 44 / 34 | `metrics.controlTouch = 44`; both sheets emit `--target-min: ${metrics.controlTouch}px` and `@media (pointer: fine) { … ${metrics.control}px }`; test now expects `--target-min: 34px` |
| Native parity | `generate.ts` `FONT_ROLES` = `{ sans, serif }`; `App.tsx` drops exactly four `.ttf` imports so `useFonts` goes 7 → 3; `generate.test.ts` adds "draws every role from a genus the web sheet also publishes", asserting each `theme.type[*].family` ∈ `Object.keys(fontStacks)` |
| DESIGN.md | front matter `display.fontFamily` → Source Serif 4, `reading.lineHeight` → 31px, `mono` → Instrument Sans 11/15; invariant 2 → "One ramp, two faces"; freedom table drops `Primary register`, adds `Surface` marked FIXED; `design-md.test.ts` pins it, including `not.toContain("| Primary register |")` |
| Docs | `docs/traps/design-tokens.md` +28 (two new normative sections + checklists), `docs/platform-gating.md` +9 ("One surface word", the 44px floor, the do-not line) |

No `- [x]` line is aspirational, and no live `var(--font-display)` or
`var(--t-mono-size)` call site survives the removals (`rg` over
`*.css`/`*.ts`/`*.tsx` outside `node_modules` returns only prose and comments).

### 3. `## Checklist` mirrors the linked issue — **REFUTED**

Unchanged from round 1, and the receipt now says so itself. The new
pre-checklist paragraph is a **disclosure** of the mismatch, not a resolution of
it — it ends "the checklist below is this change's own, not a mirror of that
issue's sections", which is the finding, stated by the author. The verdict
therefore stays REFUTED on the merits:

- #747 has **no checklist to mirror**: three lettered prose sections (A type
  system, B adoption and enforcement, C founding creates one vault), zero
  `- [ ]`/`- [x]` items, zero comments (`issue_read method=get_comments` → `[]`).
- The substance is opposed, not merely different. #747 specifies **Schibsted
  Grotesk** body sans, **Spline Sans Mono** replacing DM Mono, **Instrument
  Serif** entering as the display cut, **five faces / ten `.woff2` / ~23 KB net
  growth**, weights **500/600**, `display` **34/40** — and argues `mono` must
  stay at 11.5 *because* at 11px "`control` would claim the rung and
  `--t-mono-size` would stop being emitted". This diff keeps Instrument Sans at
  400/500, deletes Instrument Serif and DM Mono outright, ships six `.woff2`,
  puts `display` at 31/36, and deletes `--t-mono-size` — the outcome #747 gives
  as its reason not to do this.
- Issue §B's ratchet metrics (`typeSizeRung`, `roleModifierGap`, `rawFontWeight`
  reading the `font:` shorthand) are absent: `scripts/lint-design-tokens.mjs` is
  untouched and only its test fixture changes. Issue §C (founding creates one
  vault) is untouched — nothing in the diff goes near founding.
- The organising frame, "v4s" and "v7", appears nowhere in #747's body or
  comments and nowhere in this repo outside this receipt and the comments this
  change adds.

**One factual correction the maintainer should make before merge.** The new
paragraph calls #748 "an open PR against it". It is not: `pull_request_read` on
`srikanth235/centraid#748` returns `state: "closed"`, `merged: false`,
`mergeable_state: "dirty"`, `closed_at: 2026-08-12T10:54:09Z` — closed today
without merging, and its receipt
(`receipts/issue-747-binding-layer-type-ramp.md`) is absent from this tree. The
conflict the paragraph describes is real and the "a maintainer has to choose"
framing is right in substance, but the competing PR has already been closed
unmerged, so the choice may in fact have been made. Fixing this does not change
the verdict.

### Verdicts

| Check | Round 1 | Round 2 |
| --- | --- | --- |
| 1. `## What changed` is faithful | REFUTED | **PASS** |
| 2. `- [x]` items are realized | PASS | **PASS** |
| 3. Checklist mirrors the issue | REFUTED | **REFUTED** |

Check 3 is not fixable by prose. It clears when the work is filed against an
issue that describes it — a new issue, or an amendment comment on #747 that the
checklist can actually mirror.

## Session

<!-- Session identifiers are maintained by the agent-session-identity pre-commit hook. -->

### Identifiers

| date | harness | session |
| --- | --- | --- |
| 2026-08-12 | claude-code | 442190df-e044-555e-999b-c3513be69d9b |
