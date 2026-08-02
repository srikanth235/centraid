# Issue #686 — design platform/apps consistency umbrella

## Checklist

- [x] A1 spacing tokens emitted (`--sp-1`…`--sp-7`) in both contracts
- [x] B1 shell motion token (`--ease`) in `SHELL_TOKEN_CONTRACT`
- [x] A2 consumer-side token-purity ratchet test (blueprint apps)
- [x] A5 reserved-namespace guard (`--c-*` etc.) in the same test
- [x] A2 governance directive `no-hardcoded-colors`
- [x] A3 component vocabulary unified (scaffold ↔ kit)
- [x] A4 scaffold exemplar on tokens
- [x] B2 shell type-scale adoption + ratchet
- [x] B3 shell radius adoption + ratchet
- [x] B4 mono body face decided + documented
- [x] C1 `docs/design-language.md` + AGENTS.md index row + ui-grounding reference
- [x] C2 `.design-sync` stale conventions neutralized
- [x] C3 stale mobile-theming comments fixed
- [x] C4 `styles.css` eaten comment restored
- [x] D1 typeface decision recorded in docs/decisions.md
- [x] D2 mobile color opt-outs migrated/waived
- [x] D3 post-generation CSS validation for agent apps
- [x] E blueprint burn-down (docs, photos, tally, locker, people, agenda, notes, tasks)
- [x] F1 Root `DESIGN.md` conforming to the official google-labs-code/design.md spec + `@google/design.md` linter wired
- [x] F2 One canonical design document (`docs/design-language.md` folded in, `.design-sync/` deleted)
- [x] F3 Fix the WCAG AA failure the linter found (`--on-accent` on the filled primary button)
- [x] F4 Extend the unresolved-`var()` gate to `packages/client` and fix the 13 phantom tokens it found
- [x] F6 composable size rungs + the exact-match sweep

## Decisions (orchestrator recommendations, per user directive)

- **D1 typography = roles, not families.** Web/desktop keep system stacks (#468 K11); mobile keeps its per-role platform mapping, now recorded as decided rather than drift.
- **A2 coexists with the #630 Wave-0 ratchet.** `scripts/lint-design-tokens.mjs` + `tests/design-token-css-budget.json` (landed on main while this branch was in flight) already ratchet rawHex/literalFontFamily across client+blueprints+kit. The new `token-purity` test is complementary — it adds functional color literals, reserved custom-property namespaces, and contract-imported names, blueprint-scope only. Burn-down lanes must shrink BOTH allowlists.
- **E deliberate visual deltas (token semantics over hand-picked values):** tally `--pos`/`--neg` → system `--success`/`--danger`; locker sidebar surface → `--bg-elev`; people re-derives neutrals from `--app-hue: 345` + `--c-rose` accent and drops its Geist/Space Grotesk declarations per the roles decision; agenda light `--warning` → token value; a generator-toggle drop shadow → `--shadow-sm`. All recorded here for review.
- **Photos/docs "theater stage" gap:** 3 residual `hsl(var(--app-hue) 25% 4%)` backdrops exist because the contract has no opaque near-black `--stage` token; follow-up candidate for `packages/design`.
- **kit.css itself still hardcodes type/spacing px** (e.g. `.kit-btn font-size: 0.8125rem`) — the served component layer is the remaining half of full token purity; now visible in the budget (80 rawFontSize in kit) and left as ratcheted debt.
- **Consolidation (user direction): one canonical design document.** `docs/design-language.md` folded into root `DESIGN.md` (its unique content — three-lowerings note, `font` shorthand family-reset caveat, serif role — absorbed; every reference repointed: `AGENTS.md`, `docs/decisions.md`, `packages/design/src/index.ts`, `packages/design/src/design-md.test.ts`, `packages/app-engine/src/registry/token-purity.ts`, `packages/gateway/src/skills/ui-grounding.ts`, `scripts/lint-design-tokens.mjs`) and deleted. `.design-sync/` deleted entirely (user: it no longer makes sense; nothing in the build/test graph reads it) along with its `.gitignore` entries.
- **`EASE` rehomed, `motion.ts` deleted.** A dedicated module for one constant pushed `packages/client/src/index.ts` to 101 modules and tripped oxlint `no-barrel-file` (threshold 100). Rather than weaken the rule, `EASE` moved into `packages/design/src/themes/shared.ts` beside the other measured design constants — no new graph node, still exactly one spelling of the curve. `DESIGN.md` updated to point at the new home. `ACCENT_DEEP_DARK` dropped from the `themes/index.ts` re-export (knip: consumed only inside `themes/centraid.ts`).
- **Visual QA found what the tests could not.** Every gate was green and CI fully passed, but rendering the real emitted tokens against the real `kit.css` across both themes and all eight palette hues exposed a regression F3 had introduced: eleven app rules across six apps filled with `--accent-deep` but inked with the theme-stable `--on-accent`. Because F3 *lifts* `--accent-deep` on the dark ramp, those became white-on-near-white. The numeric grid never caught it because it measured `kit-btn-primary`, not app-local rules that re-declare the same pairing. Fixed in `agenda`, `docs`, `notes`, `photos`, `tasks`, and their components, and pinned by a new `token-purity` test so the pairing cannot return. Lesson recorded: a token change needs a rendered pass, not only a measured one.
- **Latent silent-failure class found and pinned, not fixed.** Auditing every `var()` in app CSS surfaced 12 fallback-less references that resolve to nothing (`--accent-deep-fg` in seven `tasks` files, `--r-lg` in three — the blueprint contract spells radii `--r-sm/--r-md/--r-card/--r-pill`, with no `--r-lg` — plus `--acc`, `--bg-l`, `--t-label`). Each silently drops its declaration. All 12 are byte-identical on `origin/main`, so this PR neither introduced nor fixed them; deliberately left as recorded debt rather than opportunistically changing visuals in a PR already this large. Pinned by `UNRESOLVED_VAR_DEBT` so the class can only shrink.
- **The burn-down silently dropped SOLVED contrast values, and the contract had no rung to replace them.** Removing `docs`' six hand-picked file-kind hexes in favour of the raw `--c-*` palette hues looked like pure literal-elimination — the point of A2 — but those literals were doing solved-contrast work. `--c-*` is documented in `DESIGN.md` as **icon fills**, and as `color:` on a near-white app surface the fills measure 2.11–4.43:1; five of the six kinds fell below AA (`--kind-pdf` 4.74 → 2.11). The accent already had a solved answer to exactly this (`--accent-text` via `accentTextShade()`); the palette had none, which is *why* the app hand-picked in the first place. The fix closes the gap generally rather than restoring the literals: `packages/design/src/color.ts` now solves a **`--c-<name>-text`** rung per hue per theme with the same walk (`walkUntil`, lightness only, hue and saturation untouched), and **both** emitters publish it, so any surface wanting a palette hue on type has a correct token instead of a hand-pick. `packages/client` alone has ~15 `color: var(--c-*)` sites that were silently in the same hole. Two consequences recorded: (a) the rung is solved against the hardest surface either emitter ships *plus a 12% wash of the hue itself*, because a hue on type almost always sits on a weak tint of itself; (b) the solve **cannot** keep two hues apart — `ochre` is `amber` at lower chroma, so solving both to one floor collapses them from 0.125 to 0.028 in oklab — so `docs` moved `pdf` to rose and `slide` to amber, which is also the conventional signal for both kinds.
- **The semantic states were never pinned, and #686 increased the app surfaces' exposure to them.** `contrast.test.ts` held `--danger` / `--success` / `--warning` to the **3:1 non-text floor, on `--bg` only** — the ink roles had real per-surface floors, the states had a formality. So `DESIGN.md` could claim "`--danger` #C44A4A — clears AA on both ramps" with nothing measuring it, and it was false: **3.74:1** on dark `--bg-elev`, 4.20:1 on light `--bg-sunken`. The exposure is not theoretical and #686 widened it: the E burn-down replaced app-local semantic literals with these tokens (`tally` `--pos` #0fa678 / `--neg` #f0805a → `--success`/`--danger`, `people` #f0645b/#5fbd88 → the same), and the values it moved to measured *worse* on dark than the ones it removed. A full sweep of the tree found **131 `color:` rules** on the three roles across `packages/client/src`, `packages/blueprints/apps` and `packages/design/kit/kit.css` — essentially all of them 9px–13.7px, i.e. **body text under WCAG 1.4.3**, not the large-text or non-text cases the 3:1 floor was standing in for. Only two sites in the whole repo are large text (`tally` `.stat .v` 26px, `locker` `.wtStat .n` 28px). The states are now **solved**, not hand-picked, by the same `walkUntil()` machinery as `--accent-text` and `--c-<name>-text`, per emitter and per theme, against that emitter's hardest surface *and* a 12% wash of the state itself (`color: var(--danger)` on `color-mix(… var(--danger) 12%, transparent)` is the single commonest site). Two consequences recorded: (a) `--danger` can no longer be **one shared literal** — the two ramps pull the solve in opposite directions, which is precisely why one hex could not clear both, so `DESIGN.md` and `themes/` now carry `danger` **and** `danger-dark`; (b) a contrast gate alone cannot stop a solver from cheating by **desaturating** — a grey `--danger` cleared every floor on every surface *and* the oklab separation check — so the new gate additionally holds each role to its hue family and to real chroma. Proven by sabotage: greying `DANGER_BASE` is red on `readsAsRole`, and reverting any of the six solved values is red on its own surface × wash cell.
- **The client half of the palette-as-text gap, previously deferred, is now closed.** When `--c-<name>-text` landed, the receipt recorded that "`packages/client` alone has ~15 `color: var(--c-*)` sites that were silently in the same hole" and moved on. The real count is **39 direct `color:` sites across 25 stylesheets**, plus **five identity/status variables** (`--au-hue`, `--notice-hue`, `--tk-hue`, `--plan-tone`, and the `--log-status` / `--conn-health` / `--diag-health` trio) that launder a raw hue into a `color:` one indirection away — invisible to any grep for `color: var(--c-`. Measured on the **shell's own** emitted surfaces (a different emitter from the one the existing grid uses: `--bg-l: 5%` not 10%, and two extra surfaces `--bg` / `--bg-app`), the fills as ink are **2.04–5.03:1 light / 3.12–8.44:1 dark — 17 of 32 cells below AA**, every hue failing on at least one theme, and amber missing even the **3:1 non-text floor** an icon glyph owes. Three consequences recorded: (a) **the fill stays the fill** — washes, dots, rails, bars and 2px edges keep `--c-<name>`; where one variable did both jobs it was split into a `-hue`/`-ink` pair rather than deepened, because dulling a fill to buy contrast nothing reads is a visual regression, not a fix; (b) **16% is the wash ceiling under a palette ink**, not the 12% the solve targets — at 18% indigo and violet fall to 4.44 / 4.49, so `ApprovalsScreen`'s identity tile came down to 12%, the same normalisation this PR already applied to four state washes; (c) **a highlighting scheme owes a second contract the contrast grids cannot see.** The builder's syntax tokens were tag=rose, attr=violet, str=forest, key=indigo — violet and indigo are only 0.068 apart as fills, and solving both to one floor pulled them to **0.075 light / 0.040 dark**, two token classes the eye reads as one colour. `.tokAttr` moved to amber (0.119 / 0.126). The gate for it is deliberately held at **0.08**, above the 0.035 the `docs` labels take and the 0.06 the semantic states take: at 0.035 the very defect it was written for passes, and a gate that green-lights its own bug is decoration. Proven by sabotage in both directions.
- **Our own unresolved-`var()` gate had a client-side blind spot, and the stale design-sync vocabulary had already leaked through it.** A2's `resolves every fallback-less var() an app references` (added earlier in this PR) walks `packages/blueprints/apps` and nothing else, so `packages/client` — the larger CSS surface — was never scanned. Scanning it against `SHELL_TOKEN_CONTRACT` plus every `--x:` declared in shell CSS finds **13 unresolvable names across 19 files**, each one a declaration silently dropped at computed-value time. Provenance confirms the suspicion the audit raised: `--ink-1` was **never declared anywhere in repository history** (`git log -S'--ink-1:'` is empty), it is one of the four names `.design-sync/conventions.md` explicitly listed as "tokens that were never emitted" (`--surface`, `--ink-*`, `--warn`, `--d-*`), and #672/#677's mechanical `--ink-*` → `--text-*` rename carried the phantom forward verbatim as `--text-1` — so the stale doc's vocabulary outlived the doc and was re-blessed by a rename that looked like a cleanup. `--warn`/`--ok` were the same story and were caught by #677 itself; `--ink-1` was not, because nothing measured the shell. Three consequences recorded: (a) the gate is now shared machinery (`@centraid/design/css-vars`) with a shell-side twin, so a rename cannot be "unified" into a phantom again; (b) **runtime-provided properties get an allowlist, and the allowlist is itself gated** — an entry must be both *true* (the named TSX actually writes it) and *necessary* (no stylesheet declares it), or it would quietly widen the gate; exactly one property earns an entry (`--profile-accent`), while a dozen other inline-set properties (`--onb-accent`, `--depth`, `--stage-i`, …) all carry CSS defaults and are deliberately left out; (c) the builder's three language dots had been painting **no background at all** since they were authored — `--c-blue` / `--c-orange` / `--c-yellow` are hues this palette has never had — which is the most visible thing in this issue that every other gate walked past.
- **The pinned unresolved-`var()` debt is now CLEARED — `UNRESOLVED_VAR_DEBT` is `[]`.** The earlier decision to pin rather than fix rested on "each needs a per-site design call". Doing the same read the F4 shell sweep did — decide by what the rule is doing and the surface it lands on, not by name similarity — showed all twelve had a determinate answer, and none of them needed a product decision. What each phantom turned out to mean: (1) **`--accent-deep-fg`** (7 refs, `tasks/components/*`) — `tasks` copied `docs`' pattern without copying `docs`' declaration. Every one of the seven sites inks TEXT that sits ON an `--accent-soft` tint (marks, chips, the current nav item, a consent glyph); **none fills with `--accent-deep`**, so the F3 `--text-inv` ink rule does not apply here and the `--on-accent` gate is untouched. The role is "the accent read as a foreground", which the contract already spells **`--accent-text`** — emitted as `var(--accent-deep)` on light and, on the dark rung, the *lifted* half. That makes the binding byte-equivalent to what `docs` ships from its app-local declaration, including its hand-rolled dark override, so the app-local token was always a re-derivation of a contract token. (2) **`--r-lg`** (3 refs) — the *shell* radius scale has `lg: 10`, the blueprint contract does not; the blueprint spellings are `--r-sm`/`--r-md`/`--r-card`/`--r-pill`. All three sites are the repo's card idiom verbatim (`1px solid var(--line)` + `var(--bg-elev)` + 14px padding), and every peer card in the same two apps (`tally` `.stat`/`.explist`, `people` `.card`) rounds it with **`--r-card`**; bound to that rather than to the numerically-nearest `--r-md`, because the site is a card, not a control. (3) **`--acc`** — an abbreviation of `--accent` in a `:focus-visible` outline; bound to **`var(--accent)`**, the spelling every other focus ring in the apps uses. (4) **`--t-label`** — the uppercase sidebar section label; the blueprint type ramp has no `label` rung and every peer section label in every app (`photos`, `agenda`, `docs`) is **`--t-tiny`**. (5) **`--bg-l`** — the one that is *not* a typo: it is genuinely emitted by the blueprint **dark** token block (`10%`, `blueprint.ts`), which is why the rule works on screen, but it is absent from the light `:root` block and therefore is not contract vocabulary and cannot be added to the contract without lying about the light rung. Given the **documented default as an explicit fallback** (`calc(var(--bg-l, 10%) + 1%)`) instead — the gate deliberately excludes fallback-bearing references because the author has made the miss explicit, and 10% is the shipped value, so this one is a provable no-op. Four of the five are visible changes by design (the rule was meant to apply and was not applying); each was checked against its peers rather than merely made to resolve.
- **F6 — the size rungs are spelled `--t-<key>-size`, and the sweep's bar was raised twice against its own estimate.** Three calls, each of which changed the answer. (a) **Naming.** `--t-<key>-size` over `--t-size-<key>`, following `--c-<hue>-text` — this vocabulary already expresses "a facet of a named token" as a *suffix*, and the suffix form keeps a rung sorted next to the shorthand it belongs to in `SHELL_TOKEN_CONTRACT`. One rung per **distinct size**, first key wins: `body` and `bodyStrong` are both 15px, so `--t-body-size` is the only spelling and `--t-body-strong-size` does not exist — two spellings for one value is exactly the drift `contract.ts` exists to forbid. (b) **No line-height rungs, on the evidence.** Of 227 hand-written `line-height` declarations across the three ratchet targets, all but a handful are unitless multipliers (`1.5` ×58, `1.45` ×38, `1.4` ×37) while the chrome scale's line-heights are absolute px; only 5 exactly equal a scale value. A `--t-body-line-height: 22px` would be vocabulary nothing could adopt, so it was not invented. (c) **The recorded 494 exact matches were measured against the wrong scale for one third of the tree.** The blueprint layer has its **own** type scale — `--t-small` is 13px in the chrome and `0.8rem` in an app — so a `13px` inside `packages/blueprints/apps` was never an exact match there. Against the scale that actually resolves per surface the exact set is **402 client + 9 blueprint = 411**, and conversion was further restricted to **like-for-unit** (px→px rung, rem→rem rung): `1rem` and `16px` agree only at a 16px root, so converting one to the other would break for a reader who has raised their browser's default font size. `packages/design/kit` was excluded **entirely** — `kit.css` renders under both token layers (shell `:root` and the rescoped `.centraid-inline-scope` block), so each of its eight exact matches resolves to two different values and every one would move on one surface. The blueprint type scale moved out of `blueprint.ts` into `typography.ts` as `blueprintType` to make any of this derivable: it was six opaque shorthand strings from which no size could be read.
- (running log — appended as work proceeds)

## What changed

- **A1 spacing tokens emitted (`--sp-1`…`--sp-7`) in both contracts** — new `packages/design/src/motion.ts` (single `EASE` constant); `packages/design/src/css.ts` and `packages/design/src/blueprint.ts` now emit `--sp-1`…`--sp-7` from the typed scale in `packages/design/src/density.ts`; `packages/design/src/contract.ts` gains the spacing keys (derived from `Object.keys(spacing)`).
- **B1 shell motion token (`--ease`) in `SHELL_TOKEN_CONTRACT`** — `--ease` added to the shell emitter and contract, sourced from the shared `EASE` constant. Six client modules drop the now-dead `var(--ease, …)` fallbacks:
  - `packages/client/src/react/screens/AtlasBrowseTab.module.css`
  - `packages/client/src/react/screens/AtlasKindsTab.module.css`
  - `packages/client/src/react/screens/AtlasRelationsTab.module.css`
  - `packages/client/src/react/screens/AtlasScreen.module.css`
  - `packages/client/src/react/screens/GatewayScreen.module.css`
  - `packages/client/src/react/screens/LocalFootprintCard.module.css`
- Mobile `tokens.generated.ts` regenerated byte-identical (`--sp-*` are non-color, the parser skips them). `packages/design/src/kit.test.ts` is unchanged in content (flagged only by a stale stat during concurrent lanes).

- **A2 consumer-side token-purity ratchet test (blueprint apps)** and **A5 reserved-namespace guard (`--c-*` etc.) in the same test** — new `packages/blueprints/src/token-purity.test.ts` walks all 93 `packages/blueprints/apps/**/*.module.css` files asserting no hex, no `rgb()/rgba()/hsl()/hsla()` literals, no concrete `font-family` stacks, and no declarations of reserved custom properties (`--c-*`, `--t-*`, `--r-*`, `--sp-*`, `--bg-*`, `--text-*`, plus every `BLUEPRINT_TOKEN_CONTRACT` name imported from `@centraid/design`). `packages/blueprints/src/token-purity-allowlist.ts` pins the existing debt (28 files, 252 violations) with exact-equality in both directions, so cleanups must shrink it and new debt fails.
- **A2 governance directive `no-hardcoded-colors`** — new directive (added-lines-only tripwire on blueprint app CSS, mirroring `no-hardcoded-model-ids`): `.governance/packs/srikanth235/centraid/directives/no-hardcoded-colors/check.sh`, `.governance/packs/srikanth235/centraid/directives/no-hardcoded-colors/directive.yaml`, `.governance/packs/srikanth235/centraid/directives/no-hardcoded-colors/constitution.md`, plus the `### no-hardcoded-colors` section and amendment-log line in `CONSTITUTION.md`.

- **C1 `docs/design-language.md` + AGENTS.md index row + ui-grounding reference** — new `docs/design-language.md` (canonical field-notebook rulebook: aesthetic POV, platform analogy, typography/color/spacing/motion rules, app may/may-not list); index row added in `AGENTS.md`; doc-comment reference on `buildUiGroundingBlocks()` in `packages/gateway/src/skills/ui-grounding.ts`.
- **C2 `.design-sync` stale conventions neutralized** — `.design-sync/conventions.md` and `.design-sync/desktop.conventions.md` replaced with stale-version warnings naming the specific lies (deleted emulation themes, removed Geist/Space Grotesk stacks, phantom `--surface`/`--ink-*`/`--warn`/`--d-*` tokens) plus pointers to the real sources. Filenames preserved (referenced by `.design-sync/config.json`).
- **C3 stale mobile-theming comments fixed** — `packages/design/src/themes/index.ts` and `packages/design/src/index.ts` now describe the real three-lowerings pipeline (shell `toCss()`, blueprint `toBlueprintCss()`, mobile AOT via `apps/mobile/scripts/generate-theme.ts`).
- **C4 `styles.css` eaten comment restored** — `packages/client/src/styles.css` had already been fixed on main by c27cb65c (#681); our branch converged to identical content, so this item lands with no net diff.
- **D1 typeface decision recorded in docs/decisions.md** — `docs/decisions.md` gains the `## #686 — typography is a contract of ROLES, not families` section (web/desktop system stacks per #468 K11; mobile per-role platform mapping sanctioned pending native-faces revisit).

- **D2 mobile color opt-outs migrated/waived** — `apps/mobile/src/screens/onboarding-styles.ts` now derives its palette from `resolveTheme("dark").colors` (scheme stays pinned, values come from tokens; one `// #686 waiver:` for the true-black camera viewfinder). `apps/mobile/src/apps/photos/PhotosCollectionsView.tsx` replaces 27 hand-picked hexes with tints derived from the 8-hue design palette via `tileFinish()`, keyed by a stable FNV-1a hash of the collection/party id. `apps/mobile/src/screens/onboarding-art.tsx` and `apps/mobile/src/screens/onboarding-home-art.tsx` carry explicit illustration-art exemption comments.

- **F1 Root `DESIGN.md` per the getdesign.md convention** — new root `DESIGN.md` (151-line machine-readable design brief: point of view, binding rules, color/typography/spacing/radii/elevation/motion, two-layer component vocabulary, do/don't) with real values from the token source; new `packages/design/src/design-md.test.ts` drift guard (12 tests) pinning every stated value (brand hex, accent ramp, semantic states, all 8 palette hues, spacing rungs, radii, EASE curve, type roles) to the TS source of truth; index row in `AGENTS.md`; pointer in `docs/design-language.md`. Also hardened `.governance/packs/srikanth235/centraid/directives/no-hardcoded-colors/check.sh` against prose false-positives (`#686` in CSS comments parses as 3-digit hex; `hsl(var(--app-hue) …)` is contract-parameterized) — comment stripping, declaration-colon filter, hex-followed-by-word filter; red-capability re-proven after each change.

- **A3 component vocabulary unified (scaffold ↔ kit)** and **A4 scaffold exemplar on tokens** — generated apps are served `kit.css` (via `SHARED_ASSET_FILES` → `sharedAssetsDir`), so the scaffold's parallel component vocabulary (`.primary`/`.ghost`/`.muted`/`.empty`…) is retired in favour of `.kit-btn`/`.kit-input`/`.kit-empty`/`.kit-muted`; `DEFAULT_APP_CSS` keeps only layout classes kit lacks (`.head`, `.add-bar`, `.list`, `.row`, `.surface`, `.loading`, `.error`, `.circle`) and is now 100% token-driven (`--t-*`, `--sp-*`, `--r-*`, `--on-accent`; zero literals, the `#fff` carve-out is gone). Knob blocks retarget `.kit-*` with compound selectors; the appFont knob moves to token roles. Files:
  - `packages/blueprints/src/__snapshots__/scaffold-defaults.test.ts.snap`
  - `packages/blueprints/src/scaffold-defaults.test.ts`
  - `packages/blueprints/src/scaffold-defaults.ts`
  - `packages/blueprints/src/scaffold-files.ts`
  - `packages/gateway/skills/authoring-centraid-apps/SKILL.md`
  - `packages/gateway/src/skills/ui-grounding.test.ts`
  - `packages/gateway/src/skills/ui-grounding.ts`
- **B2 shell type-scale adoption + ratchet** and **B3 shell radius adoption + ratchet** — `scripts/lint-design-tokens.mjs` gains a METRICS registry with `rawFontSize`, `rawFontWeight` (outside 400/500/600), `rawRadius` (off the 2/4/6/10/14 scale; carve-outs: 0, %, ≥99px pill, 1px nudge, var/calc) and a `--write` budget-regeneration mode; `scripts/lint-design-tokens.test.mjs` covers each counter red-capably; `tests/design-token-css-budget.json` regenerated (final head state: 0 grandfathered hex, 4 literal font stacks, 1291 raw font-sizes, 9 off-scale weights, 287 raw radii). In `packages/client`: 152 border-radius declarations converted to `var(--r-*)` (value-identical), 48 off-scale font-weights snapped into the sanctioned set, 6 display-scale 700s kept as marketing territory. Zero font-size conversions — a measured finding: no client declaration exactly matches a `--t-*` shorthand (all line-heights unitless vs px tokens), so the type surface is recorded debt, not silently rounded. Client CSS files touched:
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
  - `packages/client/src/react/screens/DiscoverScreen.module.css`
  - `packages/client/src/react/screens/GatewayScreen.module.css`
  - `packages/client/src/react/screens/HomeScreen.module.css`
  - `packages/client/src/react/screens/InsightsScreen.module.css`
  - `packages/client/src/react/screens/LocalFootprintCard.module.css`
  - `packages/client/src/react/screens/LogsScreen.module.css`
  - `packages/client/src/react/screens/OnboardingScreen.module.css`
  - `packages/client/src/react/screens/PaletteScreen.module.css`
  - `packages/client/src/react/screens/PhoneScreen.module.css`
  - `packages/client/src/react/screens/RecoverScreen.module.css`
  - `packages/client/src/react/screens/ResourceDialogs.module.css`
  - `packages/client/src/react/screens/ResourceReceiptPanel.module.css`
  - `packages/client/src/react/screens/RunViewScreen.module.css`
  - `packages/client/src/react/screens/SettingsConnectionsScreen.module.css`
  - `packages/client/src/react/screens/SettingsDiagnosticsScreen.module.css`
  - `packages/client/src/react/screens/SettingsStorageScreen.module.css`
  - `packages/client/src/react/screens/WhatsNewModal.module.css`
  - `packages/client/src/react/shell/CaptureOverlay.module.css`
  - `packages/client/src/react/shell/IdentityHead.module.css`
  - `packages/client/src/react/shell/chrome.module.css`
  - `packages/client/src/react/shell/gatewaySwitcher.module.css`
  - `packages/client/src/react/shell/routes/AppViewRoute.module.css`
  - `packages/client/src/react/shell/routes/ConnectFlow.module.css`
  - `packages/client/src/react/shell/routes/SettingsRoute.module.css`
  - `packages/client/src/react/shell/routes/assistantRich.module.css`
  - `packages/client/src/react/shell/routes/builder/BuilderAutomationPane.module.css`
  - `packages/client/src/react/shell/routes/builder/BuilderCloud.module.css`
  - `packages/client/src/react/shell/routes/builder/BuilderCode.module.css`
  - `packages/client/src/react/shell/routes/builder/BuilderHistory.module.css`
  - `packages/client/src/react/shell/routes/builder/BuilderPreview.module.css`
  - `packages/client/src/react/shell/routes/builder/BuilderShell.module.css`
  - `packages/client/src/react/shell/templatePreview.module.css`
  - `packages/client/src/react/styles/chatMessage.module.css`
  - `packages/client/src/react/styles/linkBtn.module.css`
  - `packages/client/src/react/styles/pageEmpty.module.css`
  - `packages/client/src/react/styles/pageSkeleton.module.css`
  - `packages/client/src/react/styles/seg.module.css`
  - `packages/client/src/react/styles/toolGroup.module.css`
  - `packages/client/src/react/styles/vault.module.css`
  - `packages/client/src/react/ui/AppCard.module.css`
  - `packages/client/src/react/ui/Button.module.css`
  - `packages/client/src/styles.css`
- **B4 mono body face decided + documented** — resolved upstream by #681 (c27cb65c restored `body { font-family: var(--font-sans) }`); `DESIGN.md`/`docs/design-language.md` document mono as a signature role, not the body face. No net diff in this branch.
- **D3 post-generation CSS validation for agent apps** — token-purity validation wired into the publish gate `validateManifestAt()` (the same seam that rejects malformed manifests; hard-reject with LLM-instructive per-violation messages; installed apps unaffected — the gate runs only on publish, and bundled blueprints install in place without passing through it). The generated `toBlueprintCss()` baseline is structurally stripped before scanning so scaffolded apps publish clean. Files:
  - `packages/app-engine/src/index.ts`
  - `packages/app-engine/src/registry/token-purity.test.ts`
  - `packages/app-engine/src/registry/token-purity.ts`
  - `packages/gateway/src/validate-app-css.test.ts`
  - `packages/gateway/src/validate-app-css.ts`
  - `packages/gateway/src/validate-manifest.ts`
- **E blueprint burn-down (docs, photos, tally, locker, people, agenda, notes, tasks)** — all eight system apps swept onto tokens: 252 → 5 remaining violations repo-wide (all sanctioned: app-font knobs, `--app-hue`/`--accent` identity, the photos wall, and 3 `hsl(var(--app-hue) 25% 4%)` theater-stage backdrops awaiting a `--stage` token). docs' reserved-namespace `--c-*` shadow palette renamed to `--kind-*` and sourced from the 8-hue palette; photos scrims routed through `--scrim`/`--on-accent` color-mix; tally/locker/people/agenda literal forks replaced by `--success`/`--danger`/`--warning`/`--accent-*`/`--on-accent`; 234 exact spacing substitutions onto `--sp-*`; 70+152 radius snaps; kit composition raised (photos sidebar brand block, locker sidebar 2→9 composes). `packages/blueprints/src/token-purity-allowlist.ts` shrunk from 28 files/252 violations to 8 entries. Blueprint app files touched:
  - `packages/blueprints/apps/agenda/Chrome.module.css`
  - `packages/blueprints/apps/agenda/components/CreateModal.module.css`
  - `packages/blueprints/apps/agenda/components/EventDrawer.module.css`
  - `packages/blueprints/apps/agenda/components/EventEditor.module.css`
  - `packages/blueprints/apps/agenda/components/MonthView.module.css`
  - `packages/blueprints/apps/agenda/components/ScheduleView.module.css`
  - `packages/blueprints/apps/agenda/components/Sidebar.module.css`
  - `packages/blueprints/apps/agenda/components/WeekView.module.css`
  - `packages/blueprints/apps/docs/Chrome.module.css`
  - `packages/blueprints/apps/docs/components/Activity.module.css`
  - `packages/blueprints/apps/docs/components/BulkBar.module.css`
  - `packages/blueprints/apps/docs/components/Details.module.css`
  - `packages/blueprints/apps/docs/components/Editor.module.css`
  - `packages/blueprints/apps/docs/components/Grid.module.css`
  - `packages/blueprints/apps/docs/components/History.module.css`
  - `packages/blueprints/apps/docs/components/List.module.css`
  - `packages/blueprints/apps/docs/components/NewMenu.module.css`
  - `packages/blueprints/apps/docs/components/QuickLook.module.css`
  - `packages/blueprints/apps/docs/components/Sidebar.module.css`
  - `packages/blueprints/apps/docs/components/shared.module.css`
  - `packages/blueprints/apps/docs/format.ts`
  - `packages/blueprints/apps/locker/Chrome.module.css`
  - `packages/blueprints/apps/locker/components/Detail.module.css`
  - `packages/blueprints/apps/locker/components/Detail.tsx`
  - `packages/blueprints/apps/locker/components/EditModal.module.css`
  - `packages/blueprints/apps/locker/components/Generator.module.css`
  - `packages/blueprints/apps/locker/components/ItemFields.module.css`
  - `packages/blueprints/apps/locker/components/List.module.css`
  - `packages/blueprints/apps/locker/components/LockScreen.module.css`
  - `packages/blueprints/apps/locker/components/Sidebar.module.css`
  - `packages/blueprints/apps/locker/components/shared.module.css`
  - `packages/blueprints/apps/notes/Chrome.module.css`
  - `packages/blueprints/apps/notes/components/Card.module.css`
  - `packages/blueprints/apps/notes/components/Editor.module.css`
  - `packages/blueprints/apps/notes/components/History.module.css`
  - `packages/blueprints/apps/notes/components/QuickAdd.module.css`
  - `packages/blueprints/apps/notes/components/Sidebar.module.css`
  - `packages/blueprints/apps/notes/components/Toolbar.module.css`
  - `packages/blueprints/apps/notes/components/WikiLinks.module.css`
  - `packages/blueprints/apps/notes/components/shared.module.css`
  - `packages/blueprints/apps/people/Chrome.module.css`
  - `packages/blueprints/apps/people/components/Activity.tsx`
  - `packages/blueprints/apps/people/components/AddPersonModal.module.css`
  - `packages/blueprints/apps/people/components/AddRows.module.css`
  - `packages/blueprints/apps/people/components/ContactChannels.module.css`
  - `packages/blueprints/apps/people/components/DetailSections.module.css`
  - `packages/blueprints/apps/people/components/DetailSections.tsx`
  - `packages/blueprints/apps/people/components/Details.module.css`
  - `packages/blueprints/apps/people/components/Grid.module.css`
  - `packages/blueprints/apps/people/components/History.module.css`
  - `packages/blueprints/apps/people/components/Journal.module.css`
  - `packages/blueprints/apps/people/components/Journal.tsx`
  - `packages/blueprints/apps/people/components/List.module.css`
  - `packages/blueprints/apps/people/components/NewMenu.module.css`
  - `packages/blueprints/apps/people/components/Sidebar.module.css`
  - `packages/blueprints/apps/people/components/TrashCard.module.css`
  - `packages/blueprints/apps/people/format.ts`
  - `packages/blueprints/apps/photos/Chrome.module.css`
  - `packages/blueprints/apps/photos/components/AlbumGrid.module.css`
  - `packages/blueprints/apps/photos/components/Editor.module.css`
  - `packages/blueprints/apps/photos/components/Lightbox.module.css`
  - `packages/blueprints/apps/photos/components/LightboxInfo.module.css`
  - `packages/blueprints/apps/photos/components/Memories.module.css`
  - `packages/blueprints/apps/photos/components/Picker.module.css`
  - `packages/blueprints/apps/photos/components/Sidebar.module.css`
  - `packages/blueprints/apps/photos/components/Slideshow.module.css`
  - `packages/blueprints/apps/photos/components/Timeline.module.css`
  - `packages/blueprints/apps/photos/components/Toolbar.module.css`
  - `packages/blueprints/apps/photos/components/shared.module.css`
  - `packages/blueprints/apps/tally/Chrome.module.css`
  - `packages/blueprints/apps/tally/components/Activity.module.css`
  - `packages/blueprints/apps/tally/components/Dashboard.module.css`
  - `packages/blueprints/apps/tally/components/ExpenseModal.module.css`
  - `packages/blueprints/apps/tally/components/ExpenseRow.module.css`
  - `packages/blueprints/apps/tally/components/ExpenseUndo.module.css`
  - `packages/blueprints/apps/tally/components/GroupManager.module.css`
  - `packages/blueprints/apps/tally/components/History.module.css`
  - `packages/blueprints/apps/tally/components/Ledger.module.css`
  - `packages/blueprints/apps/tally/components/Sidebar.module.css`
  - `packages/blueprints/apps/tally/components/shared.module.css`
  - `packages/blueprints/apps/tasks/components/Board.module.css`
  - `packages/blueprints/apps/tasks/components/Capture.module.css`
  - `packages/blueprints/apps/tasks/components/Detail.module.css`
  - `packages/blueprints/apps/tasks/components/Row.module.css`
  - `packages/blueprints/apps/tasks/components/Sidebar.module.css`
  - `packages/blueprints/apps/tasks/components/shared.module.css`

- **F1 Root `DESIGN.md` conforming to the official google-labs-code/design.md spec + `@google/design.md` linter wired** — root `DESIGN.md` rewritten to the official spec: YAML front matter (46 colors incl. both theme ramps with the dark `--bg-l` anchor resolved to hex, 7 typography roles, 5 rounded, 7 spacing, 46 component entries; `primary` aliased to brand via token ref) + canonical section order (Overview · Colors · Typography · Layout · Elevation & Depth · Shapes · Components · Do's and Don'ts). `@google/design.md@0.4.0` pinned exact in root `package.json` devDependencies (`bun.lock` updated); new `lint:design-md` script wired into the `check:push`/`check:pr`/`check:full` gate chain next to `lint:design-tokens` (red-capable, proven on a broken token ref). `packages/design/src/design-md.test.ts` rewritten to parse the front matter and pin 16 checks directly against the TS token source (red-capable, proven on a radii change). `docs/toolchain.md` gains the owner + command-contract rows. The linter surfaced a REAL finding: `--on-accent: #ffffff` fails WCAG AA on the accent fills (3.04:1 / 2.07:1) — documented as a Known finding in `DESIGN.md` and fixed in a follow-up commit on this branch. Also `packages/blueprints/apps/tasks/Chrome.module.css` — restored one `var(--on-accent)` substitution that an orchestrator red-capability `git restore` had accidentally reverted.

- **F2 One canonical design document (`docs/design-language.md` folded in, `.design-sync/` deleted)** — deleted `docs/design-language.md` (folded into `DESIGN.md`) and `.design-sync/conventions.md`, `.design-sync/desktop.conventions.md`, `.design-sync/config.json`, `.design-sync/desktop.config.json` (directory removed); `.gitignore` design-sync/ds-bundle entries dropped; references repointed in `AGENTS.md`, `docs/decisions.md`, `DESIGN.md`, `packages/design/src/index.ts`, `packages/design/src/design-md.test.ts`, `packages/app-engine/src/registry/token-purity.ts`, `packages/gateway/src/skills/ui-grounding.ts`, `scripts/lint-design-tokens.mjs`.

- **F3 Fix the WCAG AA failure the linter found (`--on-accent` on the filled primary button)** — the filled primary carried `--on-accent: #FFFFFF` on `--accent-deep`: 3.04:1 at rest, 2.07:1 on hover in the shell, and 3.49:1 / 1.98:1 at the worst palette hue on the app surface. A fixed ink cannot serve eight retunable hues and CSS cannot pick one (`color-contrast()` unimplemented), so the FILL moved and the button's ink became `--text-inv`, which already flips per theme. Shell rungs are now SOLVED rather than offset (`accentFillShade()` beside `accentTextShade()` in `src/color.ts`), so an owner-picked accent gets a legible button too; app rungs are the same `color-mix()` retuned (62% over a near-black hue anchor on light, 70% under a near-white one on dark). `.kit-btn.primary:hover` stops brightening — it steps the fill 12% toward `--text`, away from its own ink, so a hover can only raise the ratio. Seven further accent-deep fills in the kit took the same re-ink — the app brand mark, the active chip, the empty-state CTA, the user bubble, the ask send button, the ask icon button and the ask-applied dot, all of which painted the NORMAL `--text` (or `--on-accent`) on a filled accent. `--on-accent` stays white and keeps its real role (saturated accent + media stage) and is now EMITTED by the shell, which never declared it — five `var(--on-accent)` rules in `packages/client` had been resolving to nothing. Measured grid (all 8 palette hues + both teals × both themes, rest and hover) is in `DESIGN.md`'s Colors section and recomputed from the emitted CSS by `contrast.test.ts`, which grew an oklab `color-mix()` evaluator so a hue-parameterised fill can be measured at all; both new guards proven red-capable. `lint:design-md` is 0 errors / 0 warnings. `apps/mobile/src/kit/theme/tokens.generated.ts` is unchanged — the RN lowering skips `color-mix()`, so no accent-fill token reaches it. Files:
  - `DESIGN.md`
  - `packages/design/src/color.ts`
  - `packages/design/src/themes/shared.ts`
  - `packages/design/src/themes/centraid.ts`
  - `packages/design/src/themes/index.ts`
  - `packages/design/src/css.ts`
  - `packages/design/src/contract.ts`
  - `packages/design/src/blueprint.ts`
  - `packages/design/kit/kit.css`
  - `packages/design/src/contrast.test.ts`
  - `packages/design/src/color-accent.test.ts`
  - `packages/design/src/design-md.test.ts`
  - `packages/client/src/react/shell/appearance.ts`

- **Mutation floor restored for `packages/design`** — the `--sp-*` / `--ease` / `--brand` / `--on-accent` emission added by A1/B1/F3 introduced mutants no seeded test could kill: `src/contract.test.ts` pins the emitted property NAME list (and is not in the mutation seed's `testFiles` anyway), so a mutant that blanks a token's key or empties `themeProps()`'s literal still produced a well-formed sheet. `packages/design/src/css-properties.test.ts` — the value-law file the seed actually runs — gains four behaviour tests: every spacing rung emitted in `px` with only the rungs present, every `--lib-*` library-tile token emitted under its own name, the three theme-independent constants (`--brand`, `--ease`, `--on-accent`) present at `:root` and redefined by no theme block, and every `Theme` role field emitted in its own block under the kebab-case spelling with that theme's value. Score 92.78 → 98.97 (floor 93); `src/css.ts` reaches 100%. Files:
  - `packages/design/src/css-properties.test.ts`

- **Ink-pairing regression fix + gate** — eleven rules repointed from `var(--on-accent)` to `var(--text-inv)` where the fill is `var(--accent-deep)`, each with an inline note stating the contract: `packages/blueprints/apps/agenda/Chrome.module.css`, `packages/blueprints/apps/agenda/components/MonthView.module.css`, `packages/blueprints/apps/agenda/components/Sidebar.module.css`, `packages/blueprints/apps/agenda/components/WeekView.module.css`, `packages/blueprints/apps/docs/Chrome.module.css`, `packages/blueprints/apps/notes/Chrome.module.css`, `packages/blueprints/apps/photos/components/Editor.module.css`, `packages/blueprints/apps/photos/components/Picker.module.css`, `packages/blueprints/apps/photos/components/Sidebar.module.css`, `packages/blueprints/apps/tasks/Chrome.module.css`. New test in `packages/blueprints/src/token-purity.test.ts` ("never inks an --accent-deep fill with the theme-stable --on-accent") holds every app to the kit's header contract.

- **Unresolved-var gate** — new test in `packages/blueprints/src/token-purity.test.ts` ("resolves every fallback-less var() an app references") resolving names against the contract, `packages/design/kit/kit.css`, and the app's own stylesheets; the 12 known-broken references are pinned in `UNRESOLVED_VAR_DEBT` in `packages/blueprints/src/token-purity-allowlist.ts`.

- **Palette-hue-as-text rung (`--c-<name>-text`) — closes the gap the burn-down exposed**
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/design/src/color.ts` — `darkenUntil()` generalised to `walkUntil(base, score, floor, step)` (deepen or lift, lightness only); new `PALETTE_TEXT_SURFACE` (light `#F0F1F3` = the darkest light surface either emitter ships; dark `#2b3634` = the lightest dark one), `PALETTE_TEXT_TINT = 0.12` self-wash allowance, `AA_PALETTE_TEXT = 4.8`, `paletteTextShade()`, and the exported `paletteText` map.
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/design/src/css.ts` — `themeProps()` emits `--c-<name>-text` from `paletteText[t.kind]`, so the shell gets both halves.
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/design/src/blueprint.ts` — `lightProps()` / `darkProps()` emit the light and dark halves into the `:root`, `[data-theme='dark']`, and `prefers-color-scheme` blocks.
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/design/src/contract.ts` — eight `--c-<name>-text` names added to `SHELL_TOKEN_CONTRACT` (theme block, not static) and to `BLUEPRINT_TOKEN_CONTRACT`.
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/DESIGN.md` — front matter gains `c-<name>-text` / `c-<name>-text-dark` (16 values) and 16 `c-<hue>-on-elev[-dark]` component entries recording the canonical pairing; the "App-icon palette" prose gains the rule ("a palette hue on type reads `--c-<name>-text`, never `--c-<name>`"), the measured grid, and the lightness-only / cannot-keep-hues-apart caveat.
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/design/src/design-md.test.ts` — palette test no longer treats `-text` keys as strays; new test pins all 16 hexes to `paletteText` and requires the prose row for each hue to carry both halves.
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/design/src/contrast.test.ts` — new `every palette hue has a legible TEXT rung` grid (8 hues × 2 themes): AA on every surface AND on a 12% self-tint of its own fill, a `RECOGNISABLE < 12` cap, a hue/saturation-preservation + direction-of-travel law, and an oklab separation floor for the six file-kind hues.
- **`docs` rebound to the solved rung, with fills split out**
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/blueprints/apps/docs/Chrome.module.css` — `--kind-<k>` now reads `--c-<hue>-text` and a new `--kind-<k>-fill` reads the raw `--c-<hue>`; `pdf` → rose and `slide` → amber (the amber/ochre pair collapses under the solve); the whole app-local dark block for the kind rungs is **deleted** — the design package emits both halves.
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/blueprints/apps/docs/format.ts` — new `fillVar()`; `tintBg()` now mixes the FILL rung, so a label painted `var(cv)` keeps its measured ratio on the tint behind it.
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/blueprints/apps/docs/components/Grid.tsx`, `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/blueprints/apps/docs/components/QuickLook.tsx` — the four decorative `background: var(${m.cv})` marks read `fillVar(m.cv)`.
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/blueprints/apps/docs/components/Grid.tsx`, `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/blueprints/apps/docs/components/Details.tsx`, `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/blueprints/apps/docs/components/List.tsx`, `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/blueprints/apps/docs/components/QuickLook.tsx` — tint strengths unified at 12% (were 15/16/16/20), the strength the rung is solved for.
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/blueprints/apps/docs/components/Grid.module.css` — `.thumbLabel`'s `opacity: 0.9` removed; it was an unmeasured ~0.6 off the label's ratio, applied after the token layer had solved it.
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/blueprints/apps/docs/kind-colours.test.ts` — **new**: pins the binding the contrast grid assumes (text rung for text, fill rung for fills, same hue per kind, six distinct hues, no `ochre`, no app-local dark re-declaration, `tintBg()` never mixes the text rung).
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/blueprints/manifest.json` — regenerated (picks up the new test file, matching how the other apps' test files are already listed).


- **Semantic states solved as TEXT, and the coverage gap that hid them closed**
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/design/src/color.ts` — new exported `semanticShade(base, ramp)` + `SemanticRamp` type and a per-emitter `SEMANTIC_SURFACE` map (`shellLight` `#F0F1F3`, `shellDark` `#181818`, `blueprintLight` `#f1f1f6`, `blueprintDark` `#2b3634` — each the hardest surface that emitter actually paints). The walk scores against the candidate's **own** 12% wash, not the base's, because a `color-mix()` chip tints with the shipped token. `PALETTE_TEXT_TINT` → `SELF_TINT` and `AA_PALETTE_TEXT` → `AA_SOLVED_TEXT`, now shared by both solvers.
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/design/src/themes/shared.ts` — the six shell literals become named bases run through `semanticShade()`; new `DANGER_DARK` export (the ramps can no longer share one danger).
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/design/src/themes/centraid.ts` — the dark theme takes `DANGER_DARK`.
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/design/src/blueprint.ts` — the app ramp's six literals run through `semanticShade()` against the **blueprint** surfaces (its `--bg-l` is 10%, not the shell's 5%, so the two ramps need different answers).
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/design/kit/kit.css` — `.kit-btn.primary.danger` re-inked `var(--text)` → `var(--text-inv)`. A `--danger` fill under `--text` is the *same-side* ink in both themes (near-black on light, near-white on dark) over a mid-lightness red: 3.81:1 light / 4.09:1 dark at the button's 13px. With `--text-inv` it is 6.05 / 5.70.
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/design/src/contrast.test.ts` — the gate that should have caught this. The old three-token loop at the 3:1 floor on `--bg` is replaced by, per emitter × theme: the **body** floor on every surface the state lands on **and** on a 12% self-wash of each; a `RECOGNISABLE_STATE < 12` cap; a hue-family + minimum-chroma law (`readsAsRole`) so a solve cannot cheat by desaturating; an oklab separation floor between the three; the filled-destructive-button ink pairing; and a new `kit.css`-reading describe pinning that `.kit-btn.primary.danger` writes `--text-inv` — a value grid cannot see which pairing a stylesheet actually writes.
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/design/src/design-md.test.ts` — `danger` / `danger-dark` pinned separately, with an assertion that they differ.
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/DESIGN.md` — front matter gains `danger-dark` and the five moved hexes; three new component entries (`kit-btn-danger-filled`, `kit-btn-danger-filled-dark`, `kit-banner-danger-dark`); the "Semantic states" section replaces "clears AA on both ramps" with the measured 24-cell before/after grid, the 12%-wash rule, the body-floor rationale, and the filled-button contract.
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/apps/mobile/src/kit/theme/tokens.generated.ts` — regenerated (`bun run generate:theme`); it lowers `toBlueprintCss()`, so it carried the stale app-ramp values.
  - **Four over-strength self-washes brought back to the 12% the rung is solved for** — at 18–20% a chip spends the contrast the solve just bought: `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/shell/routes/AppViewRoute.module.css` (`.brandChipLive` 18% → 12%), `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/shell/routes/builder/BuilderShell.module.css` (`.tlStatus[data-state="idle-live"]` 18% → 12%), `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/shell/chrome.module.css` (`.sbAlarm` 12% → 8%, hover 18% → 12%), `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/screens/AtlasBrowseTab.module.css` (`.dangerBtn` 12% → 8%, hover 20% → 12%). The 14–16% washes elsewhere measure ≥4.5 against the solved rungs and were deliberately left.


- **oklab helper extraction** — `packages/design/src/oklab.ts` (new) carries the `color-mix(in oklab, …)` evaluator and `oklabDistance` out of `packages/design/src/contrast.test.ts`, which had grown past the 625-line repo-hygiene cap once the semantic-state grids landed. Extraction, not a waiver.

- **Palette-hue-as-text in the shell (#686, client half).** Every `color:` that named a bare `--c-<hue>` now names the solved `--c-<hue>-text` rung; every `background`, `border-color`, `box-shadow` and `::before` rail keeps the raw fill.
  - Direct rebinds — `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/ui/StatusPill.module.css` (`.status[data-tone="draft"]`), `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/ui/AppCard.module.css` (`.starFlag`), `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/shell/contextMenu.module.css` (`.item[data-danger]` + its `svg`), `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/shell/routes/SettingsRoute.module.css` (`.settingsAutosaved`), `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/shell/routes/builder/BuilderCloud.module.css` (`.heroTile`, `.heroEyebrow`, `.feedTile`, `.feedLive`), `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/screens/BackupCard.module.css` (six), `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/screens/GatewayScreen.module.css` (four), `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/screens/InsightsScreen.module.css` (three), `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/screens/AutomationsOverviewScreen.module.css` (two), `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/screens/AutomationEditorScreen.module.css` (two), `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/screens/AutomationThreadScreen.module.css` (`.consentIc`), `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/screens/SettingsConnectionsScreen.module.css` (`.rowAuthNote`, `.wizardHint`), `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/screens/SettingsDiagnosticsScreen.module.css` (`.eventLevel`), `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/screens/SettingsProvidersScreen.module.css` (`.usedByChip`), `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/screens/LogsScreen.module.css` (`.lineLevel`).
  - **Fill/ink splits** where one variable served both roles — `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/screens/ApprovalsScreen.module.css` (`--notice-hue` / `--notice-ink` across all eight hues; the tile's self-wash also 18% → 12%; and `.severityPill`'s hand-mixed light value plus its `:root[data-theme="dark"]` override both collapse into the one per-theme rung), `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/styles/automation.module.css` (`--au-hue` / `--au-ink` across all eight; `.auStatus[data-tone="draft"]`'s `--au-status-tone` takes the ink rung so it matches its four ink-grade siblings), `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/screens/AutomationThreadScreen.module.css` (`--plan-tone` / `--plan-ink`; `.node[data-run-status="running"]` reads `--au-ink`), `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/screens/AutomationTemplatesScreen.tsx` + `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/screens/AutomationTemplatesScreen.module.css` (inline `--tk-hue` gains `--tk-ink`; `.trigIcon` reads it).
  - **Label-only branches** of a shared status variable, where the dot above keeps the fill — `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/screens/LogsScreen.module.css` (`.statusLabel`), `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/screens/SettingsConnectionsScreen.module.css` (`.healthLabel`), `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/screens/SettingsDiagnosticsScreen.module.css` (`.healthLabel`), `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/screens/LocalFootprintCard.module.css` (`--tone`, whose only consumer is a `color:`).
  - **Syntax-highlighting scheme** — `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/shell/routes/builder/BuilderCode.module.css`: `.tokTag` / `.tokStr` / `.tokKey` / `.diffSign` move to their rungs, and `.tokAttr` additionally changes hue violet → **amber**, because the violet rung and `.tokKey`'s indigo rung collapse to 0.040 in oklab on dark.
  - **Gates.** `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/scripts/lint-design-tokens.mjs` gains a sixth ratchet metric `paletteHueAsText` — a `color:` / `-webkit-text-fill-color:` naming a bare `--c-<hue>` anywhere under the three CSS targets, now at **zero**; the property match carries a left boundary so `background-color` / `border-color` / `border-top-color` stay outside it. `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/scripts/lint-design-tokens.test.mjs` covers ink vs fill vs rung vs near-miss. `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/design/src/contrast-shell-palette.test.ts` (new) re-measures every `--c-*-text` rung against all four **shell** surfaces bare and on 6–16% self-washes, per theme, plus the lightness-only and hue-recognisability laws. `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/shell/routes/builder/BuilderCode.tokens.test.ts` (new) reads the scheme out of its own stylesheet and pins both contract and mutual separation.
  - **Helpers, not re-derivation** — `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/design/src/oklab.ts` gains `alphaOver()` (the wash composite) and `resolveVars()` (the `var()`/`calc()` substitution the grids all needed). `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/design/package.json` publishes them behind `@centraid/design/color` and `@centraid/design/oklab` **subpaths, not the barrel**: routing one more module through `packages/design/src/index.ts` pushes `packages/client/src/index.ts` to 101 modules and trips oxlint `no-barrel-file` (threshold 100) — the same ceiling that rehomed `EASE` earlier in this PR. `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/vitest.config.ts` aliases the two subpaths at source. `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/design/src/index.ts` records why the maths is not in the barrel.
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/DESIGN.md` — the palette section gains "The shell was the last holdout": the 32-cell measurement, the fill-stays-the-fill rule and the four `-hue`/`-ink` pairs, the two gates, the 16% wash ceiling, and the syntax-scheme collapse with its numbers.

- **F4 Extend the unresolved-`var()` gate to `packages/client` and fix the 13 phantom tokens it found.** The A2 gate walked blueprint apps only; the shell was unscanned and carried 13 names that resolve to nothing.
  - **Shared reader, so the two gates cannot drift** — `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/design/src/css-vars.ts` (new) carries the three pure halves both gates need: `stripCssComments()`, `declaredCustomProps()`, `unresolvedVarRefs()`. Published behind the `@centraid/design/css-vars` **subpath**, not the barrel, for the same oklint `no-barrel-file` ceiling that keeps `./color` and `./oklab` out of it (`/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/design/package.json`); aliased at source for vitest in `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/vitest.config.ts`. Unit-pinned by `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/design/src/css-vars.test.ts` (new, 12 tests), including a regression guard that a `/g` regex is built fresh per call — a module-scope instance carries `lastIndex` and returns a different answer the second time.
  - **The shell-side gate** — `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/shell-var-resolution.test.ts` (new) walks every `.css` under `packages/client/src` and resolves each fallback-less `var()` against `SHELL_TOKEN_CONTRACT`, every `--x:` declared anywhere in shell CSS, and a commented `RUNTIME_DECLARED` allowlist. A third test keeps that allowlist honest in **both** directions: an entry whose component no longer sets the property is red, and so is an entry a stylesheet already declares (redundant, and therefore silently widening).
  - **The blueprints gate rewired onto the shared reader** — `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/blueprints/src/token-purity.test.ts` now calls `declaredCustomProps()` / `unresolvedVarRefs()` / `stripCssComments()` instead of its own inline regexes; `UNRESOLVED_VAR_DEBT` is unchanged (12 entries, still exactly the same list).
  - **Phantom ink ramp → the real ramp.** `--text-1` (8 sites, 7 files) is the primary ink at every site — a title above a `--text-soft`/`--text-ghost` sub, or a hover escalating out of `--text-faint` — so all eight become `var(--text)`: `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/screens/AssistantScreen.module.css` (`.showEarlier:hover`), `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/screens/HomeScreen.module.css` (`.shelfEmptyTitle`), `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/screens/LogsScreen.module.css` (`.showEarlier:hover`), `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/screens/PhoneScreen.module.css` (`.deviceName`), `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/shell/templatePreview.module.css` (`.tmplAccessVerb`), `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/shell/routes/AppInfoModal.module.css` (`.automateBtn`), `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/styles/vault.module.css` (`.grantTitle`, `.parkedCommand`).
  - **The rest of the phantom ink vocabulary** — `--text-muted` → `var(--text-soft)` (12px helper prose under a control label / a keychain heads-up): `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/screens/SettingsDeviceScreen.module.css`, `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/shell/routes/ConnectFlow.module.css`. `--text-secondary` → `var(--text-soft)` (3 rules) and `--text-tertiary` → `var(--text-faint)` (the 10px `.mapping` detail line, the least important rung on the row, and `--text-ghost` is a structural 3:1 rung that does not clear the body floor): `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/screens/ImportScreen.module.css`.
  - **Structural phantoms** — `--border` → `var(--line)` (a 0.5px hairline) in `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/shell/routes/AppInfoModal.module.css`; `--bg-elev-raised` → `var(--bg-elev)` in `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/screens/BackupCard.module.css`, matching the canonical settings text input in `settings-controls.module.css`; `--t-h1` → `var(--t-h2)` in `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/screens/HouseholdScreen.module.css` and `--t-heading` → `var(--t-h2)` (2 rules) in `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/screens/HomeScreen.module.css` — the scale is `--t-h2`/`--t-h3`/`--t-display-1` with **no `h1`**, and `--t-h2` is already the shell's page/section-title idiom (`AutomationsOverviewScreen`, `SettingsConnectionsScreen`, …).
  - **Blueprint-contract token used in shell scope** — `--r-pill` is in `BLUEPRINT_TOKEN_CONTRACT` only; the shell scale stops at `--r-xl` and `radii.ts` documents the pill as composed inline, so `.ladderMember` takes `border-radius: 999px` (119 other shell rules already do) with a comment saying why: `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/screens/SettingsProvidersScreen.module.css`.
  - **Runtime-provided, therefore legitimate** — `--profile-accent` is written from TSX (`style={{ "--profile-accent": avatarColor }}`, `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/screens/SettingsProfileScreen.tsx`) and deliberately has no CSS default: the avatar ring has no meaning until a swatch is chosen. Allowlisted with that reason in `RUNTIME_DECLARED`.
  - **Language dots repaired and measured** — `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/shell/routes/builder/BuilderCode.module.css`: html `--c-blue` → **`--c-rose`**, css `--c-orange` → **`--c-teal`**, js/ts `--c-yellow` → **`--c-ochre`** (md keeps `--c-violet`). The hue budget is nearly forced: `amber` sits **0.031** from `.tokAttr` and `indigo` **0.064** from `.tokKey` (both under the file's 0.08 floor), and `slate` lands **0.038** from the dark theme's composited `--text-ghost`, i.e. reads as the tree's "unknown file type" default. The shipped set holds **0.143** between dots, **0.099 light / 0.168 dark** against that unknown default, and **0.122 light / 0.123 dark** against the four solved syntax inks. `.tokTag` being rose makes the html dot and the html-tag ink the same hue on purpose. Gated by two new tests in `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/shell/routes/builder/BuilderCode.tokens.test.ts`, which read the dot fills out of the stylesheet the same way it already reads the token inks.

- **F5 Clear the pinned unresolved-`var()` debt in `packages/blueprints` — all 12 phantoms bound, `UNRESOLVED_VAR_DEBT` now `[]`.** Same method as F4's shell sweep, applied to the class F4 had explicitly left pinned. The gate is unchanged and still runs; only the ledger it asserts against shrank to empty.
  - **The accent-as-foreground role → the contract token that already names it.** Seven `var(--accent-deep-fg)` references become `var(--accent-text)`. All seven ink text sitting on an `--accent-soft` tint, so this does **not** intersect the `never inks an --accent-deep fill with the theme-stable --on-accent` gate, which polices `--accent-deep` FILLS: `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/blueprints/apps/tasks/components/Board.module.css` (`.eyebrow.toneAccent`), `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/blueprints/apps/tasks/components/Capture.module.css` (`.nlHint`), `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/blueprints/apps/tasks/components/Detail.module.css` (`.receiptChip`), `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/blueprints/apps/tasks/components/Row.module.css` (`.rowNote mark`, the mono chip), `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/blueprints/apps/tasks/components/Sidebar.module.css` (`.navItem[aria-current='true']`, `.consentLine svg`), `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/blueprints/apps/tasks/components/shared.module.css` (`.rowTitle mark`, the pill chip).
  - **The card radius → the card token.** Three `var(--r-lg)` references — a name from the *shell* scale that the blueprint contract does not carry — become `var(--r-card)`, matching the peer cards in the same apps: `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/blueprints/apps/people/components/TrashCard.module.css` (`.card`), `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/blueprints/apps/tally/components/ExpenseUndo.module.css` (`.notice`), `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/blueprints/apps/tally/components/GroupManager.module.css` (`.card`).
  - **The three singletons.** `--acc` → `var(--accent)` on the shared audience picker's focus ring, `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/blueprints/apps/_shared/AudiencePlacement.module.css`; `--t-label` → `var(--t-tiny)` on the sidebar project label, `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/blueprints/apps/tasks/components/Sidebar.module.css`; `--bg-l` → `var(--bg-l, 10%)` (dark-block-only token, given its documented default explicitly rather than added to the light-rung contract), `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/blueprints/apps/photos/Chrome.module.css`.
  - **The ledger** — `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/blueprints/src/token-purity-allowlist.ts`: `UNRESOLVED_VAR_DEBT` is now `[]`, and its doc comment records what each of the twelve turned out to mean so a future reader does not have to re-derive it. The export and the gate in `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/blueprints/src/token-purity.test.ts` are kept and unmodified — the list being empty is exactly what makes the gate strongest, and it stays red-capable (proven below).

- **Type-scale finding recorded** — `docs/decisions.md` gains "#686 — the type scale is not under-adopted, it is under-shaped": measurement of all 1,284 raw `font-size` declarations shows 38% are exactly a token size, 37% within 0.6px, and only 24% genuinely off-scale, with 181 rules already setting `font: var(--t-*)` and then overriding `font-size`. The `--t-*` shorthands cannot express size-without-weight, so the ratchet count is a symptom of token shape rather than author indiscipline.

- **F6 composable size rungs + the exact-match sweep.**
  - **Vocabulary** — `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/design/src/typography.ts`: new `typeSizeRungs()` (one property per **distinct** size, keyed `--t-<key>-size`), `typeKeyToKebab()` (was duplicated in `css.ts` and `contract.ts`), and `blueprintType` + `blueprintTypeShorthand()` — the blueprint type scale, moved here out of the emitter so a size can be read off it. `BlueprintTypeKey` deliberately not exported (knip: no consumer).
  - **Emitters** — `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/design/src/css.ts` emits the nine shell rungs (`--t-body-size` 15px, `--t-display-size` 28px, `--t-mono-size` 12px, `--t-small-size` 13px, `--t-tiny-size` 11px, `--t-title-size` 20px, `--t-display-1-size` 40px, `--t-h2-size` 22px, `--t-h3-size` 16px); `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/design/src/blueprint.ts` derives its six `--t-*` shorthands from `blueprintType` (values byte-identical) and emits the five blueprint rungs (`0.855rem` / `0.72rem` / `0.8rem` / `0.6rem` / `1.15rem`).
  - **Contract** — `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/design/src/contract.ts`: both `SHELL_TOKEN_CONTRACT` and `BLUEPRINT_TOKEN_CONTRACT` now derive their type names (shorthands *and* rungs) from `typeSizeRungs()` / `Object.keys(blueprintType)` rather than hand-listing; the local `kebab` helper is now the shared one.
  - **Gates** — `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/design/src/css-properties.test.ts` gains `each distinct type size gets one composable size rung` (asserts the dedupe: `--t-body-size` present, `--t-body-strong-size` absent, every rung a bare `px`); `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/design/src/design-md.test.ts` gains `the composable size rungs are documented with their values` so the DESIGN.md table cannot rot.
  - **Ratchet** — `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/scripts/lint-design-tokens.mjs`: `countRawFontSize` documents the rungs as the sanctioned form and now counts `font-size: var(--t-<key>)` — a `font` shorthand where a size belongs, which the browser drops whole in silence — as debt instead of letting it hide inside the `var()` carve-out. Cases added to `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/scripts/lint-design-tokens.test.mjs`. Budget regenerated via `--write`: `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/tests/design-token-css-budget.json`, `rawFontSize` 1291 → 880 (−411), every other metric unmoved.
  - **Docs** — `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/DESIGN.md` front matter records the rung spelling under `typography:` (as a comment: the design.md schema warns on any unrecognised top-level token map, and the values *are* the `fontSize` fields already there), and the Typography section gains the rung table plus the plain statement that the shorthands are all-or-nothing and why there are no line-height rungs. `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/docs/decisions.md` gains "Shipped: the vocabulary, and the exact-match half of the sweep". `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/CSS-CONVENTIONS.md` points authors at the rungs and warns off `font-size: var(--t-<role>)`.
  - **The sweep — 411 declarations across 80 stylesheets, 402 in `packages/client/src` and 9 in `packages/blueprints/apps`.** Every one is an exact, same-unit match for a rung on the surface that stylesheet actually resolves against; the resolved-value multiset is unchanged (proof under Verification). By rung: 155× `12px`→`--t-mono-size`, 128× `11px`→`--t-tiny-size`, 89× `13px`→`--t-small-size`, 16× `15px`→`--t-body-size`, 6× `16px`→`--t-h3-size`, 6× `0.8rem`→`--t-small-size`, 3× `22px`→`--t-h2-size`, 3× `0.72rem`→`--t-mono-size`, 2× `20px`→`--t-title-size`, 2× `28px`→`--t-display-size`, 1× `40px`→`--t-display-1-size`. Files:
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/blueprints/apps/agenda/Chrome.module.css`
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/blueprints/apps/docs/components/shared.module.css`
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/blueprints/apps/photos/components/Duplicates.module.css`
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/blueprints/apps/photos/components/Editor.module.css`
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/blueprints/apps/photos/components/Picker.module.css`
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/blueprints/apps/photos/components/Slideshow.module.css`
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/blueprints/apps/tasks/components/Capture.module.css`
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/blueprints/apps/tasks/components/Detail.module.css`
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/screens/AppSettingsPanel.module.css`
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/screens/ApprovalsScreen.module.css`
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/screens/AssistantScreen.module.css`
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/screens/AtlasBrowseTab.module.css`
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/screens/AtlasKindsTab.module.css`
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/screens/AtlasRelationsTab.module.css`
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/screens/AtlasScreen.module.css`
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/screens/AutomationCompilePane.module.css`
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/screens/AutomationEditorScreen.module.css`
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/screens/AutomationTemplatesScreen.module.css`
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/screens/AutomationThreadScreen.module.css`
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/screens/AutomationsOverviewScreen.module.css`
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/screens/BackupCard.module.css`
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/screens/BuilderChatPane.module.css`
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/screens/DevicePairPanel.module.css`
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/screens/DevicesCard.module.css`
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/screens/DiscoverScreen.module.css`
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/screens/GatewayScreen.module.css`
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/screens/HomeScreen.module.css`
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/screens/HouseholdScreen.module.css`
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/screens/ImportScreen.module.css`
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/screens/InsightsScreen.module.css`
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/screens/LocalFootprintCard.module.css`
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/screens/LogsScreen.module.css`
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/screens/OnboardingScreen.module.css`
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/screens/PaletteScreen.module.css`
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/screens/PhoneScreen.module.css`
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/screens/RecoverScreen.module.css`
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/screens/ResourceDialogs.module.css`
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/screens/ResourceReceiptPanel.module.css`
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/screens/RunViewScreen.module.css`
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/screens/SettingsConnectionsScreen.module.css`
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/screens/SettingsDiagnosticsScreen.module.css`
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/screens/SettingsProfileScreen.module.css`
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/screens/SettingsProvidersScreen.module.css`
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/screens/SettingsStorageScreen.module.css`
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/screens/StorageLimitsPanel.module.css`
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/screens/WhatsNewModal.module.css`
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/screens/settings-controls.module.css`
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/shell/CaptureOverlay.module.css`
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/shell/automationTemplatePreview.module.css`
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/shell/chrome.module.css`
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/shell/contextMenu.module.css`
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/shell/gatewaySwitcher.module.css`
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/shell/routes/AppInfoModal.module.css`
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/shell/routes/AppViewRoute.module.css`
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/shell/routes/ConnectFlow.module.css`
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/shell/routes/HandshakeLadder.module.css`
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/shell/routes/RunsPane.module.css`
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/shell/routes/SettingsRoute.module.css`
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/shell/routes/VaultModal.module.css`
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/shell/routes/assistantRich.module.css`
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/shell/routes/builder/BuilderAutomationPane.module.css`
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/shell/routes/builder/BuilderCloud.module.css`
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/shell/routes/builder/BuilderCode.module.css`
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/shell/routes/builder/BuilderHistory.module.css`
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/shell/routes/builder/BuilderPreview.module.css`
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/shell/routes/builder/BuilderShell.module.css`
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/shell/templatePreview.module.css`
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/shell/webhookReveal.module.css`
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/styles/automation.module.css`
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/styles/chatMessage.module.css`
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/styles/controls.module.css`
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/styles/library.module.css`
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/styles/linkBtn.module.css`
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/styles/seg.module.css`
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/styles/select.module.css`
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/styles/toast.module.css`
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/styles/toolGroup.module.css`
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/styles/vault.module.css`
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/ui/AppCard.module.css`
  - `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/client/src/react/ui/Button.module.css`
  - **Left alone, deliberately** — `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/packages/design/kit/kit.css` (all 8 exact matches; dual-surface, see Decisions), the ~477 near-misses within 0.6px, the ~314 genuinely off-scale declarations, and 6 `em`-valued declarations that inherit their base. All remain ratcheted debt. `/Users/srikanth/gitspace/centraid/.claude/worktrees/centraid-design-strategy-323767/apps/mobile/src/kit/theme/tokens.generated.ts` regenerated from the rebuilt design package and is byte-identical: the lowering keeps colors and radii, and a type size is neither.

## Out of scope

- ~~Fixing the 12 pre-existing unresolved `var()` references.~~ **Superseded by F5** — all twelve are fixed and `UNRESOLVED_VAR_DEBT` is empty. The per-site design calls turned out to be determinate once each site's surface was read.
- Collapsing `docs`' and `photos`' app-local `--accent-deep-fg` declarations into `--accent-text`. F5 established they are re-derivations of the contract token, but those two apps *declare* the property, so they are not phantoms and not in this gate's class; folding them is a separate visual-equivalence change.
- ~~Adding composable size/line-height rungs to the type scale and sweeping the ~971 affected declarations.~~ **Partly superseded by F6** — the size rungs exist and the 411 provably-zero-change exact matches are converted. Still out of scope, and still ratcheted debt: the ~477 near-misses (within 0.6px of a rung) and the ~314 genuinely off-scale declarations, both of which are visual changes needing per-site judgement; and `packages/design/kit/kit.css`, which resolves under two token layers at once. Line-height rungs were considered and rejected on the evidence, not deferred (see Decisions).
- Visual redesigns of any surface — this issue is consistency/enforcement only; visual results are preserved.
- Mobile typeface change (recorded as decision, not churned).

## Verification

A1+B1:

```
$ cd packages/design && vitest run
Test Files  16 passed (16)
Tests  158 passed (158)
$ vitest run src/contract.test.ts src/css-properties.test.ts   # orchestrator re-run
Test Files  2 passed (2)
Tests  16 passed (16)
$ bun run typecheck   # packages/design — clean
$ cd apps/mobile && bun run generate:theme   # tokens.generated.ts byte-identical
```

A2+A5:

```
$ cd packages/blueprints && vitest run src/token-purity.test.ts src/shared-css.test.ts
Test Files  2 passed (2)
Tests  7 passed (7)
$ bash .governance/run.sh no-hardcoded-colors
✓ no-hardcoded-colors
$ node scripts/lint-design-tokens.mjs
ok   design-token-css — 82 grandfathered hex value(s), 4 literal font stack(s), zero regressions
```

C1–C4 + D1:

```
$ ls docs/design-language.md && grep -c 'design-language' AGENTS.md packages/gateway/src/skills/ui-grounding.ts
docs/design-language.md
AGENTS.md:1
packages/gateway/src/skills/ui-grounding.ts:1
$ grep -n '#686' docs/decisions.md | head -1
```

D2:

```
$ cd apps/mobile && bun run typecheck && bun run lint
clean
$ vitest run src/screens src/kit/theme src/apps/photos
Test Files 11 passed / Tests 75 passed
```

F1:

```
$ cd packages/design && vitest run src/design-md.test.ts
Test Files  1 passed (1)
Tests  12 passed (12)
```

A3+A4 / B2+B3 / D3 / E (wave 2):

```
$ cd packages/blueprints && vitest run src/token-purity.test.ts src/shared-css.test.ts src/scaffold-defaults.test.ts
Test Files  3 passed (3)
Tests  13 passed (13)
$ node scripts/lint-design-tokens.mjs
ok   design-token-css — 0 grandfathered hex value(s), 4 literal font stack(s), 1291 raw font-size(s), 9 off-scale font-weight(s), 287 raw border-radius(es), zero regressions
$ node --test scripts/lint-design-tokens.test.mjs   # 7/7 pass
$ cd packages/design && vitest run
Test Files  17 passed (17) / Tests  170 passed (170)
$ cd packages/app-engine && vitest run   # 621 passed / 58 files
$ cd packages/gateway && vitest run      # 1281 passed, 6 skipped / 192 files
$ cd packages/client && vitest run       # 213 files / 1738 tests passed
$ bash .governance/packs/srikanth235/centraid/directives/no-hardcoded-colors/check.sh  # exit 0; red-capable on injected #ff00aa
```

Ink-pairing gate:

```
$ cd packages/blueprints && vitest run src/token-purity.test.ts src/shared-css.test.ts
Test Files  2 passed (2)
Tests  8 passed (8)
$ node scripts/lint-design-tokens.mjs
ok   design-token-css — zero regressions
```

Red-capability proven against a real regression: reverting one app's fix returned the stale pairing and the new test failed (1 failed | 3 passed); re-applying it restored green. Verified visually by rendering the emitted tokens + real `kit.css` in a browser across both themes and all 8 palette hues.

Drift-guard red proven: spacing[5] 24→20 in density.ts fails "every spacing rung is stated in order"; reverted.

F1 spec deepening:

```
$ bun run lint:design-md
ok (0 errors; 2 WCAG warnings surfaced -> fixed in follow-up)
$ cd packages/design && vitest run src/design-md.test.ts
Test Files  1 passed (1) / Tests  16 passed (16)
$ bun run lockfile:lint && bun run knip   # both clean
```

Red-capability proven by injecting `#ff00aa` + `rgba()` into `apps/tasks/components/Row.module.css`: vitest ratchet and check.sh both fail; injection reverted (diff empty).

Noted visual delta (intended): two `LocalFootprintCard` animations previously fell back to `cubic-bezier(0.22, 1, 0.36, 1)` because `--ease` was undefined in the shell; they now use the canonical curve.

Mutation floor (`packages/design`), before and after the `css-properties.test.ts` value laws:

```
$ node scripts/mutation/run.mjs --package design   # BEFORE
File           |  total | # killed | # survived |
All files      |  92.78 |       90 |          7 |
 css.ts        |  85.37 |       35 |          6 |
 tile.ts       |  97.96 |       48 |          1 |
 typography.ts | 100.00 |        7 |          0 |
  - packages/design: 92.8% (ok)      # floor 93 -> mutation-pr RED

$ node scripts/mutation/run.mjs --package design   # AFTER
File           |  total | # killed | # survived |
All files      |  98.97 |       96 |          1 |
 css.ts        | 100.00 |       41 |          0 |
 tile.ts       |  97.96 |       48 |          1 |
 typography.ts | 100.00 |        7 |          0 |
  - packages/design: 99.0% (ok)      # floor 93 met

$ cd packages/design && vitest run
Test Files  17 passed (17) / Tests  206 passed (206)
$ bun run lint && bun run format      # clean; format left the test file unchanged
```

One mutant is left alive deliberately: `src/tile.ts:71:13` `HEX_RE.exec(hex)?.groups?.digits` → `?.groups.digits`. It is EQUIVALENT, not a gap — the leading `?.` already short-circuits the whole chain when `exec` returns `null`, and a successful `RegExpExecArray` from a named-group pattern always has `.groups`, so the second `?.` can never be the thing that prevents a throw. No behaviour distinguishes the two programs. The non-hex fallback path it guards is already covered by "a non-hex colour passes through instead of producing NaN paint".

### Palette-hue-as-text rung (`--c-<name>-text`) + `docs` file-kind regression

`docs` file-kind labels as TEXT. "Ratio" is the WORST case across every surface the
label lands on: `--bg-elev`, `--bg`, `--bg-sunken`, *and* the self-tint painted behind
it. The "before #686" column is measured on that column's own shipped tint (15%) and
includes the `.thumbLabel` fade the app also shipped.

```
LIGHT
| kind  | before #686 (hand-picked) | ratio | #686 regression (raw fill) | ratio     | FINAL (solved rung) | ratio |
|-------|---------------------------|-------|----------------------------|-----------|---------------------|-------|
| pdf   | #c2410c                   | 4.74  | #E89A3C                    | 2.11 FAIL | #b91d3a             | 5.10  |
| image | #0e7490                   | 4.91  | #2EA098                    | 2.92 FAIL | #1f6d67             | 4.99  |
| doc   | #4058cf                   | 5.47  | #4E68DD                    | 4.43 FAIL | #3452d8             | 4.95  |
| sheet | #4e7a40                   | 4.60  | #5C8A4E                    | 3.70 FAIL | #46693c             | 5.04  |
| slide | #9a6528                   | 4.51  | #B47B3F                    | 3.29 FAIL | #8f5611             | 5.03  |
| media | #7c3aed                   | 5.22  | #7C5BD9                    | 4.42 FAIL | #6842d3             | 5.00  |

DARK  (the 66% mix to --text mostly held; the light ramp is where the regression bit)
| kind  | #686 regression (66% mix) | ratio | FINAL (solved rung) | ratio |
|-------|---------------------------|-------|---------------------|-------|
| pdf   | #ecb982                   | 7.04  | #ee90a2             | 4.83  |
| image | #7abcb5                   | 5.77  | #38c4ba             | 4.94  |
| doc   | #7f99e7                   | 4.53  | #97a6eb             | 4.82  |
| sheet | #8cad84                   | 5.02  | #8eb881             | 4.86  |
| slide | #c9a37d                   | 5.37  | #eba653             | 4.90  |
| media | #9f91e5                   | 4.56  | #b4a1e9             | 4.98  |

Whole contract, both themes (worst surface / worst self-tint), from the emitted CSS:
| hue          | light text | worst | on 12% tint | dark text | worst | on 12% tint |
|--------------|------------|-------|-------------|-----------|-------|-------------|
| --c-amber    | #8f5611    | 5.30  | 4.89        | #eba653   | 6.02  | 4.90        |
| --c-forest   | #46693c    | 5.55  | 4.89        | #8eb881   | 5.55  | 4.86        |
| --c-indigo   | #3452d8    | 5.56  | 4.81        | #97a6eb   | 5.34  | 4.82        |
| --c-ochre    | #83592e    | 5.41  | 4.80        | #d0a679   | 5.60  | 4.89        |
| --c-rose     | #b91d3a    | 5.63  | 4.95        | #ee90a2   | 5.44  | 4.83        |
| --c-slate    | #535d71    | 5.86  | 5.01        | #a3abbb   | 5.42  | 4.93        |
| --c-teal     | #1f6d67    | 5.40  | 4.81        | #38c4ba   | 5.82  | 4.94        |
| --c-violet   | #6842d3    | 5.62  | 4.85        | #b4a1e9   | 5.49  | 4.98        |

DISTINGUISHABILITY (the six file kinds, after solving)
light: pdf #b91d3a h349deg  image #1f6d67 h175deg  doc #3452d8 h229deg
       sheet #46693c h107deg  slide #8f5611 h33deg  media #6842d3 h256deg
       closest pair in oklab: image/sheet = 0.064   (gate > 0.035)
dark:  pdf #ee90a2 h349deg  image #38c4ba h176deg  doc #97a6eb h229deg
       sheet #8eb881 h106deg  slide #eba653 h33deg  media #b4a1e9 h256deg
       closest pair in oklab: doc/media = 0.040    (gate > 0.035)
The solve moves lightness only, so every rung keeps its fill's hue to <2deg and its
saturation to <0.03 (pinned as a law, not a spot check). Amber/ochre DO collapse
(0.125 -> 0.028 light); `docs` therefore carries rose+amber, not amber+ochre.

BADGES AND FILLS
The one text-on-solid-badge site is QuickLook's kind badge, which is `background:
tintBg(cv, 12)` + `color: var(cv)` -- i.e. the "on 12% tint" column above, 4.80-5.01.
The remaining `var(--kind-*-fill)` marks are pure decoration carrying no information
(a mock page's header bar at .85 over white, 2.03-3.66; the two ruled lines under a
thumbnail label at .18/.14 over the tint, ~1.2). They are unchanged in role from what
shipped; no text or state depends on them.
```

Gates:

```
$ cd packages/design && ../../node_modules/.bin/vitest run
 Test Files  17 passed (17)
      Tests  227 passed (227)

$ cd packages/blueprints && ../../node_modules/.bin/vitest run
 Test Files  45 passed (45)
      Tests  649 passed (649)

$ node scripts/lint-design-tokens.mjs
ok   design-token-css - 0 grandfathered hex value(s), 4 literal font stack(s),
     1291 raw font-size(s), 9 off-scale font-weight(s), 287 raw border-radius(es),
     zero regressions

$ bun run lint:design-md
  "summary": { "errors": 0, "warnings": 0, "infos": 1 }

$ bun run typecheck:affected
 Tasks:    34 successful, 34 total

$ bun run lint          # oxlint --deny-warnings, clean
$ bun run format        # oxfmt, applied
$ bun run knip          # exit 0
```

Proof of red (each sabotage applied, run, reverted):

```
1. bind --kind-pdf back to the raw fill (the exact #686 regression)
   -> --kind-pdf: expected 'var(--c-rose)' to match /^var\(--c-[a-z]+-text\)$/u
      2 failed | 14 passed
2. put the collapsing amber/ochre pair back
   -> expected [ 'rose', 'teal', 'indigo', ... ] to not include 'ochre'
      1 failed | 15 passed
3. tint from the TEXT rung instead of the fill rung
   -> expected 'color-mix(in oklab, var(--kind-pdf) 1...' to contain 'var(--kind-pdf-fill)'
      1 failed | 15 passed
4. AA_PALETTE_TEXT 4.8 -> 1 (emit the raw fill as the text rung)
   -> dark --c-slate-text on hsl(171 12% 15%): expected 2.55 to be >= 4.5  (+15 more)
      16 failed | 37 passed
5. PALETTE_TEXT_TINT 0.12 -> 0 (drop the self-tint allowance)
   -> dark --c-teal-text on its own 12% tint: expected 4.17 to be >= 4.5  (+12 more)
      13 failed | 40 passed
6. let the solver desaturate (s -> s * 0.5) instead of only moving lightness
   -> light --c-amber-text saturation: expected 0.392 to be less than 0.03
   -> dark indigo vs violet collapsed: expected 0.023 to be greater than 0.035
      3 failed | 50 passed
7. drift DESIGN.md off the TS source (c-amber-text -> the raw fill hex)
   -> c-amber-text: expected '#E89A3C' to be '#8f5611'
      1 failed | 16 passed
```

### Semantic states — measured grid (worst cell per ramp, before → after)

`--danger` / `--success` / `--warning` recomputed from the EMITTED CSS of both
emitters, bare and on a 12% wash of the state itself. Twelve of the twenty-four
"before" cells were under the 4.5 body floor; every "after" cell clears it.

```text
shell light --danger #C44A4A->#a53636 | --bg 4.63->6.44 | --bg-app 4.75->6.60 | --bg-elev 4.75->6.60 | --bg-sunken 4.20->5.84 | wash 3.60->4.89 | inv-ink 4.35->6.05
shell light --success #456B39->#436837 | --bg 5.99->6.25 | --bg-app 6.15->6.41 | --bg-elev 6.15->6.41 | --bg-sunken 5.44->5.68 | wash 4.63->4.83 | inv-ink 5.64->5.88
shell light --warning #9A6B1F->#7c5619 | --bg 4.55->6.39 | --bg-app 4.67->6.56 | --bg-elev 4.67->6.56 | --bg-sunken 4.13->5.80 | wash 3.59->4.90 | inv-ink 4.28->6.01
shell dark  --danger #C44A4A->#d37878 | --bg 4.10->6.23 | --bg-app 4.43->6.73 | --bg-elev 3.74->5.69 | --bg-sunken 4.35->6.61 | wash 3.36->4.83 | inv-ink 3.75->5.70
shell dark  --success #5C8A4E->#6ba15b | --bg 4.81->6.36 | --bg-app 5.20->6.87 | --bg-elev 4.40->5.81 | --bg-sunken 5.11->6.75 | wash 3.83->4.94 | inv-ink 4.40->5.82
shell dark  --warning #E0A94A->#e0a94a | --bg 9.20->9.20 | --bg-app 9.94->9.94 | --bg-elev 8.41->8.41 | --bg-sunken 9.77->9.77 | wash 6.80->6.80 | inv-ink 8.42->8.42
bp    light --danger #c8382f->#ab3028 | --bg 4.98->6.35 | --bg-elev 5.17->6.59 | --bg-sunken 4.74->6.04 | wash 3.98->5.01 | inv-ink 5.17->6.59
bp    light --success #2f7d4f->#286a43 | --bg 4.85->6.25 | --bg-elev 5.04->6.50 | --bg-sunken 4.62->5.95 | wash 3.96->5.02 | inv-ink 5.04->6.50
bp    light --warning #9a6b1f->#7c5619 | --bg 4.50->6.31 | --bg-elev 4.67->6.56 | --bg-sunken 4.28->6.01 | wash 3.70->5.08 | inv-ink 4.67->6.56
bp    dark  --danger #f0645b->#f69d98 | --bg-elev 4.62->7.05 | --bg-sunken 3.98->6.07 | wash 3.44->4.87 | inv-ink 4.80->7.33
bp    dark  --success #5cc98a->#60ca8d | --bg-elev 7.04->7.15 | --bg-sunken 6.06->6.15 | wash 4.78->4.85 | inv-ink 7.32->7.43
bp    dark  --warning #e0a94a->#e1ab4e | --bg-elev 6.88->7.01 | --bg-sunken 5.92->6.03 | wash 4.72->4.81 | inv-ink 7.15->7.29

.kit-btn.primary.danger — the FILLED destructive confirm, ink = --text-inv:
  light  --text 3.81 FAIL  ->  --text-inv 6.05 PASS
  dark   --text 4.09 FAIL  ->  --text-inv 5.70 PASS
```

Proof of red — each sabotage applied, measured, reverted:

```text
1  shell DANGER_DARK back to #C44A4A
   × dark: semantic states clear the BODY floor on every surface
     dark --danger on hsl(0 0% 5%): expected 4.0958 to be >= 4.5
   × dark: the filled destructive button carries its ink
     dark .kit-btn.primary.danger: expected 3.7464 to be >= 4.5
2  blueprint dark --danger back to #f0645b
   × dark: semantic states clear the BODY floor on card and track
     blueprint dark --danger on its own tint over hsl(171 12% 15%): expected 3.9679 to be >= 4.5
3  blueprint light --warning back to #9a6b1f
   × light: semantic states clear the BODY floor on card and track
     blueprint light --warning on its own tint over #ffffff: expected 4.0127 to be >= 4.5
4  shell WARNING_LIGHT back to #9A6B1F
   × light: semantic states clear the BODY floor on every surface
     light --warning on its own 12% tint over #FCFCFC: expected 3.9306 to be >= 4.5
5  DANGER_BASE desaturated to #6E6E6E (a grey)
   FIRST ATTEMPT PASSED 61/61 — the contrast floors and the oklab separation
   check are both satisfied by a grey. `readsAsRole` (hue family + minimum
   chroma) was added because of this, and the sabotage is now red:
   × light --danger (#5c5c5c) is no longer a danger colour
   × dark  --danger (#929292) is no longer a danger colour
6  .kit-btn.primary.danger re-inked with var(--text)
   × the filled destructive button carries --text-inv, not --text
```

Gates:

```text
$ cd packages/design && ../../node_modules/.bin/vitest run
  Test Files  17 passed (17)
       Tests  236 passed (236)

$ cd packages/blueprints && ../../node_modules/.bin/vitest run
  Test Files  45 passed (45)
       Tests  649 passed (649)

$ cd packages/client && ../../node_modules/.bin/vitest run
  Test Files  213 passed (213)
       Tests  1738 passed (1738)

$ cd apps/mobile && ../../node_modules/.bin/vitest run
  Test Files  68 passed (68)
       Tests  381 passed (381)

$ node scripts/lint-design-tokens.mjs
ok   design-token-css — 0 grandfathered hex value(s), 4 literal font stack(s),
     1291 raw font-size(s), 9 off-scale font-weight(s), 287 raw border-radius(es),
     zero regressions

$ bun run lint:design-md
  "summary": { "errors": 0, "warnings": 0, "infos": 1 }

$ bun run typecheck:affected
  Tasks:    34 successful, 34 total

$ bun run lint          # oxlint --deny-warnings
$ bun run format        # oxfmt, 3395 files
```

### Palette-hue-as-text in the shell (client half of #686)

Before/after, measured off the SHELL emitter (`toCss()`, dark `--bg-l: 5%`) with
`packages/design/src/oklab.ts` — worst cell over the four shell surfaces
(`--bg`, `--bg-app`, `--bg-elev`, `--bg-sunken`), bare and on the hue's own
wash. `!` marks below the 4.5:1 body floor.

```
                    LIGHT                              DARK
hue      fill(bare) → rung(bare)  fill(wash) → rung   fill(bare) → rung(bare)  fill(wash) → rung
amber      2.04!        5.30        1.80!     4.74      7.71         8.55        5.62      6.45
forest     3.57!        5.55        2.93!     4.69      4.40!        7.88        3.53!     6.54
indigo     4.27!        5.56        3.41!     4.56      3.68!        7.58        3.09!     6.47
ochre      3.18!        5.41        2.65!     4.60      4.94         7.96        3.90!     6.48
rose       3.13!        5.63        2.56!     4.70      5.02         7.73        4.04!     6.39
slate      5.03         5.86        3.98!     4.77      3.12!        7.69        2.66!     6.66
teal       2.82!        5.40        2.36!     4.63      5.58         8.26        4.36!     6.62
violet     4.27!        5.62        3.41!     4.61      3.68!        7.79        3.08!     6.65
```

17 of 32 bare cells below AA before; 0 of 32 after. Worst cell overall goes
2.04 -> 4.55 (light, forest on a 16% wash of itself over `--bg-sunken`).

Wash ceiling — worst rung ratio by self-wash strength, light theme:

```
hue     10%    12%    14%    16%    18%
amber   4.93   4.89   4.81   4.74   4.67
forest  5.00   4.89   4.79   4.69   4.55
indigo  4.91   4.81   4.68   4.56   4.44!
ochre   4.89   4.80   4.69   4.60   4.52
rose    5.06   4.95   4.81   4.70   4.60
slate   5.15   5.01   4.91   4.77   4.64
teal    4.92   4.81   4.73   4.63   4.53
violet  4.97   4.85   4.73   4.61   4.49!
```

Syntax-highlighting distinguishability (oklab distance, closest pair in the
five-class scheme plus the untokenized remainder):

```
scheme                                 light            dark
tag=rose attr=violet str=forest key=indigo (before)   0.075 (attr/key)   0.040 (attr/key)
tag=rose attr=amber  str=forest key=indigo (after)    0.119 (attr/str)   0.126 (tag/attr)
```

Suites:

```
$ cd packages/design && ../../node_modules/.bin/vitest run
 Test Files  18 passed (18)
      Tests  258 passed (258)

$ cd packages/client && ../../node_modules/.bin/vitest run
 Test Files  214 passed (214)
      Tests  1743 passed (1743)

$ node scripts/lint-design-tokens.mjs
ok   design-token-css — 0 grandfathered hex value(s), 4 literal font stack(s), 1291 raw font-size(s), 9 off-scale font-weight(s), 287 raw border-radius(es), 0 palette-hue-as-text, zero regressions

$ node --test scripts/lint-design-tokens.test.mjs
# pass 8
# fail 0

$ bun run lint:css
ok   css-classes — 406 module import(s) across 789 file(s), no dead classNames

$ bun run lint:design-md
"errors": 0, "warnings": 0, "infos": 1

$ bun run typecheck:affected
 Tasks:    34 successful, 34 total

$ bun run lint
(clean)

$ bun run format
Finished in 1325ms on 3398 files using 8 threads.
```

Proof of red — every gate sabotaged and reverted:

```
$ # 1. ratchet: reintroduce a raw hue as ink
$ perl -0pi -e 's/color: var\(--c-amber-text\)/color: var(--c-amber)/' \
    packages/client/src/react/ui/StatusPill.module.css
$ node scripts/lint-design-tokens.mjs
FAIL — design-token CSS ratchet found 1 mismatch(es):
  packages/client/src/react/ui/StatusPill.module.css: paletteHueAsText increased 0 → 1

$ # 2a. shell grid: point it at the FILL instead of the solved rung
 Tests  12 failed | 10 passed (22)

$ # 2b. shell grid: push the wash ceiling back to 18%
AssertionError: light --c-indigo-text on a 18% wash of its own fill over #F0F1F3:
  expected 4.436688810449676 to be greater than or equal to 4.5
AssertionError: light --c-violet-text on a 18% wash of its own fill over #F0F1F3:
  expected 4.493011775396085 to be greater than or equal to 4.5
 Tests  2 failed | 20 passed (22)

$ # 3a. syntax scheme: .tokAttr back to violet (the collapse this fixed)
AssertionError: light .tokAttr vs .tokKey collapsed: expected 0.07494566107159638 to be greater than 0.08
AssertionError: dark .tokAttr vs .tokKey collapsed:  expected 0.04040278756303021 to be greater than 0.08
 Tests  2 failed | 3 passed (5)

$ # 3b. syntax scheme: .tokAttr back to the raw FILL
AssertionError: .tokAttr must take a solved rung, not a fill: expected '--c-violet' not to match /^--c-(?!.*-text$)/u
AssertionError: dark .tokAttr on hsl(0 0% 5%): expected 4.030934767679964 to be greater than or equal to 4.5
 Tests  2 failed | 3 passed (5)

$ # all reverted; green again
 Tests  22 passed (22)   # contrast-shell-palette
 Tests  5 passed (5)     # BuilderCode.tokens
```

Note on 3a: the separation gate was first written at the `docs` set's 0.035
floor, and the sabotage PASSED — 0.040 clears 0.035. The floor was raised to
0.08 (above the 0.06 the semantic states take) precisely so the gate is red for
the defect it exists to catch. A gate that green-lights its own bug is
decoration; this is the run that found that out.

Shell-side unresolved-`var()` gate (13 phantoms) + shared reader:

```
$ cd packages/design && ../../node_modules/.bin/vitest run
 Test Files  19 passed (19)
      Tests  270 passed (270)

$ cd packages/client && ../../node_modules/.bin/vitest run
 Test Files  215 passed (215)
      Tests  1750 passed (1750)

$ cd packages/blueprints && ../../node_modules/.bin/vitest run
 Test Files  45 passed (45)
      Tests  649 passed (649)

$ node scripts/lint-design-tokens.mjs
ok   design-token-css — 0 grandfathered hex value(s), 4 literal font stack(s),
     1291 raw font-size(s), 9 off-scale font-weight(s), 287 raw border-radius(es),
     0 palette-hue-as-text, zero regressions
     # unchanged: `border-radius: 999px` is the documented pill idiom, above the
     # >=99px carve-out, so replacing var(--r-pill) does not move rawRadius

$ bun run lint:css
ok   css-classes — 406 module import(s) across 789 file(s), no dead classNames

$ bun run lint:design-md
{"findings":[{"severity":"info","message":"Design system defines 64 colors, 7 typography
  scales, 5 rounding levels, 7 spacing tokens, 67 components.","rule":"token-summary"}],
 "summary":{"errors":0,"warnings":0,"infos":1}}

$ bun run typecheck:affected
 Tasks:    34 successful, 34 total

$ bun run lint            # oxlint --deny-warnings .
(clean)

$ bun run knip
(configuration hints only; exit 0)

$ oxfmt --check <touched files>
All matched files use the correct format.

$ cd packages/design && vitest run --coverage.include='src/**'
  css-vars.ts   |  100 stmts | 87.5 branch |  100 funcs |  100 lines
  All files     | 97.02      | 79.85       |  100       | 98.34
  # packages/design/src floors are 98 lines / 70 branches — held
```

Proof of red (six sabotages, each reverted):

```
$ # 1. reintroduce a phantom in shell CSS (HomeScreen .shelfEmptyTitle -> var(--text-1))
AssertionError: a fallback-less var() naming nothing declared silently drops its
  declaration. …: expected [ Array(1) ] to strictly equal []
+   "react/screens/HomeScreen.module.css -> --text-1"
 Tests  1 failed | 2 passed (3)

$ # 2. js/ts dot -> --c-amber (the hue barred for colliding with .tokAttr)
AssertionError: dark js/ts dot vs .tokAttr: expected 0.030704790366375714 to be greater than 0.08
 Tests  1 failed | 8 passed (9)

$ # 3. js/ts dot -> --c-slate (the hue barred for colliding with the tree's unknown default)
AssertionError: dark js/ts vs unknown dot collapsed: expected 0.03810857313766087 to be greater than 0.08
 Tests  2 failed | 7 passed (9)

$ # 4. add a REDUNDANT runtime allowlist entry (--depth, which CSS declares)
+   "--depth: CSS declares it, so the entry is redundant"
 Tests  1 failed | 2 passed (3)

$ # 5. rename the allowlist entry so the component no longer matches
+   "react/screens/SettingsProfileScreen.module.css -> --profile-accent"
+   "--nope-accent: react/screens/SettingsProfileScreen.tsx no longer sets it"
 Tests  2 failed | 1 passed (3)
 # both directions red: the phantom surfaces AND the stale entry is named

$ # 6. blueprints gate still red after being rewired onto the shared reader
+   "notes/Chrome.module.css -> --phantom-token"
 Tests  1 failed | 4 passed (5)

$ # all six reverted; green again
 Tests  3 passed (3)     # shell-var-resolution
 Tests  9 passed (9)     # BuilderCode.tokens
 Tests  5 passed (5)     # token-purity
```

Note on 2/3: the two barred hues were found by measurement, not by taste. `slate`
was the first pick for js/ts on pairwise-separation grounds (0.162 between dots,
the best available triple) and only the `--text-ghost` comparison — the tree's
own fallback for an unrecognized file — ruled it out at 0.038 on dark. A dot set
that is internally distinguishable and still collides with "unknown" is the same
class of defect as the violet/indigo token collapse this issue already fixed.

F5 — the pinned `var()` debt cleared:

```
$ cd packages/blueprints && ../../node_modules/.bin/vitest run
 Test Files  45 passed (45)
      Tests  649 passed (649)

$ cd packages/design && ../../node_modules/.bin/vitest run
 Test Files  19 passed (19)
      Tests  270 passed (270)

$ cd packages/client && ../../node_modules/.bin/vitest run
 Test Files  215 passed (215)
      Tests  1750 passed (1750)

$ node scripts/lint-design-tokens.mjs
ok   design-token-css — 0 grandfathered hex value(s), 4 literal font stack(s),
     1291 raw font-size(s), 9 off-scale font-weight(s), 287 raw border-radius(es),
     0 palette-hue-as-text, zero regressions

$ bun run lint:css
ok   css-classes — 406 module import(s) across 789 file(s), no dead classNames

$ bun run lint:design-md
"errors": 0, "warnings": 0, "infos": 1

$ bun run typecheck:affected
 Tasks:    34 successful, 34 total

$ bun run lint          # oxlint --deny-warnings, clean
$ bun run knip          # exit 0
$ bun run format        # oxfmt, 3401 files; `git status` stays at exactly the 12 touched files

# Proof of red — reintroduce one phantom, gate fails, revert from a saved copy
# (never `git checkout <file>`; this tree carries uncommitted work).
$ cp apps/tasks/components/Board.module.css "$SCRATCH/board.bak"
$ perl -pi -e 's/var\(--accent-text\)/var(--accent-deep-fg)/' apps/tasks/components/Board.module.css
$ ../../node_modules/.bin/vitest run src/token-purity.test.ts
 × resolves every fallback-less var() an app references
 AssertionError: a fallback-less var() naming nothing declared silently drops its
 declaration; declare the token, use a contract name, or give it a fallback:
 expected [ Array(1) ] to strictly equal []
 +   "tasks/components/Board.module.css -> --accent-deep-fg",
      Tests  1 failed | 4 passed (5)
$ cp "$SCRATCH/board.bak" apps/tasks/components/Board.module.css   # IDENTICAL
```

F6 (composable size rungs + exact-match sweep):

```
$ cd packages/design && ../../node_modules/.bin/vitest run
 Test Files  19 passed (19)
      Tests  272 passed (272)
$ cd packages/blueprints && ../../node_modules/.bin/vitest run
 Test Files  45 passed (45)
      Tests  649 passed (649)
$ cd packages/client && ../../node_modules/.bin/vitest run
 Test Files  215 passed (215)
      Tests  1750 passed (1750)
$ node scripts/lint-design-tokens.mjs
ok   design-token-css — 0 grandfathered hex value(s), 4 literal font stack(s), 880 raw
font-size(s), 9 off-scale font-weight(s), 287 raw border-radius(es), 0
palette-hue-as-text, zero regressions
$ node --test scripts/lint-design-tokens.test.mjs
# pass 9   # fail 0
$ bun run lint:css
ok   css-classes — 406 module import(s) across 789 file(s), no dead classNames
$ bun run lint:design-md
"errors": 0, "warnings": 0, "infos": 1
$ bun run typecheck:affected
 Tasks:    34 successful, 34 total
$ bun run lint            # oxlint --deny-warnings, silent = clean
$ bun run knip            # 0 unused files/exports/types/deps
$ bun run format && bun run format:check
All matched files use the correct format.
$ cd apps/mobile && bun run generate:theme
Wrote apps/mobile/src/kit/theme/tokens.generated.ts from @centraid/design#toBlueprintCss
$ git status --short apps/mobile   # byte-identical, nothing to commit
```

**Emitter diff — nothing moved but the new rungs.** Both stylesheets were rendered from
the pristine `packages/design/src` and from the working tree and compared:

```
$ diff <(grep -v -- '--t-.*-size' after/shell.css) before/shell.css
SHELL: identical apart from new size rungs
$ diff <(grep -v -- '--t-.*-size' after/bp.css | sort) <(sort before/bp.css)
BLUEPRINT: same declaration multiset (only --t-* source order changed; none
references another --t-*)
$ grep -c 'var(--t-' after/bp.css
0
```

The blueprint `--t-*` declarations move to alphabetical order because they are now
generated from `blueprintType`. Inert: no `--t-*` value references another `--t-*`
(the `grep -c` above is the check), so declaration order inside the block cannot
change what any of them resolves to.

**Zero-change proof — the resolved multiset, not an assertion.** For BOTH trees
(pristine copy vs working tree) every `font-size` declaration in all three ratchet
targets is resolved to a concrete value, following `var(--t-*-size)` through the
*generated* stylesheet for that surface, and compared per file, per line. Files under
`packages/design/kit` render under both token layers, so each of their declarations is
resolved twice — once against the shell rungs, once against the blueprint rungs — and
both resolutions must be unchanged:

```
$ node prove.mjs "$PWD"
files compared: 155
resolved font-size observations: 1372
files whose resolved multiset changed: 0
exit=0
```

Red-capable, proven by sabotage and reverted with `cp` (never `git checkout` — the tree
carries uncommitted work):

```
$ perl -0pi -e 's/var\(--t-tiny-size\)/var(--t-small-size)/' \
    packages/client/src/react/screens/AppSettingsPanel.module.css
$ node prove.mjs "$PWD"
DIFF packages/client/src/react/screens/AppSettingsPanel.module.css
  before: … |346:shell=11px| …
  after:  … |346:shell=13px| …
files whose resolved multiset changed: 1
exit=1
$ cp "$SCRATCH/sabotage.bak" packages/client/src/react/screens/AppSettingsPanel.module.css
files whose resolved multiset changed: 0
```

**Budget delta — exactly the conversion count, and nothing else.** Regenerated with
`node scripts/lint-design-tokens.mjs --write`, then differenced against the pristine
budget:

```
rawHex                   0 ->     0  delta 0
literalFontFamily        4 ->     4  delta 0
rawFontSize           1291 ->   880  delta -411
rawFontWeight            9 ->     9  delta 0
rawRadius              287 ->   287  delta 0
paletteHueAsText         0 ->     0  delta 0
budget entries changed: 80
non-rawFontSize metric changes: none
entries added: 0 removed: 6
```

−411 = the 411 conversions. The six removed entries are files whose only recorded
metric was `rawFontSize` and whose count reached 0 (`…/photos/components/Editor.module.css`,
`…/shell/contextMenu.module.css`, `…/styles/linkBtn.module.css`, `…/styles/select.module.css`,
`…/styles/toast.module.css`, `…/ui/Button.module.css` — 3 there, 1 each elsewhere); the
scanner only records non-zero metrics, so their disappearance *is* the decrease.

**The new ratchet rule is red-capable.** `font-size: var(--t-<key>)` — a `font`
shorthand where a size belongs — is now counted as debt rather than hidden by the
`var()` carve-out. There are zero such sites today, so the budget did not move; proven
by sabotage on a real file and reverted with `cp`:

```
$ perl -0pi -e 's/font-size: var\(--t-small-size\)/font-size: var(--t-small)/' \
    packages/client/src/react/ui/Button.module.css
$ node scripts/lint-design-tokens.mjs
FAIL — design-token CSS ratchet found 1 mismatch(es):
  packages/client/src/react/ui/Button.module.css: rawFontSize increased 0 → 1
exit=1
$ cp "$SCRATCH/sab2.bak" packages/client/src/react/ui/Button.module.css
ok   design-token-css — … zero regressions   # restored, exit=0
```

**Line-height rungs were rejected on measurement, not omitted.** Across the three
targets there are 227 hand-written `line-height` declarations; the top values are
`1.5` ×58, `1.45` ×38, `1.4` ×37, `1` ×22, `1.55` ×18 — unitless multipliers — while
the chrome scale's line-heights are absolute px (`22px`, `26px`, `34px`, …). Exactly
one declaration in the whole set is a px length. A `--t-body-line-height: 22px` rung
would have essentially no adopters.

**Surfaces confirmed to resolve the new names at runtime.** Every consumer builds its
token block from the emitters rather than a hand-copied literal — `apps/web/src/main.ts`
and `apps/desktop/src/main/preload-core.ts` both call `tokens.toCss()`, and
`packages/client/src/react/shell/routes/InlineAppRoute.tsx` rescopes `toBlueprintCss()`
onto the inline app root — so there is no surface where a rung could be referenced but
undeclared. The two unresolved-`var()` gates (client against `SHELL_TOKEN_CONTRACT`,
blueprints against `BLUEPRINT_TOKEN_CONTRACT`) are the mechanical check for that, and
both are green above.

## Steering

Audited by a fresh-context Haiku sub-agent against the session transcript: no steering events occurred in this session — the user's messages were initial direction and scope-setting, with no interrupts or mid-task corrections. Checks: (1) every steering event recorded — **PASS** (none to record); (2) no non-steering message recorded as steering — **PASS**.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code-ab8b1729-92f-1785603077-1 | claude-code | ab8b1729-92f0-445f-9f42-5a85fc1b1575 | #686 | claude-fable-5 | 141 | 209121 | 6328235 | 84115 | 293377 | 13.1494 | 141 | 209121 | 6328235 | 84115 | feat(design): emit spacing scale and shell motion token in the contracts (#686)C |
| claude-code-ab8b1729-92f-1785603234-1 | claude-code | ab8b1729-92f0-445f-9f42-5a85fc1b1575 | #686 | claude-fable-5 | 8 | 14046 | 451851 | 4167 | 18221 | 0.8359 | 149 | 223167 | 6780086 | 88282 | feat(design): emit spacing scale and shell motion token in the contracts (#686)C |
| claude-code-ab8b1729-92f-1785603291-1 | claude-code | ab8b1729-92f0-445f-9f42-5a85fc1b1575 | #686 | claude-fable-5 | 6 | 14697 | 353547 | 966 | 15669 | 0.5856 | 155 | 237864 | 7133633 | 89248 | feat(design): emit spacing scale and shell motion token in the contracts (#686)C |
| claude-code-ab8b1729-92f-1785603365-1 | claude-code | ab8b1729-92f0-445f-9f42-5a85fc1b1575 | #686 | claude-fable-5 | 12 | 7658 | 744886 | 2002 | 9672 | 0.9408 | 167 | 245522 | 7878519 | 91250 | feat(design): emit spacing scale and shell motion token in the contracts (#686)C |
| claude-code-ab8b1729-92f-1785603470-1 | claude-code | ab8b1729-92f0-445f-9f42-5a85fc1b1575 | #686 | claude-fable-5 | 20 | 12401 | 1288637 | 8329 | 20750 | 1.8603 | 187 | 257923 | 9167156 | 99579 | feat(design): emit spacing scale and shell motion token in the contracts (#686)C |
| claude-code-ab8b1729-92f-1785603553-1 | claude-code | ab8b1729-92f0-445f-9f42-5a85fc1b1575 | #686 | claude-fable-5 | 10 | 9175 | 678398 | 1249 | 10434 | 0.8556 | 197 | 267098 | 9845554 | 100828 | feat(design): emit spacing scale and shell motion token in the contracts (#686)C |
| claude-code-ab8b1729-92f-1785603846-1 | claude-code | ab8b1729-92f0-445f-9f42-5a85fc1b1575 | #686 | claude-fable-5 | 80 | 73268 | 6128519 | 31057 | 104405 | 8.5980 | 277 | 340366 | 15974073 | 131885 | feat(design): emit spacing scale and shell motion token in the contracts (#686)C |
| claude-code-ab8b1729-92f-1785603927-1 | claude-code | ab8b1729-92f0-445f-9f42-5a85fc1b1575 | #686 | claude-fable-5 | 6 | 3078 | 500757 | 3324 | 6408 | 0.7055 | 283 | 343444 | 16474830 | 135209 | test(blueprints): token-purity ratchet and no-hardcoded-colors directive (#686)C |
| claude-code-ab8b1729-92f-1785603979-1 | claude-code | ab8b1729-92f0-445f-9f42-5a85fc1b1575 | #686 | claude-fable-5 | 2 | 380 | 168961 | 205 | 587 | 0.1840 | 285 | 343824 | 16643791 | 135414 | test(blueprints): token-purity ratchet and no-hardcoded-colors directive (#686)C |
| claude-code-ab8b1729-92f-1785604048-1 | claude-code | ab8b1729-92f0-445f-9f42-5a85fc1b1575 | #686 | claude-fable-5 | 2 | 285 | 169341 | 211 | 498 | 0.1835 | 287 | 344109 | 16813132 | 135625 | test(blueprints): token-purity ratchet and no-hardcoded-colors directive (#686)C |
| claude-code-ab8b1729-92f-1785604102-1 | claude-code | ab8b1729-92f0-445f-9f42-5a85fc1b1575 | #686 | claude-fable-5 | 4 | 3460 | 339252 | 1214 | 4678 | 0.4432 | 291 | 347569 | 17152384 | 136839 | test(blueprints): token-purity ratchet and no-hardcoded-colors directive (#686)C |
| claude-code-ab8b1729-92f-1785604170-1 | claude-code | ab8b1729-92f0-445f-9f42-5a85fc1b1575 | #686 | claude-fable-5 | 4 | 2450 | 342712 | 3380 | 5834 | 0.5424 | 295 | 350019 | 17495096 | 140219 | docs(design): canonical design-language rulebook, neutralize stale design-sync,  |
| claude-code-ab8b1729-92f-1785604218-1 | claude-code | ab8b1729-92f0-445f-9f42-5a85fc1b1575 | #686 | claude-fable-5 | 2 | 1763 | 172581 | 212 | 1977 | 0.2052 | 297 | 351782 | 17667677 | 140431 | docs(design): canonical design-language rulebook, neutralize stale design-sync,  |
| claude-code-ab8b1729-92f-1785604286-1 | claude-code | ab8b1729-92f0-445f-9f42-5a85fc1b1575 | #686 | claude-fable-5 | 10 | 2245 | 873464 | 1388 | 3643 | 0.9710 | 307 | 354027 | 18541141 | 141819 | docs(design): canonical design-language rulebook, neutralize stale design-sync,  |
| claude-code-ab8b1729-92f-1785604343-1 | claude-code | ab8b1729-92f0-445f-9f42-5a85fc1b1575 | #686 | claude-fable-5 | 2 | 395 | 175649 | 194 | 591 | 0.1903 | 309 | 354422 | 18716790 | 142013 | docs(design): design-language rulebook, design-sync cleanup, roles decision (#68 |
| claude-code-ab8b1729-92f-1785604406-1 | claude-code | ab8b1729-92f0-445f-9f42-5a85fc1b1575 | #686 | claude-fable-5 | 4 | 594 | 352088 | 1730 | 2328 | 0.4461 | 313 | 355016 | 19068878 | 143743 | refactor(mobile): onboarding and photos tints onto design tokens (#686)Co-Author |
| claude-code-ab8b1729-92f-1785604795-1 | claude-code | ab8b1729-92f0-445f-9f42-5a85fc1b1575 | #686 | claude-fable-5 | 64 | 79890 | 5847992 | 80695 | 160649 | 10.8820 | 377 | 434906 | 24916870 | 224438 | docs(design): root DESIGN.md brief with drift-guard test (#686)Co-Authored-By: C |
| claude-code-ab8b1729-92f-1785604961-1 | claude-code | ab8b1729-92f0-445f-9f42-5a85fc1b1575 | #686 | claude-fable-5 | 2 | 4832 | 195098 | 205 | 5039 | 0.2658 | 379 | 439738 | 25111968 | 224643 | docs(design): root DESIGN.md brief with drift-guard test (#686)Co-Authored-By: C |
| claude-code-ab8b1729-92f-1785605097-1 | claude-code | ab8b1729-92f0-445f-9f42-5a85fc1b1575 | #686 | claude-fable-5 | 2 | 297 | 199930 | 237 | 536 | 0.2155 | 381 | 440035 | 25311898 | 224880 | docs(design): root DESIGN.md brief with drift-guard test (#686)Co-Authored-By: C |
| claude-code-ab8b1729-92f-1785605577-1 | claude-code | ab8b1729-92f0-445f-9f42-5a85fc1b1575 | #686 | claude-fable-5 | 94 | 93135 | 10590697 | 34884 | 128113 | 13.5000 | 475 | 533170 | 35902595 | 259764 | docs(design): root DESIGN.md brief with drift guard, tripwire prose fixes (#686) |
| claude-code-ab8b1729-92f-1785605633-1 | claude-code | ab8b1729-92f0-445f-9f42-5a85fc1b1575 | #686 | claude-fable-5 | 2 | 744 | 240453 | 214 | 960 | 0.2605 | 477 | 533914 | 36143048 | 259978 | docs(design): root DESIGN.md brief with drift guard, tripwire prose fixes (#686) |
| claude-code-ab8b1729-92f-1785605759-1 | claude-code | ab8b1729-92f0-445f-9f42-5a85fc1b1575 | #686 | claude-fable-5 | 12 | 10986 | 1451847 | 6316 | 17314 | 1.9051 | 489 | 544900 | 37594895 | 266294 | docs(design): root DESIGN.md brief with drift guard, tripwire prose fixes (#686) |
| claude-code-ab8b1729-92f-1785605873-1 | claude-code | ab8b1729-92f0-445f-9f42-5a85fc1b1575 | #686 | claude-fable-5 | 26 | 8051 | 3223768 | 5157 | 13234 | 3.5825 | 515 | 552951 | 40818663 | 271451 | docs(design): root DESIGN.md brief with drift guard, tripwire prose fixes (#686) |
| claude-code-ab8b1729-92f-1785605940-1 | claude-code | ab8b1729-92f0-445f-9f42-5a85fc1b1575 | #686 | claude-fable-5 | 2 | 600 | 250053 | 400 | 1002 | 0.2776 | 517 | 553551 | 41068716 | 271851 | feat(blueprints): one component vocabulary, token-driven scaffold baseline (#686 |
| claude-code-ab8b1729-92f-1785606006-1 | claude-code | ab8b1729-92f0-445f-9f42-5a85fc1b1575 | #686 | claude-fable-5 | 2 | 538 | 250653 | 268 | 808 | 0.2708 | 519 | 554089 | 41319369 | 272119 | refactor(client): radius and weight token adoption, four-metric css ratchet (#68 |
| claude-code-ab8b1729-92f-1785606078-1 | claude-code | ab8b1729-92f0-445f-9f42-5a85fc1b1575 | #686 | claude-fable-5 | 6 | 1623 | 753573 | 1248 | 2877 | 0.8363 | 525 | 555712 | 42072942 | 273367 | refactor(blueprints): burn eight system apps down onto the token contract (#686) |
| claude-code-ab8b1729-92f-1785606152-1 | claude-code | ab8b1729-92f0-445f-9f42-5a85fc1b1575 | #686 | claude-fable-5 | 2 | 563 | 251732 | 349 | 914 | 0.2762 | 527 | 556275 | 42324674 | 273716 | feat(gateway): token-purity validation at the app publish gate (#686)Co-Authored |
| claude-code-ab8b1729-92f-1785606993-1 | claude-code | ab8b1729-92f0-445f-9f42-5a85fc1b1575 | #686 | claude-fable-5 | 110 | 72990 | 14552245 | 47541 | 120641 | 17.8428 | 637 | 629265 | 56876919 | 321257 | feat(design): conform DESIGN.md to the official spec and gate it with @google/de |
| claude-code-ab8b1729-92f-1785607061-1 | claude-code | ab8b1729-92f0-445f-9f42-5a85fc1b1575 | #686 | claude-fable-5 | 2 | 3680 | 281343 | 215 | 3897 | 0.3381 | 639 | 632945 | 57158262 | 321472 | feat(design): conform DESIGN.md to the official spec and gate it with @google/de |
| claude-code-ab8b1729-92f-1785607135-1 | claude-code | ab8b1729-92f0-445f-9f42-5a85fc1b1575 | #686 | claude-fable-5 | 4 | 802 | 570046 | 1060 | 1866 | 0.6331 | 643 | 633747 | 57728308 | 322532 | feat(design): conform DESIGN.md to the official spec and gate it with @google/de |
| claude-code-ab8b1729-92f-1785607352-1 | claude-code | ab8b1729-92f0-445f-9f42-5a85fc1b1575 | #686 | claude-opus-5 | 44 | 276280 | 6187703 | 14111 | 290435 | 5.1736 | 687 | 910027 | 63916011 | 336643 | docs(design): DESIGN.md becomes the single canonical design document (#686)Folds |
| claude-code-ab8b1729-92f-1785608039-1 | claude-code | ab8b1729-92f0-445f-9f42-5a85fc1b1575 | #686 | claude-opus-5 | 28 | 490654 | 3347224 | 8546 | 499228 | 4.9540 | 715 | 1400681 | 67263235 | 345189 | docs(design): sync receipt checklist with the issue's F-series items (#686)Co-Au |
| claude-code-ab8b1729-92f-1785608166-1 | claude-code | ab8b1729-92f0-445f-9f42-5a85fc1b1575 | #686 | claude-opus-5 | 2 | 839 | 276697 | 211 | 1052 | 0.1489 | 717 | 1401520 | 67539932 | 345400 | docs(design): sync receipt checklist with the issue's F-series items (#686)Co-Au |
| claude-code-ab8b1729-92f-1785609891-1 | claude-code | ab8b1729-92f0-445f-9f42-5a85fc1b1575 | #686 | claude-opus-5 | 98 | 40235 | 14289478 | 25612 | 65945 | 8.0370 | 815 | 1441755 | 81829410 | 371012 | fix(design): make the filled primary button clear WCAG AA on every accent (#686) |
| claude-code-ab8b1729-92f-1785611828-1 | claude-code | ab8b1729-92f0-445f-9f42-5a85fc1b1575 | #686 | claude-opus-5 | 96 | 49426 | 15565414 | 24896 | 74418 | 8.7145 | 911 | 1491181 | 97394824 | 395908 | test(design): pin the emitted values of spacing, motion, and theme roles (#686)C |
| claude-code-ab8b1729-92f-1785613809-1 | claude-code | ab8b1729-92f0-445f-9f42-5a85fc1b1575 | #686 | claude-opus-5 | 134 | 66913 | 24210121 | 43515 | 110562 | 13.6118 | 1045 | 1558094 | 121604945 | 439423 | fix(blueprints): ink accent-deep fills with text-inv, not the fixed white (#686) |
| claude-code-ab8b1729-92f-1785614133-1 | claude-code | ab8b1729-92f0-445f-9f42-5a85fc1b1575 | #686 | claude-opus-5 | 12 | 1923 | 2283435 | 1115 | 3050 | 1.1817 | 1057 | 1560017 | 123888380 | 440538 |  |
| claude-code-ab8b1729-92f-1785615471-1 | claude-code | ab8b1729-92f0-445f-9f42-5a85fc1b1575 | #686 | claude-opus-5 | 56 | 32737 | 10947447 | 25678 | 58471 | 6.3206 | 1113 | 1592754 | 134835827 | 466216 | test(blueprints): gate fallback-less var() references that resolve to nothing (# |
| claude-code-ab8b1729-92f-1785615525-1 | claude-code | ab8b1729-92f0-445f-9f42-5a85fc1b1575 | #686 | claude-opus-5 | 2 | 966 | 398589 | 234 | 1202 | 0.2112 | 1115 | 1593720 | 135234416 | 466450 | test(blueprints): gate fallback-less var() references that resolve to nothing (# |
| claude-code-ab8b1729-92f-1785615609-1 | claude-code | ab8b1729-92f0-445f-9f42-5a85fc1b1575 | #686 | claude-opus-5 | 2 | 845 | 399555 | 254 | 1101 | 0.2114 | 1117 | 1594565 | 135633971 | 466704 | test(blueprints): gate fallback-less var() references that resolve to nothing (# |
| claude-code-ab8b1729-92f-1785615967-1 | claude-code | ab8b1729-92f0-445f-9f42-5a85fc1b1575 | #686 | claude-opus-5 | 12 | 1739 | 2406625 | 1014 | 2765 | 1.2396 | 1129 | 1596304 | 138040596 | 467718 |  |
| claude-code-ab8b1729-92f-1785618533-1 | claude-code | ab8b1729-92f0-445f-9f42-5a85fc1b1575 | #686 | claude-opus-5 | 50 | 27001 | 10243373 | 20804 | 47855 | 5.8108 | 1179 | 1623305 | 148283969 | 488522 | fix(design): solve a text-legible rung per palette hue (#686)The burn-down repla |
| claude-code-ab8b1729-92f-1785621035-1 | claude-code | ab8b1729-92f0-445f-9f42-5a85fc1b1575 | #686 | claude-opus-5 | 62 | 40948 | 13244470 | 31428 | 72438 | 7.6642 | 1241 | 1664253 | 161528439 | 519950 | fix(design): solve the semantic state ramps against every surface (#686)--danger |
| claude-code-ab8b1729-92f-1785621082-1 | claude-code | ab8b1729-92f0-445f-9f42-5a85fc1b1575 | #686 | claude-opus-5 | 2 | 405 | 440805 | 202 | 609 | 0.2280 | 1243 | 1664658 | 161969244 | 520152 | fix(design): solve the semantic state ramps against every surface (#686)Co-Autho |
| claude-code-ab8b1729-92f-1785621203-1 | claude-code | ab8b1729-92f0-445f-9f42-5a85fc1b1575 | #686 | claude-opus-5 | 16 | 4187 | 3539750 | 2809 | 7012 | 1.8663 | 1259 | 1668845 | 165508994 | 522961 | fix(design): solve the semantic state ramps against every surface (#686)--danger |
| claude-code-ab8b1729-92f-1785621251-1 | claude-code | ab8b1729-92f0-445f-9f42-5a85fc1b1575 | #686 | claude-opus-5 | 2 | 636 | 444769 | 203 | 841 | 0.2314 | 1261 | 1669481 | 165953763 | 523164 | fix(design): solve the semantic state ramps against every surface (#686)Co-Autho |
| claude-code-ab8b1729-92f-1785621331-1 | claude-code | ab8b1729-92f0-445f-9f42-5a85fc1b1575 | #686 | claude-opus-5 | 8 | 3907 | 1782452 | 4586 | 8501 | 1.0303 | 1269 | 1673388 | 167736215 | 527750 | fix(design): solve the semantic state ramps against every surface (#686)--danger |
| claude-code-ab8b1729-92f-1785621454-1 | claude-code | ab8b1729-92f0-445f-9f42-5a85fc1b1575 | #686 | claude-opus-5 | 18 | 3985 | 4039188 | 2099 | 6102 | 2.0971 | 1287 | 1677373 | 171775403 | 529849 |  |
| claude-code-ab8b1729-92f-1785624677-1 | claude-code | ab8b1729-92f0-445f-9f42-5a85fc1b1575 | #686 | claude-opus-5 | 68 | 32575 | 15656804 | 21411 | 54054 | 8.5676 | 1355 | 1709948 | 187432207 | 551260 | fix(client): bind palette-hue text to the solved text rungs (#686)The shell pain |
| claude-code-ab8b1729-92f-1785627287-1 | claude-code | ab8b1729-92f0-445f-9f42-5a85fc1b1575 | #686 | claude-opus-5 | 48 | 28404 | 11502137 | 18202 | 46654 | 6.3839 | 1403 | 1738352 | 198934344 | 569462 | fix(client): resolve phantom token references the stale doc left behind (#686)-- |
| claude-code-ab8b1729-92f-1785629006-1 | claude-code | ab8b1729-92f0-445f-9f42-5a85fc1b1575 | #686 | claude-opus-5 | 44 | 18115 | 10873090 | 14431 | 32590 | 5.9108 | 1447 | 1756467 | 209807434 | 583893 | fix(blueprints): resolve the last twelve phantom var() references (#686)Every on |
| claude-code-ab8b1729-92f-1785630418-1 | claude-code | ab8b1729-92f0-445f-9f42-5a85fc1b1575 | #686 | claude-opus-5 | 44 | 23241 | 11170342 | 19784 | 43069 | 6.2252 | 1491 | 1779708 | 220977776 | 603677 | docs(design): record that the type scale is under-shaped, not under-adopted (#68 |
| claude-code-ab8b1729-92f-1785631778-1 | claude-code | ab8b1729-92f0-445f-9f42-5a85fc1b1575 | #686 | claude-opus-5 | 32 | 18546 | 8346342 | 12914 | 31492 | 4.6121 | 1523 | 1798254 | 229324118 | 616591 | feat(design): emit composable type size rungs and adopt the exact matches (#686) |

### Steering

No steering events recorded in this session. The user provided initial strategic direction and task scope in the first message; all subsequent messages were task confirmations or work directives with no interrupts or mid-task corrections to the agent's execution. Verdict: **PASS** — no steering events, no non-steering messages falsely recorded.

## Audit

**1. What changed faithfully describes staged diff:** **PASS** — The receipt's "## What changed" section accurately captures all A1+B1 deliverables: new `motion.ts`, spacing tokens emitted from `density.ts` in both `css.ts` and `blueprint.ts`, `--ease` added to shell contract, six client CSS modules cleaned of fallbacks, and mobile theme byte-identical regeneration.

**2. Checklist items [x] A1 and [x] B1 realized in staged diff:** **PASS** — A1 (spacing tokens `--sp-1…--sp-7` in both `SHELL_TOKEN_CONTRACT` and `BLUEPRINT_TOKEN_CONTRACT` via `contract.ts`, emitted in both `css.ts` and `blueprint.ts`) and B1 (shell motion `--ease` in `SHELL_TOKEN_CONTRACT`, added to `css.ts` emitter, six client modules updated) are both fully realized.

**3. Receipt checklist mirrors issue #686 checklist:** **PASS** — Receipt checklist A1–E items and their descriptions match issue #686 checklist structure exactly; only A1 and B1 are marked [x], remainder [ ] as scoped.
