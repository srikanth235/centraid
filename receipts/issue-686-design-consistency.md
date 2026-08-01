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

## Decisions (orchestrator recommendations, per user directive)

- **D1 typography = roles, not families.** Web/desktop keep system stacks (#468 K11); mobile keeps its per-role platform mapping, now recorded as decided rather than drift.
- **A2 coexists with the #630 Wave-0 ratchet.** `scripts/lint-design-tokens.mjs` + `tests/design-token-css-budget.json` (landed on main while this branch was in flight) already ratchet rawHex/literalFontFamily across client+blueprints+kit. The new `token-purity` test is complementary — it adds functional color literals, reserved custom-property namespaces, and contract-imported names, blueprint-scope only. Burn-down lanes must shrink BOTH allowlists.
- **E deliberate visual deltas (token semantics over hand-picked values):** tally `--pos`/`--neg` → system `--success`/`--danger`; locker sidebar surface → `--bg-elev`; people re-derives neutrals from `--app-hue: 345` + `--c-rose` accent and drops its Geist/Space Grotesk declarations per the roles decision; agenda light `--warning` → token value; a generator-toggle drop shadow → `--shadow-sm`. All recorded here for review.
- **Photos/docs "theater stage" gap:** 3 residual `hsl(var(--app-hue) 25% 4%)` backdrops exist because the contract has no opaque near-black `--stage` token; follow-up candidate for `packages/design`.
- **kit.css itself still hardcodes type/spacing px** (e.g. `.kit-btn font-size: 0.8125rem`) — the served component layer is the remaining half of full token purity; now visible in the budget (80 rawFontSize in kit) and left as ratcheted debt.
- **Consolidation (user direction): one canonical design document.** `docs/design-language.md` folded into root `DESIGN.md` (its unique content — three-lowerings note, `font` shorthand family-reset caveat, serif role — absorbed; every reference repointed: `AGENTS.md`, `docs/decisions.md`, `packages/design/src/index.ts`, `packages/design/src/design-md.test.ts`, `packages/app-engine/src/registry/token-purity.ts`, `packages/gateway/src/skills/ui-grounding.ts`, `scripts/lint-design-tokens.mjs`) and deleted. `.design-sync/` deleted entirely (user: it no longer makes sense; nothing in the build/test graph reads it) along with its `.gitignore` entries.
- **`EASE` rehomed, `motion.ts` deleted.** A dedicated module for one constant pushed `packages/client/src/index.ts` to 101 modules and tripped oxlint `no-barrel-file` (threshold 100). Rather than weaken the rule, `EASE` moved into `packages/design/src/themes/shared.ts` beside the other measured design constants — no new graph node, still exactly one spelling of the curve. `DESIGN.md` updated to point at the new home. `ACCENT_DEEP_DARK` dropped from the `themes/index.ts` re-export (knip: consumed only inside `themes/centraid.ts`).
- **Visual QA found what the tests could not.** Every gate was green and CI fully passed, but rendering the real emitted tokens against the real `kit.css` across both themes and all eight palette hues exposed a regression F3 had introduced: eleven app rules across six apps filled with `--accent-deep` but inked with the theme-stable `--on-accent`. Because F3 *lifts* `--accent-deep` on the dark ramp, those became white-on-near-white. The numeric grid never caught it because it measured `kit-btn-primary`, not app-local rules that re-declare the same pairing. Fixed in `agenda`, `docs`, `notes`, `photos`, `tasks`, and their components, and pinned by a new `token-purity` test so the pairing cannot return. Lesson recorded: a token change needs a rendered pass, not only a measured one.
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

## Out of scope

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

### Steering

No steering events recorded in this session. The user provided initial strategic direction and task scope in the first message; all subsequent messages were task confirmations or work directives with no interrupts or mid-task corrections to the agent's execution. Verdict: **PASS** — no steering events, no non-steering messages falsely recorded.

## Audit

**1. What changed faithfully describes staged diff:** **PASS** — The receipt's "## What changed" section accurately captures all A1+B1 deliverables: new `motion.ts`, spacing tokens emitted from `density.ts` in both `css.ts` and `blueprint.ts`, `--ease` added to shell contract, six client CSS modules cleaned of fallbacks, and mobile theme byte-identical regeneration.

**2. Checklist items [x] A1 and [x] B1 realized in staged diff:** **PASS** — A1 (spacing tokens `--sp-1…--sp-7` in both `SHELL_TOKEN_CONTRACT` and `BLUEPRINT_TOKEN_CONTRACT` via `contract.ts`, emitted in both `css.ts` and `blueprint.ts`) and B1 (shell motion `--ease` in `SHELL_TOKEN_CONTRACT`, added to `css.ts` emitter, six client modules updated) are both fully realized.

**3. Receipt checklist mirrors issue #686 checklist:** **PASS** — Receipt checklist A1–E items and their descriptions match issue #686 checklist structure exactly; only A1 and B1 are marked [x], remainder [ ] as scoped.
