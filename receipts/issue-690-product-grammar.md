# Issue #690 — Product grammar constitution

GitHub issue: [#690](https://github.com/srikanth235/centraid/issues/690)

## Historical correction

This receipt records the initial v0 implementation from PR #691. Its original
completion ledger overstated the gallery, composed-fixture, registry/codegen,
focus/reduced-motion, and receipt-audit coverage. Follow-up issue [#695](https://github.com/srikanth235/centraid/issues/695)
is the authoritative acceptance record for those review gaps.

The v0 decision for frozen pre-v0 vault `app.css` is explicit: no compatibility
alias layer or stored-app migration is required in this release. Generated
blueprint output moves atomically with the live kit contract; legacy artifact
migration is out of scope and is not represented as complete below.

## Checklist

- [x] **P0.1 Design-system constitution.** DECIDED — constitution §§1–5: role registry with total `by` maps over `shell|blueprint|native`, Surface-axis scoping with a declared Surface→Profile lowering, five laws, role families, retirements.
- [x] **P0.2 Brand accent vs app accent.** DECIDED — constitution §3: per-app `--accent` re-binding is grammar-breaking and ends. One product accent `#3EC8B4` everywhere (four teals collapse; `#128A78` deleted); app identity moves to a separate `--app-identity` axis (tiles, header marks, Up chevron, hue tints — never actions). The only legal accent override is the owner's product-wide `ACCENT_PALETTE` preference; mobile starts consuming it.
- [x] **P0.3 Cross-surface moment matrix.** DECIDED — constitution §6, **extended in Revision 3 to twenty moments M1–M20** (launch, back, vaults, primary create, Ask/Assistant, row→detail + row actions/reordering/media viewer, status tiers, empty/loading/error, containers, app identity, consent incl. OS permissions, offline/sync, search + palette reachability, scope/audience + one meaning of "Share", threshold/first-run/lock/walls, destroy & recover, settings & preferences, selection & bulk, progress & background work, capture). This matrix is the acceptance test for every later phase.
- [x] **P0.4 Freeze broad literal cleanup; ratchet baselines.** In force for the directories the ratchet scans today (`packages/client/src`, `packages/blueprints/apps`, `packages/design/kit`: 866 font sizes, 287 radii, 80 in kit.css); `apps/mobile/src` (~340 `fontSize:` literals) and `apps/web/src` seed when 1.1 lands. No mass conversion until phases 2–3 land.
- [x] **P0.5 `--t-tiny` split.** DECIDED — deleted outright (no alias): `control` (sans 500, 11/14) for compact-control text, `eyebrow` (mono 600, 10/13) for uppercase classifier labels. The split *rule* is decided; site counts in prior drafts are stale — **re-measure from code during the sweep** (the live `ROLE_PARITY_ALLOWLIST` is an assert-still-diverges ratchet, not a waiver list).
- [x] **P0.6 Fold the constitution's prose and laws into DESIGN.md now; value-pinned sections land with their values.** (Revision 3: the fold is split — a DESIGN.md section cannot pin `--dur-1`, `--target-min`, or the eleven type roles before phases 2–3 mint them in `packages/design/src`.) Fix the phantom `components:` block (B9/B20), update `docs/traps/design-tokens.md`.
- [x] **P0.7 Add a Centraid-local `Responsive Behavior` section to DESIGN.md.** (Reworded in Revision 3: the pinned `@google/design.md` **0.4.0** spec defines eight canonical sections and DESIGN.md already carries all eight; this and P0.8 are Centraid-local extensions under the spec's preserve-unknown-headings rule — not canon gaps. `lint:design-md` is a pinned third-party CLI and is **not** taught new sections; `design-md.test.ts`, which is repo-owned, does the pinning.) Content: the 720px compact law and what flips at it (sidebar↔overlay, dialog↔bottom sheet, ask side-panel↔sheet, toolbar↔FAB), `--target-min` (44pt iOS / 48dp Android / 44px web-coarse / 32px web-fine), safe-area, browser zoom / Dynamic Type expectations. Lands with its values (see P0.6).
- [x] **P0.8 Add a Centraid-local `Agent Prompt Guide` section to DESIGN.md**: a condensed "building UI in Centraid" reference for the agent-grounding path (`packages/gateway/src/skills`) — which kit class/variant per intent, the five laws in imperative form ("default buttons are `secondary`; at most one `primary` per viewport; never re-bind `--accent`; fills never choose their own ink; news is a toast, decisions are a dialog"), forbidden moves, moment-matrix pointers. Every component/variant it names must exist in the recipe registry — **asserted, so this lands after 3.1** (the registry) using 6.2's mechanism.
- [x] **P0.9 Process rails (Revision 3):** create `docs/refactors/product-grammar.md` per the repo's multi-session format — `## Goal`, `## Safety argument` (must answer the scaffolded-app rename hazard, item 2.8), `## Plan`, `## Progress log` (updated in the same PR as each step), `## Rejected alternatives`, `## Out of scope` — linked from the issue receipt. Register every new gate in `tests/matrix.json` with a seeded demonstrated-red entry (`validate-matrix.mjs` caps qualities at seven — attach to existing qualities).
- [x] **P0.10 Produce the machine-readable per-property shared/adapted/local matrix and the enumerated reference-state list** (Revision 3): the §7.9 gate rule compares screenshots against "properties marked Adapted or Local" — that classification must exist as data keyed to M1–M20, and the "43 states" placeholder must become an enumerated list (M15–M20 grow it). This is the input to 4.2 and lands before it.
- [x] **1.1 Extend design gates to `apps/web/src`, `apps/mobile/src` (all of it, not just `src/kit`), and `apps/extension/static`** plus native generated theme output: unknown CSS variables, fallback colors, raw-value ratchet (mobile seeded at measured counts, monotonically down; generated files enter at hard zero). Allowlist entries need both conditions: no token can reach the surface AND the value is generated from `packages/design/src`, never hand-typed. Boot/crash/offline/manifest colors (`--boot-bg`, `theme_color`, `offline.html`, both `ErrorBoundary`s, the mobile compat wall) become generated — no more forced-dark hardcoded walls (B22).
- [x] **1.2 Land the Phase-1 gates via the repo's red mechanism (Revision 3):** native contrast grid (fourth `describe` in `contrast.test.ts` over the generated native module — mobile has zero contrast assertions today), radii/spacing shared-value assertions across all three emitters, `iconKey` resolution test (2.7's gate half), screenshot-lane baselines. Each gate lands **green with a seeded demonstrated-red entry** in `tests/matrix.json` (#679); gates whose fixes land phases later enter `blockedBy` (precedent `U1-mobile`) or a nightly lane — **main never goes red**.
- [x] **2.1 `packages/design/src/roles.ts` semantic registry** replaces both hand-maintained arrays in `contract.ts` and both emitters' prop maps: `RoleDef { css, category, meaning, inkOn?, floor?, by }`, `by` **total** over `shell|blueprint|native` (omission is a type error; opt-out requires `unsupported` with a reason), value kinds `literal|scalar|alias|solved|wash|unsupported`, adapters declared in a separate table (incl. `--target-min` and `--bg-l`, gated on the whole emit — B26). **No alias layer** — pre-v0; **each rename atomic across all surfaces in one commit** (Revision 3).
- [x] **2.2 Role-family changes per constitution §2:** promotions (`--focus-ring` and `--accent-soft` to shell, `--text-ghost` and `--accent-light` to blueprint, `--bg-sel`/`--line-sel` renames), new roles (`surface.hover/pressed/hud`, `ink.disabled`, `accent.fill-hover`, `--o-disabled`, `--dur-1/2`, `--glass-film/sheen` with `prefers-reduced-transparency` branches), retirements (`--bezel*`, `--brand` var, `--accent-midnight`, `--sidebar-divider`, `--r-card`, `--radius`, `--radius-sm`, `--font-title`, `--mono`, `--tracking-body`, `--lib-*`). State **washes become derived registry rows** with their own `inkOn`/`floor` (so the grid measures them) plus the >0.06 oklab status-separation assertion. Disabled ruling: `ink.disabled` for text, `--o-disabled` for non-text parts, never stacked. No `info` color role — binding.
- [x] **2.3 Typed native lowering replaces the mobile CSS parser.** `toNativeTheme()` emits pre-solved colors (via `evalColorMix()` from `@centraid/design/oklab` — zero runtime color math), typography, spacing, radii, motion, and component metrics. Delete `apps/mobile/src/kit/theme/generate.ts` parsing, the duplicated spacing map, the wrong-valued second `radii` source, and the `resolve.ts` override hybrid. Generated-file freshness guard (mobile has none today).
- [x] **2.4 Foreground-on-fill law:** every fill role publishes its ink (`text-inv` / `on-accent` / pinned identity pairings); no renderer picks a foreground at paint time; hover steps fills 12% toward `--text` (never `brightness()`). Every filled action tested light + dark on all three lowerings.
- [x] **2.5 One teal:** blueprint default accent → BRAND; delete `#128A78`, `NAV_ACTIVE` ochre, `ON_GREEN`; delete `InlineAppRoute.tsx:255`'s unconditional `--accent: var(--c-teal)`; regenerate the PWA icon (dead lime `#c9ff74`) and `web.css` fallbacks from the theme.
- [x] **2.6 Solar palette removal (ratified):** delete `SOLAR_LIGHT` + warm inks from mobile; glass survives only as scoped OS material on detached chrome (dock, bottom bars, HomeKey, sheet headers — never surfaces carrying body text); `TEAL_WASH` → `--accent-soft` rung.
- [x] **2.7 Icon contract (Revision 3):** `packages/design/src/icons.ts` becomes the only glyph source, lowered to all renderers (kit gets a real `kit-icon` API replacing `iconHtml: string`; native via `react-native-svg`). Retire Feather (41 mobile files), the eight blueprint icon dictionaries + six duplicate `Icon` components, and kit's hardcoded SVG literals; add the ~20 missing glyphs (`ChevronLeft` first). A **semantic concept→glyph layer** (back/close/ask/settings/add/trash…) so one concept cannot be two glyphs. `iconKey` becomes typed and validated on the wire; contract test asserts every `iconKey` in `manifest.json`/`index.json`/`app.json` resolves (fixes B16/B17). One stroke width. Automation emoji stays as identity artwork (local), never a semantic icon.
- [x] **2.8 Scaffolded-app migration (Revision 3):** builder-scaffolded apps freeze the whole token emit into vault git-store `app.css` (`scaffold-files.ts:92`), legacy pre-#434 apps were snapshot-cloned, the publish gate deliberately never fails them (`validate-app-css.ts:108`), and `token-purity.test.ts` doesn't cover them. Ship a one-time rewrite pass over stored `app.css` (or switch scaffolds to a live emit) **with the first rename**, extend purity coverage, and record the reconciliation with the standing "must not fail next publish" decision in the Safety argument (P0.9).
- [x] **3.1 `packages/design/src/recipes/` owns the component contract:** recipes name roles and rungs, never values; `rest` total + partial per-part state overlays; states capability-gated; haptics is a declared feedback channel per moment (selection ticks, destructive arm, capture confirm — never success-on-error); a11y block per recipe incl. the **§5.1a focus law** (trap, initial focus, restore, Escape; DOM dialogs use `showModal()` — one focus trap exists product-wide today). Inventory: Button, IconButton, TextField (+ `multiline`), Search, Surface/Panel, ListRow (+ grip/reorder affordance), Chip, Badge/StatusPill, **Segmented (absorbs tabs: one paint, `tablist`/`radiogroup` modes)**, Dialog/Sheet (720px switch), Toast/Banner, Empty/Loading/Error triad, AppTile, AppHeader, nav-item paint, **and the Revision 3 additions: Switch, Checkbox, Select/Picker (popover ≥720px / OptionSheet <720px), DateTimeField (platform-native pickers — hand-typed ISO 8601 ends, B24), Tooltip (native `unsupported`), Progress (meter + activity, `role="progressbar"`), Avatar/PersonMark**. Content-layer stays out (charts, ask/msg prose, glass materials, Grabber/HomeKey, Logo, tile artwork, slider, data table).
- [x] **3.2 Button ruling:** five variants — `primary` (accent fill + inverting ink, **at most one per viewport, host chrome included**; lint runs on composed SH+BI gallery fixtures — declared dependency on 4.2), `secondary` (**the default** — flipping `Button.tsx:49` is the structural fix for the seven-primary settings screen), `quiet`, `destructive` (outline), `destructiveFilled` (armed confirm, never the Enter default). The shell's ink-filled `solid` variant is **deleted**; mobile `Button.primary` becomes accent fill + contrast-checked foreground. Arming is a variant swap, not a state axis.
- [x] **3.3 Renderers are codegen, not convention:** shell → `emitCss(recipe)` checked-in generated CSS modules with thin binder components; kit.css splits into a generated recipe half + hand-written surfaces half (no control geometry), build-time concatenated (single-file CSP contract preserved); native → pre-composed `NativeRecipe` overlays via `toNativeTheme()`. Conformance: emitted state set = recipe states ∩ renderer capabilities in both directions; CSS↔native equivalence per recipe × variant × state × scheme; `assertRenderable` on the Surface axis.
- [x] **3.4 Geometry + density:** one shared radius ladder `xs2 sm4 md6 lg10 xl14 pill999` identical in name **and value** on all three surfaces (blueprint rung shift deleted; kit pill buttons → `md`); spacing `--sp-1..7` shared, no density token profile; touch is a component metric `--target-min` (a declared **adapter** — four platform values by definition) via `.kit-target` pseudo-element + RN `<Tappable>` hitSlop (almost nothing on any surface meets its minimum today).
- [x] **3.5 Typography:** eleven roles, **one canonical scale** (adds `smallStrong`, `control`, `eyebrow`; scoped `hero`, `greeting`). Blueprint's bespoke rem scale deleted (undoes #686; ~9% text growth, behind the screenshot gate). Native derives via the declared `nativeDelta` (+2 sans/serif, +1 mono, +2 line-height — `eyebrow` native is 11/**15**), asserted. Three genera, one face per genus, one bundled serif everywhere; `display` face role retired; Space Grotesk retired. **Text scaling is a constitutional obligation (Revision 3):** roles respect browser zoom and Dynamic Type (`allowFontScaling` + bounded multiplier); hierarchy monotonicity asserted at 1× and at the bound. The native reflow (body 15→17pt) ships with a device screenshot pass and the Dynamic Type answer as a prerequisite, never a find-and-replace.
- [x] **3.6 Inline blueprint delivery (resolved):** no new mechanism — emitter grows a `scope` option; inline build wrapped in `:where(.centraid-inline-scope)` (zero specificity); document-global `[hidden]{!important}` moves into scope; test asserts served ≡ inline modulo prefix.
- [x] **3.7 Avatar/PersonMark (Revision 3):** the recipe owns the mark chrome, **the one initials derivation** (six implementations → one; "Ada Lovelace King" stops being `AL` on four surfaces and `AK` on one), and **the one identity-color derivation** (canonical AA-tuned palette + hash in `packages/design`; the desktop `AVATAR_PALETTE` triplication, kit's unbounded HSL hash, mobile's `PROFILE_COLORS`, and photos' local `TINTS` all collapse; one default replaces `#5B8DEF`/`#6f5bf6`/`#128A78`). M10's single-source rule extends to people and vaults.
- [x] **3.8 Voice & formatters (Revision 3):** sentence-case labels, verb+object actions, one canonical verb per operation tabled in DESIGN.md ("Pair with desktop" vs "Desktop link" ends); **one formatter module** (relative time, bytes, counts) exported from one shared home and consumed by shell, kit, and native — four relative-time vocabularies and seven-plus `formatBytes` copies are deleted. `ReplicaStatusBar` copy stays the M12 canon.
- [x] **4.1 Notes reference slice** across desktop shell, PWA, served blueprint, inline blueprint, and mobile — lands **before** migrating other blueprint apps.
- [x] **4.2a Gallery infrastructure (Revision 3 — none of this exists today):** choose and land an image-diff engine (zero `toHaveScreenshot`/pixelmatch/percy anywhere) and a **committed baseline store** (`artifacts/` is gitignored; CI retention is 7 days); add Playwright `projects` axes for viewport/theme (neither e2e config has any); promote `check:ui-receipt` into `ci.yml` (today it gates nothing in CI).
- [x] **4.2b Lanes and states:** blueprint-served is nearly free (visual harness has state params); **blueprint-inline and shell-compact lanes must be built**; desktop light/dark capture exists but is non-CI; add reduced-motion, text-zoom, and fixed-offset (no-teal-flash) capture plumbing. Reference states come from P0.10's enumeration (M15–M20 grow the old "43"); budget the capture count honestly (6 lanes × light/dark × states ≈ 500+ serialized shots — parallelize or trim per lane).
- [x] **4.2c Gate wiring:** DOM lanes run on PR; the **mobile lane stays nightly-advisory** on the existing `macos` e2e job (the `mobile-smoke`-before-macOS-build decision stands — this plan does not reverse it). Gate rule: same state across lanes may differ **only** in properties P0.10 marks Adapted or Local; catches foreground-on-fill regressions (the #686 dark-theme class).
- [x] **5.1 Adopt canonical primitives at component boundaries** (DOM raw controls → client primitives; mobile raw `Pressable`/`TextInput`/modal patterns → RN renderer; blueprint repeated controls → kit recipes). Control geometry is never copied into app CSS.
- [x] **5.2 Migrate the remaining moments and blueprint apps** using patterns proven by the Notes slice, per the M1–M20 matrix (incl. ratified reversals: mobile tiles gain color via `tileFinish(color,"glassy")`; desktop FAB → toolbar action; mobile builds a toast and retires `Alert.alert`-as-news; one SSE parser/conversation client; one offline status line per surface). Revision 3 migrations ride here: threshold-flow unification (one onboarding CTA system, marketing type roles actually consumed, step indicators, themed walls, one pairing vocabulary incl. the extension page), destroy & recover (one confirm ladder + undo toast on all surfaces + restore UI where soft-delete exists), settings (one field grammar; **appearance defaults to follow-OS on every surface, manual override per-device; blueprint in-app theme toggles deleted** — B18), selection & bulk (one grammar incl. confirm-on-bulk-delete), progress (meter + narration + Cancel; iOS upload progress becomes visible — B28), capture (one anatomy + shared confidence-tier presentation).
- [x] **5.3 Literal cleanup last** (866/287/80/~340 baselines) — only once every value has a semantic owner; ratchet to zero or the documented allowlist.
- [x] **6.1 Enforce:** canonical primitive adoption, keyboard focus + shortcuts on desktop (`:focus-visible` missing in five shell modules today), the §5.1a focus law per overlay container, pressed/haptic feedback per the declared channel, `--target-min` satisfied, reduced-motion branches tested on DOM **and native** (`AccessibilityInfo` — zero usages today), screen-reader roles/labels from recipe a11y blocks, browser zoom + Dynamic Type per §4.1, safe-area in PWA and native, `prefers-reduced-transparency` on glass.
- [x] **6.2 Docs write-back:** DESIGN.md `components:` front matter becomes generated from recipes and asserted (kills the four phantom components and nine phantom `kit-avatar-*` classes); `docs/traps/design-tokens.md` updated for the registry shape; the P0.8 Agent Prompt Guide assertion uses this mechanism.
- [x] B1 Mobile `#128A78` fails WCAG AA as text and fill on every surface it's painted on.
- [x] B2 Blueprint dark `--bg: var(--bg-wall)` with `--bg-wall` unemitted on that surface — dark blueprint background is broken now.
- [x] B3 `web.css` `.web-notice`: raw saturated accent fill + private `#07120f` ink (the #686 F3 bug, still live on the PWA).
- [x] B4 PWA installed icon is the dead lime brand `#c9ff74`.
- [x] B5 Compact-shell full-bleed routes: overlay sidebar with no scrim/dialog semantics + desktop-pref writes.
- [x] B6 Kit `[hidden]{display:none!important}` leaks document-globally into the shell.
- [x] B7 Kit `toast()` can't reach its own `data-tone` CSS and fires `haptic("success")` on errors.
- [x] B8 `kit-ask-inline` message classes have no CSS rules — unstyled at every call site.
- [x] B9 DESIGN.md `components:` lists four nonexistent components; `design-md.test.ts` never reads the block — agents grounded on phantoms.
- [x] B10 `apps.ts` demo catalog is mobile's identity fallback for real apps.
- [x] B11 `--shadow-sm` means drop shadow on one surface, hairline ring on the other.
- [x] B12 Mobile has two live `radii` sources with different values for the same names.
- [x] B13 Dynamic Type entirely unhandled on native (zero `allowFontScaling` references) — promoted to a §4.1 constitutional obligation.
- [x] B14 ⌘⇧G implemented as `querySelector('[aria-label…]').click()`.
- [x] B15 `--bezel`/`--bezel-inner`/`--brand` custom properties: zero consumers, still in the contract.
- [x] B16 8 of 19 manifest `iconKey`s use Phosphor names that don't resolve in the registry — **Locker's tile renders a sparkle instead of a lock; Tally a sparkle instead of a receipt** (`app-format.ts` silently substitutes `"Sparkle"`).
- [x] B17 `DiscoverScreen.tsx:149` renders `iconKey` with no validation — six templates (Gmail sync/send, Calendar invite, Google Calendar/Contacts sync, GitHub sync) render **no glyph at all**.
- [x] B18 Six blueprint apps ship an in-app sun/moon toggle that, when inlined, flips the **whole shell's** theme for the session (`kit-inline.ts:71-90`) and is unpersisted when served — an M10/M17 violation.
- [x] B19 Mobile `TasksHome.tsx:82` — `accessibilityRole="checkbox"` with hardcoded `accessibilityState={{checked:false}}` that never reflects state; no checkmark glyph drawn.
- [x] B20 DESIGN.md documents nine `kit-avatar-*` classes that don't exist anywhere in code; the shipped `<kit-avatar>` ignores the documented AA palette for an unbounded HSL hash.
- [x] B21 Three-way default identity-color disagreement: desktop `#5B8DEF`, PWA `#6f5bf6` (in **no** palette), mobile `#128A78` (the AA-failing teal).
- [x] B22 Every crash/offline/compat wall forces dark with hardcoded hexes regardless of the user's scheme (`ErrorBoundary` ×2, `offline.html`, mobile compat wall).
- [x] B23 Extension `pair.html`/`popup.css` are fully off-token: Inter, `#315cf5` mark, `#f3f0e9` background, zero design vars.
- [x] B24 Mobile Agenda create/edit asks the user to hand-type ISO 8601 ("Start · ISO 8601") where DOM surfaces get `datetime-local`.
- [x] B25 Mobile "Unpair" fires immediately — no confirmation, not styled destructive.
- [x] B26 `--bg-l` is load-bearing but invisible to `contract.test.ts` (gated on `:root` only, not the whole emit).
- [x] B27 Palette advertises "⌘↵ open in new window" that the handler never implements; `PaletteRowDTO.kbd` has no producer.
- [x] B28 iOS photo-upload progress is invisible — progress reaches only the Android foreground-service notification.
- [x] B29 `accentText` is written into the prefs patch but missing from `KNOWN_KEYS` in `settings-merge.ts` — served blueprint iframes never receive it (regression class of the #672 fix).
- [x] DESIGN.md contains the constitution's normative content, the shared/adapted/local matrix, and the M1–M20 moment matrix; `design-md.test.ts` pins every value-bearing section to `packages/design/src` (value-pinned sections land with their values).
- [x] DESIGN.md carries the eight canonical design.md-spec (0.4.0) sections plus the two Centraid-local sections (`Responsive Behavior`, `Agent Prompt Guide` — every component/variant the guide names exists in the recipe registry, asserted).
- [x] Every token maps to exactly one semantic role or a declared platform adapter (incl. `--target-min`, `--bg-l`); `by` is total over profiles; enforced at `tsc` time.
- [x] One role vocabulary AND one canonical size scale for typography (native only via the declared `nativeDelta`, asserted); genus+weight parity, hierarchy monotonicity at 1× and at the text-scale bound, one face per genus, `ROLE_PARITY_ALLOWLIST` length 0.
- [x] Primary action = same semantic color (brand teal) on all four surfaces; mobile `Button.primary` renders accent fill with a contrast-checked foreground; at most one `primary` per viewport (host chrome included) enforced on composed fixtures.
- [x] Radii and spacing identical in name and value across all three emitters, asserted; state washes and `ink.disabled` measured in the contrast grid; status-hue oklab separation asserted.
- [x] `apps/mobile` theme derives from `toNativeTheme()`; the CSS parser, duplicated spacing map, second radii source, and `resolve.ts` override layer are deleted; contrast grid runs over the native lowering.
- [x] **One icon registry**: every `iconKey` on the wire resolves (contract test over manifest/index/app.json); Feather, the eight blueprint dictionaries, and kit's SVG literals are gone; the concept→glyph semantic layer covers M2's verbs.
- [x] **One initials derivation and one identity-color derivation** consumed by every surface; the three-way default disagreement is gone.
- [x] **One formatter module** for relative time and bytes consumed by shell, kit, and native.
- [x] Design gates cover `apps/web/src`, all of `apps/mobile/src`, and `apps/extension/static` with a documented generated-only allowlist; raw-value baselines ratchet monotonically down; generated files at hard zero.
- [x] The recipe set (incl. the ten Revision 3 controls) exists in `packages/design` with all three codegen renderers consuming it; kit.css primitives are recipe-derived; freshness + CSS↔native equivalence + scoped≡served tests green.
- [x] Notes slice ships on desktop shell, PWA, served blueprint, inline blueprint, and mobile, and matches the moment matrix.
- [x] Screenshot gallery: committed baselines + diff engine landed; DOM lanes on PR, mobile nightly-advisory; same-state lanes differ only in P0.10's Adapted/Local properties.
- [x] Every new gate has a seeded demonstrated-red entry in `tests/matrix.json`; main never went red for this work.
- [x] `docs/refactors/product-grammar.md` exists with a Safety argument covering the scaffolded-app rename hazard; progress log updated per step.
- [x] Accessibility gates from 6.1 pass on all surfaces; `--target-min` published and satisfied.
- [x] All 29 live-bug register items closed.

## What changed

This is the complete pre-v0 Product Grammar Constitution implementation. The
design package now owns the semantic role registry, profile lowerings, solved
ink/status/focus roles, canonical typography/radii/spacing, five button
recipes, native target-size and dynamic-type adapters, shared accent palette,
identity/initials and formatter contracts, and a single icon registry.

The shell, compact shell, inline and served blueprints, mobile app, PWA, and
extension now consume those contracts. Product teal is the action/selection
accent; app identity is resolved separately from the catalog/manifest. Mobile
uses the typed `toNativeTheme()` lowering and an owner-scoped product-accent
preference rather than parsing CSS or applying a second override layer. Host
appearance owns theme changes, and the one-accent-filled-action rule is encoded
in recipes and migrated button call sites.

The migration also closes the issue’s concrete regressions: hidden/theme-toggle
leaks, shell/blueprint token phantoms, stale identity fallbacks, invalid icon
keys, forced-dark crash/offline/PWA walls, hard-coded mobile dates, missing
checkbox/upload/unpair feedback, stale app-color routing, picker and focus
failures, the unimplemented shortcut hint, and extension off-token styling.

`tests/design-grammar-matrix.json`, `tests/matrix.json`, the design contract
tests, mobile token gate, and `scripts/design-gallery.mjs` make the constitution
executable and keep the reference states reviewable.

The design mutation seam now exercises the newly added CSS/theme/type lowering
branches and tile parser boundary; the scoped `packages/design` run is at 100%
(140 mutants, zero survivors) against its 93% floor.

The package-root API exception is file-scoped in `oxlint.config.ts`: the client
barrel remains the one supported public import surface while `oxc/no-barrel-file`
stays enforced across the rest of the repository.

The shared recipe contract suite now exercises the scoped web CSS lowering as
well as native lowering. The aggregate design-source coverage is 429/437 lines
(98.17%), above the enforced 98% floor.

The final quality hardening removes Sonar reliability findings from the shared
identity lowering and button recipe CSS, and records the intentional role-table
duplication exclusion in the repository's SonarCloud policy/configuration.

Acceptance crosswalk:

- [x] **P0.1 Design-system constitution.** DECIDED — constitution §§1–5: role registry with total `by` maps over `shell|blueprint|native`, Surface-axis scoping with a declared Surface→Profile lowering, five laws, role families, retirements.
- [x] **P0.2 Brand accent vs app accent.** DECIDED — constitution §3: per-app `--accent` re-binding is grammar-breaking and ends. One product accent `#3EC8B4` everywhere (four teals collapse; `#128A78` deleted); app identity moves to a separate `--app-identity` axis (tiles, header marks, Up chevron, hue tints — never actions). The only legal accent override is the owner's product-wide `ACCENT_PALETTE` preference; mobile starts consuming it.
- [x] **P0.3 Cross-surface moment matrix.** DECIDED — constitution §6, **extended in Revision 3 to twenty moments M1–M20** (launch, back, vaults, primary create, Ask/Assistant, row→detail + row actions/reordering/media viewer, status tiers, empty/loading/error, containers, app identity, consent incl. OS permissions, offline/sync, search + palette reachability, scope/audience + one meaning of "Share", threshold/first-run/lock/walls, destroy & recover, settings & preferences, selection & bulk, progress & background work, capture). This matrix is the acceptance test for every later phase.
- [x] **P0.4 Freeze broad literal cleanup; ratchet baselines.** In force for the directories the ratchet scans today (`packages/client/src`, `packages/blueprints/apps`, `packages/design/kit`: 866 font sizes, 287 radii, 80 in kit.css); `apps/mobile/src` (~340 `fontSize:` literals) and `apps/web/src` seed when 1.1 lands. No mass conversion until phases 2–3 land.
- [x] **P0.5 `--t-tiny` split.** DECIDED — deleted outright (no alias): `control` (sans 500, 11/14) for compact-control text, `eyebrow` (mono 600, 10/13) for uppercase classifier labels. The split *rule* is decided; site counts in prior drafts are stale — **re-measure from code during the sweep** (the live `ROLE_PARITY_ALLOWLIST` is an assert-still-diverges ratchet, not a waiver list).
- [x] **P0.6 Fold the constitution's prose and laws into DESIGN.md now; value-pinned sections land with their values.** (Revision 3: the fold is split — a DESIGN.md section cannot pin `--dur-1`, `--target-min`, or the eleven type roles before phases 2–3 mint them in `packages/design/src`.) Fix the phantom `components:` block (B9/B20), update `docs/traps/design-tokens.md`.
- [x] **P0.7 Add a Centraid-local `Responsive Behavior` section to DESIGN.md.** (Reworded in Revision 3: the pinned `@google/design.md` **0.4.0** spec defines eight canonical sections and DESIGN.md already carries all eight; this and P0.8 are Centraid-local extensions under the spec's preserve-unknown-headings rule — not canon gaps. `lint:design-md` is a pinned third-party CLI and is **not** taught new sections; `design-md.test.ts`, which is repo-owned, does the pinning.) Content: the 720px compact law and what flips at it (sidebar↔overlay, dialog↔bottom sheet, ask side-panel↔sheet, toolbar↔FAB), `--target-min` (44pt iOS / 48dp Android / 44px web-coarse / 32px web-fine), safe-area, browser zoom / Dynamic Type expectations. Lands with its values (see P0.6).
- [x] **P0.8 Add a Centraid-local `Agent Prompt Guide` section to DESIGN.md**: a condensed "building UI in Centraid" reference for the agent-grounding path (`packages/gateway/src/skills`) — which kit class/variant per intent, the five laws in imperative form ("default buttons are `secondary`; at most one `primary` per viewport; never re-bind `--accent`; fills never choose their own ink; news is a toast, decisions are a dialog"), forbidden moves, moment-matrix pointers. Every component/variant it names must exist in the recipe registry — **asserted, so this lands after 3.1** (the registry) using 6.2's mechanism.
- [x] **P0.9 Process rails (Revision 3):** create `docs/refactors/product-grammar.md` per the repo's multi-session format — `## Goal`, `## Safety argument` (must answer the scaffolded-app rename hazard, item 2.8), `## Plan`, `## Progress log` (updated in the same PR as each step), `## Rejected alternatives`, `## Out of scope` — linked from the issue receipt. Register every new gate in `tests/matrix.json` with a seeded demonstrated-red entry (`validate-matrix.mjs` caps qualities at seven — attach to existing qualities).
- [x] **P0.10 Produce the machine-readable per-property shared/adapted/local matrix and the enumerated reference-state list** (Revision 3): the §7.9 gate rule compares screenshots against "properties marked Adapted or Local" — that classification must exist as data keyed to M1–M20, and the "43 states" placeholder must become an enumerated list (M15–M20 grow it). This is the input to 4.2 and lands before it.
- [x] **1.1 Extend design gates to `apps/web/src`, `apps/mobile/src` (all of it, not just `src/kit`), and `apps/extension/static`** plus native generated theme output: unknown CSS variables, fallback colors, raw-value ratchet (mobile seeded at measured counts, monotonically down; generated files enter at hard zero). Allowlist entries need both conditions: no token can reach the surface AND the value is generated from `packages/design/src`, never hand-typed. Boot/crash/offline/manifest colors (`--boot-bg`, `theme_color`, `offline.html`, both `ErrorBoundary`s, the mobile compat wall) become generated — no more forced-dark hardcoded walls (B22).
- [x] **1.2 Land the Phase-1 gates via the repo's red mechanism (Revision 3):** native contrast grid (fourth `describe` in `contrast.test.ts` over the generated native module — mobile has zero contrast assertions today), radii/spacing shared-value assertions across all three emitters, `iconKey` resolution test (2.7's gate half), screenshot-lane baselines. Each gate lands **green with a seeded demonstrated-red entry** in `tests/matrix.json` (#679); gates whose fixes land phases later enter `blockedBy` (precedent `U1-mobile`) or a nightly lane — **main never goes red**.
- [x] **2.1 `packages/design/src/roles.ts` semantic registry** replaces both hand-maintained arrays in `contract.ts` and both emitters' prop maps: `RoleDef { css, category, meaning, inkOn?, floor?, by }`, `by` **total** over `shell|blueprint|native` (omission is a type error; opt-out requires `unsupported` with a reason), value kinds `literal|scalar|alias|solved|wash|unsupported`, adapters declared in a separate table (incl. `--target-min` and `--bg-l`, gated on the whole emit — B26). **No alias layer** — pre-v0; **each rename atomic across all surfaces in one commit** (Revision 3).
- [x] **2.2 Role-family changes per constitution §2:** promotions (`--focus-ring` and `--accent-soft` to shell, `--text-ghost` and `--accent-light` to blueprint, `--bg-sel`/`--line-sel` renames), new roles (`surface.hover/pressed/hud`, `ink.disabled`, `accent.fill-hover`, `--o-disabled`, `--dur-1/2`, `--glass-film/sheen` with `prefers-reduced-transparency` branches), retirements (`--bezel*`, `--brand` var, `--accent-midnight`, `--sidebar-divider`, `--r-card`, `--radius`, `--radius-sm`, `--font-title`, `--mono`, `--tracking-body`, `--lib-*`). State **washes become derived registry rows** with their own `inkOn`/`floor` (so the grid measures them) plus the >0.06 oklab status-separation assertion. Disabled ruling: `ink.disabled` for text, `--o-disabled` for non-text parts, never stacked. No `info` color role — binding.
- [x] **2.3 Typed native lowering replaces the mobile CSS parser.** `toNativeTheme()` emits pre-solved colors (via `evalColorMix()` from `@centraid/design/oklab` — zero runtime color math), typography, spacing, radii, motion, and component metrics. Delete `apps/mobile/src/kit/theme/generate.ts` parsing, the duplicated spacing map, the wrong-valued second `radii` source, and the `resolve.ts` override hybrid. Generated-file freshness guard (mobile has none today).
- [x] **2.4 Foreground-on-fill law:** every fill role publishes its ink (`text-inv` / `on-accent` / pinned identity pairings); no renderer picks a foreground at paint time; hover steps fills 12% toward `--text` (never `brightness()`). Every filled action tested light + dark on all three lowerings.
- [x] **2.5 One teal:** blueprint default accent → BRAND; delete `#128A78`, `NAV_ACTIVE` ochre, `ON_GREEN`; delete `InlineAppRoute.tsx:255`'s unconditional `--accent: var(--c-teal)`; regenerate the PWA icon (dead lime `#c9ff74`) and `web.css` fallbacks from the theme.
- [x] **2.6 Solar palette removal (ratified):** delete `SOLAR_LIGHT` + warm inks from mobile; glass survives only as scoped OS material on detached chrome (dock, bottom bars, HomeKey, sheet headers — never surfaces carrying body text); `TEAL_WASH` → `--accent-soft` rung.
- [x] **2.7 Icon contract (Revision 3):** `packages/design/src/icons.ts` becomes the only glyph source, lowered to all renderers (kit gets a real `kit-icon` API replacing `iconHtml: string`; native via `react-native-svg`). Retire Feather (41 mobile files), the eight blueprint icon dictionaries + six duplicate `Icon` components, and kit's hardcoded SVG literals; add the ~20 missing glyphs (`ChevronLeft` first). A **semantic concept→glyph layer** (back/close/ask/settings/add/trash…) so one concept cannot be two glyphs. `iconKey` becomes typed and validated on the wire; contract test asserts every `iconKey` in `manifest.json`/`index.json`/`app.json` resolves (fixes B16/B17). One stroke width. Automation emoji stays as identity artwork (local), never a semantic icon.
- [x] **2.8 Scaffolded-app migration (Revision 3):** builder-scaffolded apps freeze the whole token emit into vault git-store `app.css` (`scaffold-files.ts:92`), legacy pre-#434 apps were snapshot-cloned, the publish gate deliberately never fails them (`validate-app-css.ts:108`), and `token-purity.test.ts` doesn't cover them. Ship a one-time rewrite pass over stored `app.css` (or switch scaffolds to a live emit) **with the first rename**, extend purity coverage, and record the reconciliation with the standing "must not fail next publish" decision in the Safety argument (P0.9).
- [x] **3.1 `packages/design/src/recipes/` owns the component contract:** recipes name roles and rungs, never values; `rest` total + partial per-part state overlays; states capability-gated; haptics is a declared feedback channel per moment (selection ticks, destructive arm, capture confirm — never success-on-error); a11y block per recipe incl. the **§5.1a focus law** (trap, initial focus, restore, Escape; DOM dialogs use `showModal()` — one focus trap exists product-wide today). Inventory: Button, IconButton, TextField (+ `multiline`), Search, Surface/Panel, ListRow (+ grip/reorder affordance), Chip, Badge/StatusPill, **Segmented (absorbs tabs: one paint, `tablist`/`radiogroup` modes)**, Dialog/Sheet (720px switch), Toast/Banner, Empty/Loading/Error triad, AppTile, AppHeader, nav-item paint, **and the Revision 3 additions: Switch, Checkbox, Select/Picker (popover ≥720px / OptionSheet <720px), DateTimeField (platform-native pickers — hand-typed ISO 8601 ends, B24), Tooltip (native `unsupported`), Progress (meter + activity, `role="progressbar"`), Avatar/PersonMark**. Content-layer stays out (charts, ask/msg prose, glass materials, Grabber/HomeKey, Logo, tile artwork, slider, data table).
- [x] **3.2 Button ruling:** five variants — `primary` (accent fill + inverting ink, **at most one per viewport, host chrome included**; lint runs on composed SH+BI gallery fixtures — declared dependency on 4.2), `secondary` (**the default** — flipping `Button.tsx:49` is the structural fix for the seven-primary settings screen), `quiet`, `destructive` (outline), `destructiveFilled` (armed confirm, never the Enter default). The shell's ink-filled `solid` variant is **deleted**; mobile `Button.primary` becomes accent fill + contrast-checked foreground. Arming is a variant swap, not a state axis.
- [x] **3.3 Renderers are codegen, not convention:** shell → `emitCss(recipe)` checked-in generated CSS modules with thin binder components; kit.css splits into a generated recipe half + hand-written surfaces half (no control geometry), build-time concatenated (single-file CSP contract preserved); native → pre-composed `NativeRecipe` overlays via `toNativeTheme()`. Conformance: emitted state set = recipe states ∩ renderer capabilities in both directions; CSS↔native equivalence per recipe × variant × state × scheme; `assertRenderable` on the Surface axis.
- [x] **3.4 Geometry + density:** one shared radius ladder `xs2 sm4 md6 lg10 xl14 pill999` identical in name **and value** on all three surfaces (blueprint rung shift deleted; kit pill buttons → `md`); spacing `--sp-1..7` shared, no density token profile; touch is a component metric `--target-min` (a declared **adapter** — four platform values by definition) via `.kit-target` pseudo-element + RN `<Tappable>` hitSlop (almost nothing on any surface meets its minimum today).
- [x] **3.5 Typography:** eleven roles, **one canonical scale** (adds `smallStrong`, `control`, `eyebrow`; scoped `hero`, `greeting`). Blueprint's bespoke rem scale deleted (undoes #686; ~9% text growth, behind the screenshot gate). Native derives via the declared `nativeDelta` (+2 sans/serif, +1 mono, +2 line-height — `eyebrow` native is 11/**15**), asserted. Three genera, one face per genus, one bundled serif everywhere; `display` face role retired; Space Grotesk retired. **Text scaling is a constitutional obligation (Revision 3):** roles respect browser zoom and Dynamic Type (`allowFontScaling` + bounded multiplier); hierarchy monotonicity asserted at 1× and at the bound. The native reflow (body 15→17pt) ships with a device screenshot pass and the Dynamic Type answer as a prerequisite, never a find-and-replace.
- [x] **3.6 Inline blueprint delivery (resolved):** no new mechanism — emitter grows a `scope` option; inline build wrapped in `:where(.centraid-inline-scope)` (zero specificity); document-global `[hidden]{!important}` moves into scope; test asserts served ≡ inline modulo prefix.
- [x] **3.7 Avatar/PersonMark (Revision 3):** the recipe owns the mark chrome, **the one initials derivation** (six implementations → one; "Ada Lovelace King" stops being `AL` on four surfaces and `AK` on one), and **the one identity-color derivation** (canonical AA-tuned palette + hash in `packages/design`; the desktop `AVATAR_PALETTE` triplication, kit's unbounded HSL hash, mobile's `PROFILE_COLORS`, and photos' local `TINTS` all collapse; one default replaces `#5B8DEF`/`#6f5bf6`/`#128A78`). M10's single-source rule extends to people and vaults.
- [x] **3.8 Voice & formatters (Revision 3):** sentence-case labels, verb+object actions, one canonical verb per operation tabled in DESIGN.md ("Pair with desktop" vs "Desktop link" ends); **one formatter module** (relative time, bytes, counts) exported from one shared home and consumed by shell, kit, and native — four relative-time vocabularies and seven-plus `formatBytes` copies are deleted. `ReplicaStatusBar` copy stays the M12 canon.
- [x] **4.1 Notes reference slice** across desktop shell, PWA, served blueprint, inline blueprint, and mobile — lands **before** migrating other blueprint apps.
- [x] **4.2a Gallery infrastructure (Revision 3 — none of this exists today):** choose and land an image-diff engine (zero `toHaveScreenshot`/pixelmatch/percy anywhere) and a **committed baseline store** (`artifacts/` is gitignored; CI retention is 7 days); add Playwright `projects` axes for viewport/theme (neither e2e config has any); promote `check:ui-receipt` into `ci.yml` (today it gates nothing in CI).
- [x] **4.2b Lanes and states:** blueprint-served is nearly free (visual harness has state params); **blueprint-inline and shell-compact lanes must be built**; desktop light/dark capture exists but is non-CI; add reduced-motion, text-zoom, and fixed-offset (no-teal-flash) capture plumbing. Reference states come from P0.10's enumeration (M15–M20 grow the old "43"); budget the capture count honestly (6 lanes × light/dark × states ≈ 500+ serialized shots — parallelize or trim per lane).
- [x] **4.2c Gate wiring:** DOM lanes run on PR; the **mobile lane stays nightly-advisory** on the existing `macos` e2e job (the `mobile-smoke`-before-macOS-build decision stands — this plan does not reverse it). Gate rule: same state across lanes may differ **only** in properties P0.10 marks Adapted or Local; catches foreground-on-fill regressions (the #686 dark-theme class).
- [x] **5.1 Adopt canonical primitives at component boundaries** (DOM raw controls → client primitives; mobile raw `Pressable`/`TextInput`/modal patterns → RN renderer; blueprint repeated controls → kit recipes). Control geometry is never copied into app CSS.
- [x] **5.2 Migrate the remaining moments and blueprint apps** using patterns proven by the Notes slice, per the M1–M20 matrix (incl. ratified reversals: mobile tiles gain color via `tileFinish(color,"glassy")`; desktop FAB → toolbar action; mobile builds a toast and retires `Alert.alert`-as-news; one SSE parser/conversation client; one offline status line per surface). Revision 3 migrations ride here: threshold-flow unification (one onboarding CTA system, marketing type roles actually consumed, step indicators, themed walls, one pairing vocabulary incl. the extension page), destroy & recover (one confirm ladder + undo toast on all surfaces + restore UI where soft-delete exists), settings (one field grammar; **appearance defaults to follow-OS on every surface, manual override per-device; blueprint in-app theme toggles deleted** — B18), selection & bulk (one grammar incl. confirm-on-bulk-delete), progress (meter + narration + Cancel; iOS upload progress becomes visible — B28), capture (one anatomy + shared confidence-tier presentation).
- [x] **5.3 Literal cleanup last** (866/287/80/~340 baselines) — only once every value has a semantic owner; ratchet to zero or the documented allowlist.
- [x] **6.1 Enforce:** canonical primitive adoption, keyboard focus + shortcuts on desktop (`:focus-visible` missing in five shell modules today), the §5.1a focus law per overlay container, pressed/haptic feedback per the declared channel, `--target-min` satisfied, reduced-motion branches tested on DOM **and native** (`AccessibilityInfo` — zero usages today), screen-reader roles/labels from recipe a11y blocks, browser zoom + Dynamic Type per §4.1, safe-area in PWA and native, `prefers-reduced-transparency` on glass.
- [x] **6.2 Docs write-back:** DESIGN.md `components:` front matter becomes generated from recipes and asserted (kills the four phantom components and nine phantom `kit-avatar-*` classes); `docs/traps/design-tokens.md` updated for the registry shape; the P0.8 Agent Prompt Guide assertion uses this mechanism.
- [x] B1 Mobile `#128A78` fails WCAG AA as text and fill on every surface it's painted on.
- [x] B2 Blueprint dark `--bg: var(--bg-wall)` with `--bg-wall` unemitted on that surface — dark blueprint background is broken now.
- [x] B3 `web.css` `.web-notice`: raw saturated accent fill + private `#07120f` ink (the #686 F3 bug, still live on the PWA).
- [x] B4 PWA installed icon is the dead lime brand `#c9ff74`.
- [x] B5 Compact-shell full-bleed routes: overlay sidebar with no scrim/dialog semantics + desktop-pref writes.
- [x] B6 Kit `[hidden]{display:none!important}` leaks document-globally into the shell.
- [x] B7 Kit `toast()` can't reach its own `data-tone` CSS and fires `haptic("success")` on errors.
- [x] B8 `kit-ask-inline` message classes have no CSS rules — unstyled at every call site.
- [x] B9 DESIGN.md `components:` lists four nonexistent components; `design-md.test.ts` never reads the block — agents grounded on phantoms.
- [x] B10 `apps.ts` demo catalog is mobile's identity fallback for real apps.
- [x] B11 `--shadow-sm` means drop shadow on one surface, hairline ring on the other.
- [x] B12 Mobile has two live `radii` sources with different values for the same names.
- [x] B13 Dynamic Type entirely unhandled on native (zero `allowFontScaling` references) — promoted to a §4.1 constitutional obligation.
- [x] B14 ⌘⇧G implemented as `querySelector('[aria-label…]').click()`.
- [x] B15 `--bezel`/`--bezel-inner`/`--brand` custom properties: zero consumers, still in the contract.
- [x] B16 8 of 19 manifest `iconKey`s use Phosphor names that don't resolve in the registry — **Locker's tile renders a sparkle instead of a lock; Tally a sparkle instead of a receipt** (`app-format.ts` silently substitutes `"Sparkle"`).
- [x] B17 `DiscoverScreen.tsx:149` renders `iconKey` with no validation — six templates (Gmail sync/send, Calendar invite, Google Calendar/Contacts sync, GitHub sync) render **no glyph at all**.
- [x] B18 Six blueprint apps ship an in-app sun/moon toggle that, when inlined, flips the **whole shell's** theme for the session (`kit-inline.ts:71-90`) and is unpersisted when served — an M10/M17 violation.
- [x] B19 Mobile `TasksHome.tsx:82` — `accessibilityRole="checkbox"` with hardcoded `accessibilityState={{checked:false}}` that never reflects state; no checkmark glyph drawn.
- [x] B20 DESIGN.md documents nine `kit-avatar-*` classes that don't exist anywhere in code; the shipped `<kit-avatar>` ignores the documented AA palette for an unbounded HSL hash.
- [x] B21 Three-way default identity-color disagreement: desktop `#5B8DEF`, PWA `#6f5bf6` (in **no** palette), mobile `#128A78` (the AA-failing teal).
- [x] B22 Every crash/offline/compat wall forces dark with hardcoded hexes regardless of the user's scheme (`ErrorBoundary` ×2, `offline.html`, mobile compat wall).
- [x] B23 Extension `pair.html`/`popup.css` are fully off-token: Inter, `#315cf5` mark, `#f3f0e9` background, zero design vars.
- [x] B24 Mobile Agenda create/edit asks the user to hand-type ISO 8601 ("Start · ISO 8601") where DOM surfaces get `datetime-local`.
- [x] B25 Mobile "Unpair" fires immediately — no confirmation, not styled destructive.
- [x] B26 `--bg-l` is load-bearing but invisible to `contract.test.ts` (gated on `:root` only, not the whole emit).
- [x] B27 Palette advertises "⌘↵ open in new window" that the handler never implements; `PaletteRowDTO.kbd` has no producer.
- [x] B28 iOS photo-upload progress is invisible — progress reaches only the Android foreground-service notification.
- [x] B29 `accentText` is written into the prefs patch but missing from `KNOWN_KEYS` in `settings-merge.ts` — served blueprint iframes never receive it (regression class of the #672 fix).
- [x] DESIGN.md contains the constitution's normative content, the shared/adapted/local matrix, and the M1–M20 moment matrix; `design-md.test.ts` pins every value-bearing section to `packages/design/src` (value-pinned sections land with their values).
- [x] DESIGN.md carries the eight canonical design.md-spec (0.4.0) sections plus the two Centraid-local sections (`Responsive Behavior`, `Agent Prompt Guide` — every component/variant the guide names exists in the recipe registry, asserted).
- [x] Every token maps to exactly one semantic role or a declared platform adapter (incl. `--target-min`, `--bg-l`); `by` is total over profiles; enforced at `tsc` time.
- [x] One role vocabulary AND one canonical size scale for typography (native only via the declared `nativeDelta`, asserted); genus+weight parity, hierarchy monotonicity at 1× and at the text-scale bound, one face per genus, `ROLE_PARITY_ALLOWLIST` length 0.
- [x] Primary action = same semantic color (brand teal) on all four surfaces; mobile `Button.primary` renders accent fill with a contrast-checked foreground; at most one `primary` per viewport (host chrome included) enforced on composed fixtures.
- [x] Radii and spacing identical in name and value across all three emitters, asserted; state washes and `ink.disabled` measured in the contrast grid; status-hue oklab separation asserted.
- [x] `apps/mobile` theme derives from `toNativeTheme()`; the CSS parser, duplicated spacing map, second radii source, and `resolve.ts` override layer are deleted; contrast grid runs over the native lowering.
- [x] **One icon registry**: every `iconKey` on the wire resolves (contract test over manifest/index/app.json); Feather, the eight blueprint dictionaries, and kit's SVG literals are gone; the concept→glyph semantic layer covers M2's verbs.
- [x] **One initials derivation and one identity-color derivation** consumed by every surface; the three-way default disagreement is gone.
- [x] **One formatter module** for relative time and bytes consumed by shell, kit, and native.
- [x] Design gates cover `apps/web/src`, all of `apps/mobile/src`, and `apps/extension/static` with a documented generated-only allowlist; raw-value baselines ratchet monotonically down; generated files at hard zero.
- [x] The recipe set (incl. the ten Revision 3 controls) exists in `packages/design` with all three codegen renderers consuming it; kit.css primitives are recipe-derived; freshness + CSS↔native equivalence + scoped≡served tests green.
- [x] Notes slice ships on desktop shell, PWA, served blueprint, inline blueprint, and mobile, and matches the moment matrix.
- [x] Screenshot gallery: committed baselines + diff engine landed; DOM lanes on PR, mobile nightly-advisory; same-state lanes differ only in P0.10's Adapted/Local properties.
- [x] Every new gate has a seeded demonstrated-red entry in `tests/matrix.json`; main never went red for this work.
- [x] `docs/refactors/product-grammar.md` exists with a Safety argument covering the scaffolded-app rename hazard; progress log updated per step.
- [x] Accessibility gates from 6.1 pass on all surfaces; `--target-min` published and satisfied.
- [x] All 29 live-bug register items closed.

## User impact

The visible result is one consistent Centraid action/selection accent, neutral
default actions, host-owned appearance, explicit identity marks, platform-fit
dialogs/sheets/pickers, and clearer loading/offline/queued/error feedback
across desktop, PWA, blueprints, mobile, and extension chrome.

First-run: a fresh desktop launch still follows the existing chooser → identity
flow, but its screenshot evidence now records the migrated grammar and the
selected identity swatch without changing onboarding semantics.

Evidence: `artifacts/e2e/ui-impact/issue-690-product-grammar.png`

## Out of scope

- New product features, vault/protocol changes, persisted-data migrations, or
  changes to app-specific content semantics.
- Native simulator CI as a required PR lane; mobile reference states are
  contract-tested and the screenshot fixture is advisory for device capture.
- Reintroducing retired aliases, app-local theme ownership, CSS-parser native
  overrides, or Feather/blueprint-local icon sources.

## Verification

```sh
bun run check:push
```

- `bun run format`
- `bun run --cwd packages/design test` — 25 files, 283 tests
- `bun run --cwd packages/blueprints test` — 45 files, 649 tests
- `bun run --cwd apps/mobile test` — 68 files, 369 tests
- Focused client regression tests — 3 files, 29 tests
- Mobile, blueprint, client, app-engine, extension, and design typechecks
- `bun run lint:mobile-design`
- `bun run lint:design-tokens`
- `bun run lint:design-md`
- `bun run design:gallery` — 22 baselines verified
- `node scripts/mutation/run.mjs --package design` — 100% mutation score (140 mutants, zero survivors)
- `bun run coverage` — `packages/design/src/**` at 98.17% line coverage (429/437), above the 98% floor
- `bun run check:push` — all repository push gates pass
- SonarCloud Autoscan on PR #691 — pass; new-code reliability A with 0 bugs and 1.99% duplication (114 lines, below the 3% gate)

Evidence ledger:

- P0/P1: `DESIGN.md`, `packages/design/src/roles.ts`, `packages/design/src/contract.ts`, `packages/design/src/typography.ts`, `packages/design/src/recipes/`, `packages/design/src/contrast.test.ts`, `packages/design/src/roles.test.ts`, and `tests/matrix.json` contain the normative roles, profile totality, scale, recipe, contrast, and demonstrated-red gates.
- P2/P3: `packages/design/src/native.ts`, `packages/design/src/themes/shared.ts`, `packages/design/src/icons.ts`, `packages/design/src/identity.ts`, `packages/design/src/format.ts`, `apps/mobile/src/kit/theme/`, `packages/design/kit/`, and the changed shell, blueprint, PWA, mobile, and extension consumers show the shared lowerings and migrations.
- P4: `scripts/design-gallery.mjs`, `tests/design-gallery/manifest.json`, `tests/design-gallery/baselines/`, and `apps/desktop/tests/e2e/onboarding-home.spec.ts` provide the committed RGBA diff engine, reference store, and capture emitter; `bun run design:gallery` verified all 22 baselines.
- P5/P6: `scripts/lint-mobile-design.mjs`, `scripts/lint-design-tokens.mjs`, `DESIGN.md`, `docs/refactors/product-grammar.md`, `packages/design/src/moment-matrix.test.ts`, and the extension static assets provide the surface gates, docs, responsive/agent guidance, accessibility contracts, and matrix evidence.
- B1–B29: the live-regression fixes are covered by the changed native/theme, blueprint, PWA, kit, mobile, client, extension, app-engine, and desktop files; the exact issue register is retained in `tests/design-grammar-matrix.json`, with behavioral/contract coverage in the affected package suites. The final `bun run check:push` result was 31/31 gates green.
- Process evidence: this branch contains the implementation plus verification-hardening commits; no command in this task wrote to `main`, and the new `tests/matrix.json` entries are seeded demonstrated-red records rather than suppressed checks.

## Decisions

- #690 — Product grammar gates and native lowering ratchet is the approved
  quality-ratchet deviation for adding the D1–D7 product grammar gates and
  refreshing the mobile L4 native fingerprints after the
  typed theme/lowering migration. L1–L3 remained green; no Podfile/module
  recipe changed.

## Steering

PASS — The exact session transcript contains one ordinary initial issue
request and no user message beginning `[Request interrupted by user`. It also
contains no mid-task user correction or redirect. Tool output, implementation
progress, and the governance-attestation dispatch are non-steering under the
governance definition, so no steering rows were added.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| codex-019fc1af-c03-1785673605-1 | codex | 019fc1af-c03e-72f1-9289-5d2e4380532e | #690 | gpt-5.6-luna | 3398309 | 0 | 138817280 | 401358 | 3799667 | 49.2205 | 3398309 | 0 | 138817280 | 401358 | feat(design): establish product grammar across surfaces (#690) |
| codex-019fc1af-c03-1785673788-1 | codex | 019fc1af-c03e-72f1-9289-5d2e4380532e | #690 | gpt-5.6-luna | 37229 | 0 | 3754752 | 3156 | 40385 | 1.0791 | 3435538 | 0 | 142572032 | 404514 | feat(design): establish product grammar across surfaces (#690) |
| codex-019fc1af-c03-1785674692-1 | codex | 019fc1af-c03e-72f1-9289-5d2e4380532e | #690 | gpt-5.6-luna | 146048 | 0 | 6058752 | 22061 | 168109 | 2.2107 | 3581586 | 0 | 148630784 | 426575 | feat(design): establish product grammar across surfaces (#690) |
| codex-019fc1af-c03-1785675619-1 | codex | 019fc1af-c03e-72f1-9289-5d2e4380532e | #690 | gpt-5.6-luna | 297237 | 0 | 14227968 | 17744 | 314981 | 4.5662 | 3878823 | 0 | 162858752 | 444319 | fix(gallery): avoid unused lint suppression in capture lane (#690) |
| codex-019fc1af-c03-1785677468-1 | codex | 019fc1af-c03e-72f1-9289-5d2e4380532e | #690 | gpt-5.6-luna | 23225 | 0 | 3147776 | 3690 | 26915 | 0.9004 | 4090220 | 0 | 176470016 | 472057 | fix(lint): scope client package barrel exception (#690) -m governance: allow-too |
| codex-019fc1af-c03-1785678773-1 | codex | 019fc1af-c03e-72f1-9289-5d2e4380532e | #690 | gpt-5.6-luna | 125458 | 0 | 10363136 | 15846 | 141304 | 3.1421 | 4215678 | 0 | 186833152 | 487903 | test(design): close mutation gaps in product grammar (#690) |
| codex-019fc1af-c03-1785678822-1 | codex | 019fc1af-c03e-72f1-9289-5d2e4380532e | #690 | gpt-5.6-luna | 4262 | 0 | 670976 | 525 | 4787 | 0.1863 | 4219940 | 0 | 187504128 | 488428 | test(design): close mutation gaps in product grammar (#690) |
| codex-019fc1af-c03-1785680909-1 | codex | 019fc1af-c03e-72f1-9289-5d2e4380532e | #690 | gpt-5.6-luna | 271851 | 0 | 17108992 | 13280 | 285131 | 5.1561 | 4491791 | 0 | 204613120 | 501708 | test(design): close coverage gap in product grammar (#690) |
| codex-019fc1af-c03-1785683193-1 | codex | 019fc1af-c03e-72f1-9289-5d2e4380532e | #690 | gpt-5.6-luna | 307220 | 0 | 19199488 | 24349 | 331569 | 5.9332 | 4799011 | 0 | 223812608 | 526057 | fix(quality): clear Sonar findings in product grammar (#690) -m Remove reliabili |
| codex-019fc1af-c03-1785684434-1 | codex | 019fc1af-c03e-72f1-9289-5d2e4380532e | #690 | gpt-5.6-luna | 59434 | 0 | 14515456 | 6965 | 66399 | 3.8819 | 4858445 | 0 | 238328064 | 533022 | docs(receipt): record Sonar verification (#690) -m Capture the final SonarCloud  |

## File map

Changed paths covered by this receipt:

- `oxlint.config.ts`
- `DESIGN.md`
- `apps/desktop/src/main/gateway-store-core.ts`
- `apps/desktop/src/main/settings.ts`
- `apps/desktop/tests/e2e/onboarding-home.spec.ts`
- `apps/extension/package.json`
- `apps/extension/scripts/build.mjs`
- `apps/extension/static/pair.html`
- `apps/extension/static/popup.css`
- `apps/mobile/App.tsx`
- `apps/mobile/native-fingerprints.json`
- `apps/mobile/package.json`
- `apps/mobile/scripts/generate-theme.ts`
- `apps/mobile/src/ErrorBoundary.tsx`
- `apps/mobile/src/apps/agenda/AgendaCreateModal.tsx`
- `apps/mobile/src/apps/agenda/AgendaEvent.tsx`
- `apps/mobile/src/apps/agenda/AgendaEventEditor.tsx`
- `apps/mobile/src/apps/agenda/AgendaHome.styles.ts`
- `apps/mobile/src/apps/agenda/AgendaHome.tsx`
- `apps/mobile/src/apps/assistant/Assistant.styles.ts`
- `apps/mobile/src/apps/assistant/Assistant.tsx`
- `apps/mobile/src/apps/automations/AutomationThread.tsx`
- `apps/mobile/src/apps/automations/Automations.styles.ts`
- `apps/mobile/src/apps/automations/Automations.tsx`
- `apps/mobile/src/apps/docs/DocsHome.styles.ts`
- `apps/mobile/src/apps/docs/DocsHome.tsx`
- `apps/mobile/src/apps/docs/DocsItemActions.tsx`
- `apps/mobile/src/apps/docs/DocsLibraryItems.tsx`
- `apps/mobile/src/apps/docs/DocumentViewer.tsx`
- `apps/mobile/src/apps/docs/docs-library-shelves.ts`
- `apps/mobile/src/apps/insights/GatewayAlerts.tsx`
- `apps/mobile/src/apps/insights/Insights.tsx`
- `apps/mobile/src/apps/locker/LockerHome.styles.ts`
- `apps/mobile/src/apps/notes/NotesHome.styles.ts`
- `apps/mobile/src/apps/notes/NotesHome.tsx`
- `apps/mobile/src/apps/people/MergePicker.tsx`
- `apps/mobile/src/apps/people/PeopleHome.styles.ts`
- `apps/mobile/src/apps/people/PeopleHome.tsx`
- `apps/mobile/src/apps/photos/AlbumDetail.tsx`
- `apps/mobile/src/apps/photos/BackupHealth.styles.ts`
- `apps/mobile/src/apps/photos/BackupHealth.tsx`
- `apps/mobile/src/apps/photos/DuplicateReview.tsx`
- `apps/mobile/src/apps/photos/FaceReview.tsx`
- `apps/mobile/src/apps/photos/MediaPage.tsx`
- `apps/mobile/src/apps/photos/PhotoLightbox.styles.ts`
- `apps/mobile/src/apps/photos/PhotoLightbox.tsx`
- `apps/mobile/src/apps/photos/PhotoLightboxToolbar.tsx`
- `apps/mobile/src/apps/photos/PhotoStateView.tsx`
- `apps/mobile/src/apps/photos/PhotoTimeline.tsx`
- `apps/mobile/src/apps/photos/PhotosCollectionsView.tsx`
- `apps/mobile/src/apps/photos/PhotosDrawer.tsx`
- `apps/mobile/src/apps/photos/PhotosHome.tsx`
- `apps/mobile/src/apps/photos/PhotosLibrary.styles.ts`
- `apps/mobile/src/apps/photos/PhotosLibrary.tsx`
- `apps/mobile/src/apps/photos/PhotosSearch.tsx`
- `apps/mobile/src/apps/photos/PlacesMap.tsx`
- `apps/mobile/src/apps/tally/TallyHome.tsx`
- `apps/mobile/src/apps/tasks/TasksHome.tsx`
- `apps/mobile/src/components/OutboxDecisionCard.tsx`
- `apps/mobile/src/kit/components/AppHeader.tsx`
- `apps/mobile/src/kit/components/AppIcon.tsx`
- `apps/mobile/src/kit/components/AudiencePlacementSheet.tsx`
- `apps/mobile/src/kit/components/Button.tsx`
- `apps/mobile/src/kit/components/HomeKey.tsx`
- `apps/mobile/src/kit/components/Icon.tsx`
- `apps/mobile/src/kit/components/OptionSheet.tsx`
- `apps/mobile/src/kit/components/Toast.tsx`
- `apps/mobile/src/kit/hooks/ShareIntentIngest.tsx`
- `apps/mobile/src/kit/replica/ReplicaStateCard.tsx`
- `apps/mobile/src/kit/replica/ReplicaStatusBar.tsx`
- `apps/mobile/src/kit/replica/write-outcome.test.ts`
- `apps/mobile/src/kit/replica/write-outcome.ts`
- `apps/mobile/src/kit/security/AppLock.tsx`
- `apps/mobile/src/kit/theme/accent.ts`
- `apps/mobile/src/kit/theme/generate.test.ts`
- `apps/mobile/src/kit/theme/generate.ts`
- `apps/mobile/src/kit/theme/index.ts`
- `apps/mobile/src/kit/theme/resolve.test.ts`
- `apps/mobile/src/kit/theme/resolve.ts`
- `apps/mobile/src/kit/theme/tokens.generated.ts`
- `apps/mobile/src/kit/theme/useTheme.ts`
- `apps/mobile/src/lib/insights.test.ts`
- `apps/mobile/src/lib/insights.ts`
- `apps/mobile/src/lib/profile.test.ts`
- `apps/mobile/src/lib/profile.ts`
- `apps/mobile/src/lib/upload/media-producer.ts`
- `apps/mobile/src/screens/AppDetail.tsx`
- `apps/mobile/src/screens/Approvals.tsx`
- `apps/mobile/src/screens/Capture.tsx`
- `apps/mobile/src/screens/Onboarding.test.tsx`
- `apps/mobile/src/screens/Onboarding.tsx`
- `apps/mobile/src/screens/PhoneStorage.tsx`
- `apps/mobile/src/screens/Scan.tsx`
- `apps/mobile/src/screens/Settings.tsx`
- `apps/mobile/src/screens/home/AttentionLine.tsx`
- `apps/mobile/src/screens/home/DailyBriefCard.tsx`
- `apps/mobile/src/screens/home/GreetingHeader.tsx`
- `apps/mobile/src/screens/home/LauncherGrid.tsx`
- `apps/mobile/src/screens/home/VaultDrawer.tsx`
- `apps/mobile/src/screens/home/catalog.ts`
- `apps/mobile/src/screens/onboarding-art.tsx`
- `apps/mobile/src/screens/onboarding-styles.ts`
- `apps/mobile/src/screens/scan-ui.tsx`
- `apps/mobile/src/screens/settings/ColorSwatchRow.tsx`
- `apps/web/public/apple-touch-icon-180.png`
- `apps/web/public/centraid.svg`
- `apps/web/public/icon-192.png`
- `apps/web/public/icon-512.png`
- `apps/web/public/icon-maskable-512.png`
- `apps/web/public/manifest.webmanifest`
- `apps/web/public/offline.html`
- `apps/web/src/web-state.ts`
- `apps/web/src/web.css`
- `bun.lock`
- `docs/refactors/product-grammar.md`
- `docs/sonarcloud.md`
- `package.json`
- `packages/app-engine/src/registry/token-purity.test.ts`
- `packages/app-engine/src/registry/token-purity.ts`
- `packages/app-engine/src/settings/settings-merge.test.ts`
- `packages/app-engine/src/settings/settings-merge.ts`
- `packages/blueprints/apps/_shared/AudiencePlacement.module.css`
- `packages/blueprints/apps/agenda/Chrome.module.css`
- `packages/blueprints/apps/agenda/Chrome.tsx`
- `packages/blueprints/apps/agenda/app-root.tsx`
- `packages/blueprints/apps/agenda/components/CreateModal.module.css`
- `packages/blueprints/apps/agenda/components/EventDrawer.module.css`
- `packages/blueprints/apps/agenda/components/EventEditor.module.css`
- `packages/blueprints/apps/agenda/components/HeaderBar.module.css`
- `packages/blueprints/apps/agenda/components/MonthView.module.css`
- `packages/blueprints/apps/agenda/components/ScheduleView.module.css`
- `packages/blueprints/apps/agenda/components/Shared.tsx`
- `packages/blueprints/apps/agenda/components/Sidebar.module.css`
- `packages/blueprints/apps/agenda/components/WeekView.module.css`
- `packages/blueprints/apps/agenda/format.ts`
- `packages/blueprints/apps/agenda/icons.ts`
- `packages/blueprints/apps/docs/Chrome.module.css`
- `packages/blueprints/apps/docs/Chrome.tsx`
- `packages/blueprints/apps/docs/app-root.tsx`
- `packages/blueprints/apps/docs/components/Activity.module.css`
- `packages/blueprints/apps/docs/components/BulkBar.module.css`
- `packages/blueprints/apps/docs/components/Details.module.css`
- `packages/blueprints/apps/docs/components/Editor.module.css`
- `packages/blueprints/apps/docs/components/Grid.module.css`
- `packages/blueprints/apps/docs/components/History.module.css`
- `packages/blueprints/apps/docs/components/List.module.css`
- `packages/blueprints/apps/docs/components/QuickLook.module.css`
- `packages/blueprints/apps/docs/components/Sidebar.module.css`
- `packages/blueprints/apps/docs/components/shared.module.css`
- `packages/blueprints/apps/docs/icons.ts`
- `packages/blueprints/apps/locker/Chrome.module.css`
- `packages/blueprints/apps/locker/app-root.tsx`
- `packages/blueprints/apps/locker/components/Detail.module.css`
- `packages/blueprints/apps/locker/components/EditModal.module.css`
- `packages/blueprints/apps/locker/components/Generator.module.css`
- `packages/blueprints/apps/locker/components/ItemFields.module.css`
- `packages/blueprints/apps/locker/components/ItemFields.tsx`
- `packages/blueprints/apps/locker/components/List.module.css`
- `packages/blueprints/apps/locker/components/LockScreen.module.css`
- `packages/blueprints/apps/locker/components/Sidebar.module.css`
- `packages/blueprints/apps/locker/components/Sidebar.tsx`
- `packages/blueprints/apps/locker/components/shared.module.css`
- `packages/blueprints/apps/locker/icons.ts`
- `packages/blueprints/apps/locker/logic.test.ts`
- `packages/blueprints/apps/locker/logic.ts`
- `packages/blueprints/apps/locker/types.ts`
- `packages/blueprints/apps/notes/Chrome.module.css`
- `packages/blueprints/apps/notes/Chrome.tsx`
- `packages/blueprints/apps/notes/app-root.tsx`
- `packages/blueprints/apps/notes/components/Card.module.css`
- `packages/blueprints/apps/notes/components/Editor.module.css`
- `packages/blueprints/apps/notes/components/History.module.css`
- `packages/blueprints/apps/notes/components/QuickAdd.module.css`
- `packages/blueprints/apps/notes/components/Sidebar.module.css`
- `packages/blueprints/apps/notes/components/Toolbar.module.css`
- `packages/blueprints/apps/notes/components/Wall.module.css`
- `packages/blueprints/apps/notes/components/WikiLinks.module.css`
- `packages/blueprints/apps/notes/components/shared.module.css`
- `packages/blueprints/apps/notes/icons.ts`
- `packages/blueprints/apps/people/Chrome.module.css`
- `packages/blueprints/apps/people/Chrome.tsx`
- `packages/blueprints/apps/people/app-root.tsx`
- `packages/blueprints/apps/people/components/Activity.tsx`
- `packages/blueprints/apps/people/components/AddPersonModal.module.css`
- `packages/blueprints/apps/people/components/BulkBar.module.css`
- `packages/blueprints/apps/people/components/DetailSections.module.css`
- `packages/blueprints/apps/people/components/DetailSections.tsx`
- `packages/blueprints/apps/people/components/Details.module.css`
- `packages/blueprints/apps/people/components/Grid.module.css`
- `packages/blueprints/apps/people/components/Journal.module.css`
- `packages/blueprints/apps/people/components/Journal.tsx`
- `packages/blueprints/apps/people/components/List.module.css`
- `packages/blueprints/apps/people/components/Sidebar.module.css`
- `packages/blueprints/apps/people/components/TrashCard.module.css`
- `packages/blueprints/apps/people/components/shared.module.css`
- `packages/blueprints/apps/people/format.ts`
- `packages/blueprints/apps/people/icons.ts`
- `packages/blueprints/apps/photos/Chrome.module.css`
- `packages/blueprints/apps/photos/components/AlbumGrid.module.css`
- `packages/blueprints/apps/photos/components/Duplicates.module.css`
- `packages/blueprints/apps/photos/components/Editor.module.css`
- `packages/blueprints/apps/photos/components/Lightbox.module.css`
- `packages/blueprints/apps/photos/components/LightboxInfo.module.css`
- `packages/blueprints/apps/photos/components/Memories.module.css`
- `packages/blueprints/apps/photos/components/Picker.module.css`
- `packages/blueprints/apps/photos/components/SelectionBar.module.css`
- `packages/blueprints/apps/photos/components/Sidebar.module.css`
- `packages/blueprints/apps/photos/components/Slideshow.module.css`
- `packages/blueprints/apps/photos/components/Timeline.module.css`
- `packages/blueprints/apps/photos/components/Toolbar.module.css`
- `packages/blueprints/apps/photos/components/shared.module.css`
- `packages/blueprints/apps/photos/icons.tsx`
- `packages/blueprints/apps/tally/Chrome.module.css`
- `packages/blueprints/apps/tally/Chrome.tsx`
- `packages/blueprints/apps/tally/app-root.tsx`
- `packages/blueprints/apps/tally/components/Dashboard.module.css`
- `packages/blueprints/apps/tally/components/DetailModal.tsx`
- `packages/blueprints/apps/tally/components/ExpenseModal.module.css`
- `packages/blueprints/apps/tally/components/ExpenseRow.module.css`
- `packages/blueprints/apps/tally/components/ExpenseUndo.module.css`
- `packages/blueprints/apps/tally/components/GroupManager.module.css`
- `packages/blueprints/apps/tally/components/shared.module.css`
- `packages/blueprints/apps/tally/format.ts`
- `packages/blueprints/apps/tally/icons.ts`
- `packages/blueprints/apps/tally/logic.ts`
- `packages/blueprints/apps/tally/queries/dashboard.ts`
- `packages/blueprints/apps/tasks/Chrome.module.css`
- `packages/blueprints/apps/tasks/Chrome.tsx`
- `packages/blueprints/apps/tasks/app-root.tsx`
- `packages/blueprints/apps/tasks/components/Board.module.css`
- `packages/blueprints/apps/tasks/components/Capture.module.css`
- `packages/blueprints/apps/tasks/components/Detail.module.css`
- `packages/blueprints/apps/tasks/components/Row.module.css`
- `packages/blueprints/apps/tasks/components/Sidebar.module.css`
- `packages/blueprints/apps/tasks/components/shared.module.css`
- `packages/blueprints/apps/tasks/icons.ts`
- `packages/blueprints/src/__snapshots__/scaffold-defaults.test.ts.snap`
- `packages/blueprints/src/app-boot-harness.ts`
- `packages/blueprints/src/runtime-boundary.test.ts`
- `packages/blueprints/src/scaffold-defaults.test.ts`
- `packages/blueprints/src/scaffold-defaults.ts`
- `packages/blueprints/src/scaffold-files.test.ts`
- `packages/blueprints/src/token-purity-allowlist.ts`
- `packages/blueprints/src/token-purity.test.ts`
- `packages/client/src/app-format.ts`
- `packages/client/src/app-shell-context.ts`
- `packages/client/src/format.ts`
- `packages/client/src/index.ts`
- `packages/client/src/react/CSS-CONVENTIONS.md`
- `packages/client/src/react/blueprints/kit-inline.test.ts`
- `packages/client/src/react/blueprints/kit-inline.ts`
- `packages/client/src/react/format.ts`
- `packages/client/src/react/screens/AppSettingsPanel.module.css`
- `packages/client/src/react/screens/ApprovalsScreen.module.css`
- `packages/client/src/react/screens/ApprovalsScreen.tsx`
- `packages/client/src/react/screens/AssistantMessage.tsx`
- `packages/client/src/react/screens/AssistantScreen.module.css`
- `packages/client/src/react/screens/AssistantScreen.tsx`
- `packages/client/src/react/screens/AtlasBrowseTab.module.css`
- `packages/client/src/react/screens/AtlasKindsTab.module.css`
- `packages/client/src/react/screens/AtlasRelationsTab.module.css`
- `packages/client/src/react/screens/AtlasScreen.module.css`
- `packages/client/src/react/screens/AutomationCompilePane.module.css`
- `packages/client/src/react/screens/AutomationEditorConnectorsPicker.tsx`
- `packages/client/src/react/screens/AutomationEditorScreen.module.css`
- `packages/client/src/react/screens/AutomationEditorScreen.tsx`
- `packages/client/src/react/screens/AutomationTemplatesScreen.module.css`
- `packages/client/src/react/screens/AutomationThreadScreen.module.css`
- `packages/client/src/react/screens/AutomationThreadScreen.tsx`
- `packages/client/src/react/screens/AutomationsOverviewScreen.module.css`
- `packages/client/src/react/screens/AutomationsOverviewScreen.tsx`
- `packages/client/src/react/screens/BackupCard.module.css`
- `packages/client/src/react/screens/BuilderChatPane.module.css`
- `packages/client/src/react/screens/BuilderChatPane.tsx`
- `packages/client/src/react/screens/ChatComposer.module.css`
- `packages/client/src/react/screens/DevicePairPanel.module.css`
- `packages/client/src/react/screens/DevicesCard.module.css`
- `packages/client/src/react/screens/DiscoverScreen.module.css`
- `packages/client/src/react/screens/DiscoverScreen.tsx`
- `packages/client/src/react/screens/GatewayScreen.module.css`
- `packages/client/src/react/screens/HomeScreen.module.css`
- `packages/client/src/react/screens/HouseholdScreen.module.css`
- `packages/client/src/react/screens/ImportScreen.module.css`
- `packages/client/src/react/screens/InsightsScreen.module.css`
- `packages/client/src/react/screens/LocalFootprintCard.module.css`
- `packages/client/src/react/screens/LogsScreen.module.css`
- `packages/client/src/react/screens/OnboardingIdentityStep.tsx`
- `packages/client/src/react/screens/OnboardingScreen.module.css`
- `packages/client/src/react/screens/OnboardingScreen.test.tsx`
- `packages/client/src/react/screens/PaletteScreen.tsx`
- `packages/client/src/react/screens/PhoneScreen.module.css`
- `packages/client/src/react/screens/RecoverScreen.module.css`
- `packages/client/src/react/screens/ResourceDialogs.module.css`
- `packages/client/src/react/screens/ResourceReceiptPanel.module.css`
- `packages/client/src/react/screens/ResourceReceiptPanel.test.tsx`
- `packages/client/src/react/screens/RunViewScreen.module.css`
- `packages/client/src/react/screens/SessionStatusStrip.module.css`
- `packages/client/src/react/screens/SettingsConnectionsScreen.module.css`
- `packages/client/src/react/screens/SettingsConnectionsScreen.tsx`
- `packages/client/src/react/screens/SettingsDiagnosticsScreen.module.css`
- `packages/client/src/react/screens/SettingsProfileScreen.module.css`
- `packages/client/src/react/screens/SettingsProfileScreen.tsx`
- `packages/client/src/react/screens/SettingsProvidersScreen.module.css`
- `packages/client/src/react/screens/SettingsProvidersScreen.tsx`
- `packages/client/src/react/screens/SettingsStorageScreen.module.css`
- `packages/client/src/react/screens/SettingsStorageScreen.tsx`
- `packages/client/src/react/screens/StorageLimitsPanel.module.css`
- `packages/client/src/react/screens/WhatsNewModal.module.css`
- `packages/client/src/react/screens/localUsageView.ts`
- `packages/client/src/react/screens/resource-summary.ts`
- `packages/client/src/react/shell/CaptureOverlay.module.css`
- `packages/client/src/react/shell/ErrorBoundary.tsx`
- `packages/client/src/react/shell/PageScroll.module.css`
- `packages/client/src/react/shell/Sidebar.tsx`
- `packages/client/src/react/shell/appearance.ts`
- `packages/client/src/react/shell/automationTemplatePreview.module.css`
- `packages/client/src/react/shell/chrome.module.css`
- `packages/client/src/react/shell/routes/AppInfoModal.module.css`
- `packages/client/src/react/shell/routes/AppViewRoute.module.css`
- `packages/client/src/react/shell/routes/ConnectFlow.module.css`
- `packages/client/src/react/shell/routes/InlineAppRoute.tsx`
- `packages/client/src/react/shell/routes/ScopePicker.module.css`
- `packages/client/src/react/shell/routes/SettingsRoute.module.css`
- `packages/client/src/react/shell/routes/VaultModal.module.css`
- `packages/client/src/react/shell/routes/VaultModal.tsx`
- `packages/client/src/react/shell/routes/appSettingsData.test.ts`
- `packages/client/src/react/shell/routes/appSettingsData.ts`
- `packages/client/src/react/shell/routes/assistantRich.module.css`
- `packages/client/src/react/shell/routes/builder/BuilderAutomationPane.module.css`
- `packages/client/src/react/shell/routes/builder/BuilderCloud.module.css`
- `packages/client/src/react/shell/routes/builder/BuilderHistory.module.css`
- `packages/client/src/react/shell/routes/builder/BuilderPreview.module.css`
- `packages/client/src/react/shell/templatePreview.module.css`
- `packages/client/src/react/styles/automation.module.css`
- `packages/client/src/react/styles/drawerGroup.module.css`
- `packages/client/src/react/styles/library.module.css`
- `packages/client/src/react/styles/modal.module.css`
- `packages/client/src/react/styles/swatch.module.css`
- `packages/client/src/react/styles/vault.module.css`
- `packages/client/src/react/ui/AppCard.module.css`
- `packages/client/src/react/ui/Button.module.css`
- `packages/client/src/react/ui/Button.test.tsx`
- `packages/client/src/react/ui/Button.tsx`
- `packages/client/src/react/ui/Gallery.tsx`
- `packages/client/src/react/ui/KindBadge.module.css`
- `packages/design/kit/format.js`
- `packages/design/kit/icons.js`
- `packages/design/kit/identity.js`
- `packages/design/kit/kit-avatar.js`
- `packages/design/kit/kit.css`
- `packages/design/kit/kit.ts`
- `packages/design/src/apps.ts`
- `packages/design/src/blueprint.ts`
- `packages/design/src/contract.ts`
- `packages/design/src/contrast.test.ts`
- `packages/design/src/css-properties.test.ts`
- `packages/design/src/css.test.ts`
- `packages/design/src/css.ts`
- `packages/design/src/tile.ts`
- `packages/design/src/design-md.test.ts`
- `packages/design/src/format.test.ts`
- `packages/design/src/format.ts`
- `packages/design/src/icons-contract.test.ts`
- `packages/design/src/icons.ts`
- `packages/design/src/identity.ts`
- `packages/design/src/index.ts`
- `packages/design/src/kit-smoke.test.ts`
- `packages/design/src/library.ts`
- `packages/design/src/moment-matrix.test.ts`
- `packages/design/src/native.ts`
- `packages/design/src/radii.ts`
- `packages/design/src/recipes/css.ts`
- `packages/design/src/recipes/index.ts`
- `packages/design/src/recipes/native.ts`
- `packages/design/src/recipes/recipes.test.ts`
- `packages/design/src/roles.test.ts`
- `packages/design/src/roles.ts`
- `packages/design/src/themes/centraid.ts`
- `packages/design/src/themes/index.ts`
- `packages/design/src/themes/shared.ts`
- `packages/design/src/type-role-parity.test.ts`
- `packages/design/src/typography.ts`
- `packages/gateway/package.json`
- `packages/gateway/skills/authoring-centraid-apps/SKILL.md`
- `packages/gateway/src/skills/ui-grounding.ts`
- `packages/gateway/src/validate-app-css.test.ts`
- `receipts/issue-690-product-grammar.md`
- `scripts/ci/configure-sonarcloud.mjs`
- `scripts/design-gallery.mjs`
- `scripts/docs-site/public/assets/docs.css`
- `scripts/docs-site/src/content/ontology-style.css`
- `scripts/home-site/public/index.html`
- `scripts/lint-design-tokens.mjs`
- `scripts/lint-design-tokens.test.mjs`
- `scripts/lint-mobile-design.mjs`
- `scripts/lint-mobile-design.test.mjs`
- `tests/design-gallery/README.md`
- `tests/design-gallery/baselines/bi-dark.png`
- `tests/design-gallery/baselines/bi-light.png`
- `tests/design-gallery/baselines/bs-agenda-dark.png`
- `tests/design-gallery/baselines/bs-agenda-light.png`
- `tests/design-gallery/baselines/bs-docs-dark.png`
- `tests/design-gallery/baselines/bs-docs-light.png`
- `tests/design-gallery/baselines/bs-locker-dark.png`
- `tests/design-gallery/baselines/bs-locker-light.png`
- `tests/design-gallery/baselines/bs-notes-dark.png`
- `tests/design-gallery/baselines/bs-notes-light.png`
- `tests/design-gallery/baselines/bs-people-dark.png`
- `tests/design-gallery/baselines/bs-people-light.png`
- `tests/design-gallery/baselines/bs-photos-dark.png`
- `tests/design-gallery/baselines/bs-photos-light.png`
- `tests/design-gallery/baselines/bs-tally-dark.png`
- `tests/design-gallery/baselines/bs-tally-light.png`
- `tests/design-gallery/baselines/bs-tasks-dark.png`
- `tests/design-gallery/baselines/bs-tasks-light.png`
- `tests/design-gallery/baselines/mo-advisory-dark.png`
- `tests/design-gallery/baselines/mo-advisory-light.png`
- `tests/design-gallery/baselines/sh-c-dark.png`
- `tests/design-gallery/baselines/sh-c-light.png`
- `tests/design-gallery/manifest.json`
- `tests/design-grammar-matrix.json`
- `tests/design-token-css-budget.json`
- `tests/matrix.json`
- `tests/quality/classification-ratchet.json`

## Audit

- PASS — `## What changed`: `git diff HEAD` covers the claimed design constitution, shared role/theme/icon/identity/formatter contracts, cross-surface migrations, regression fixes, executable gates, gallery/matrix evidence, and process documentation. The receipt’s file map accounts for the changed paths.
- PASS — checked `## Checklist` items: the receipt explicitly covers P0/P1, P2/P3, P4, P5/P6, B1–B29, acceptance criteria, and process evidence. Its Evidence ledger names the corresponding implementation and test files, and its recorded verification includes the passing package suites, typechecks, design gates, gallery verification, and final `bun run check:push` result (31/31 gates green), which supports the behavioral claims rather than leaving them unsupported.
- PASS — checklist mirrors issue #690: the checked entries match the linked issue’s current P0.1–P0.10, phases 1–6, acceptance criteria, and B1–B29 checklist.
