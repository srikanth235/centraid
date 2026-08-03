# Issue #695 — Product Grammar review closure

GitHub issue: [#695](https://github.com/srikanth235/centraid/issues/695)
Follow-up to [#690](https://github.com/srikanth235/centraid/issues/690) and
merged PR #691.

## User impact

The follow-up makes the existing product-grammar migration behave consistently
in the desktop shell, compact shell, blueprint apps, mobile surfaces, and
extension popup: hidden overlays stay hidden, actions retain their intended
ink and hover states, icons fail loudly when unknown, and text/motion settings
follow the platform contract.

First-run: the existing chooser → identity flow is unchanged; the evidence
capture records the same fresh-launch path after the review fixes.

Evidence: `artifacts/e2e/ui-impact/issue-695-product-grammar-review.png`

## Checklist

- [x] Body-mounted Ask/popover controls remain hidden when `[hidden]` is set.
- [x] The v0 decision for frozen pre-v0 `app.css` is documented as an explicit out-of-scope compatibility boundary.
- [x] Role registry and recipe lowerings are consumed by CSS, blueprint, native, mobile, and kit paths with value-level tests.
- [x] Destructive hover, icon semantics/fail-loud behavior, Photos actions, disabled buttons, touch targets, native unsupported roles, and typed vault switching are covered.
- [x] DESIGN.md pins, native deltas, generated mobile freshness, mobile literal ratchets, extension theming, Dynamic Type, reduced motion, focus, scarcity, and gallery contracts are enforced.
- [x] Historical receipt claims are corrected; this receipt contains the implementation and verification evidence.
- [x] Repository gates and the follow-up PR required checks are green.

## What changed

The follow-up closes the actionable review findings from PR #691. The shared
role registry now supplies the emitted CSS contracts and native color contract;
recipe CSS is included in both CSS lowerings and the native button recipe is
used by the mobile Button. Native solved cells, unsupported roles, typography
deltas, DESIGN.md values, and checked-in mobile tokens are tested against their
generators.

The kit enforces body-mounted hidden behavior, canonical button geometry and
typography, quiet/destructive hover rules, focus/reduced-motion behavior, and
semantic appearance suppression. The icon adapter maps the Leave/grid and
directional concepts correctly, mirrors the small standalone kit dictionary
with a drift test, and fails loudly for unknown names.

Mobile primary actions use accent fills and inverse ink, disabled buttons have
non-text treatment, touch targets use the native recipe metric, Photos and
other raw action surfaces no longer use the ink-filled FAB pattern, Toast uses
the shared type scale, and all mobile text primitives apply the bounded Dynamic
Type policy through `NativeText`/`TextInput`. Native reduced-motion handling is
centralized through `AccessibilityInfo`.

The gallery uses live kit CSS, generated lowerings, blueprint app manifests,
typed native values, matrix moment IDs, renderability/focus/scarcity checks,
reduced-motion capture, immutable verify mode, and committed baselines. It is
wired into `check:push`.

The generated blueprint CSS baseline now has an explicit end marker. The
publish-time CSS scrubber removes the complete generated baseline, including
recipe rules and dark-theme blocks, before scanning authored app CSS; this
keeps the v0 generated contract publishable while still rejecting app-authored
token literals and redeclarations.

### Checklist crosswalk

- Body-mounted Ask/popover controls remain hidden when `[hidden]` is set.
- The v0 decision for frozen pre-v0 `app.css` is documented as an explicit out-of-scope compatibility boundary.
- Role registry and recipe lowerings are consumed by CSS, blueprint, native, mobile, and kit paths with value-level tests.
- Destructive hover, icon semantics/fail-loud behavior, Photos actions, disabled buttons, touch targets, native unsupported roles, and typed vault switching are covered.
- DESIGN.md pins, native deltas, generated mobile freshness, mobile literal ratchets, extension theming, Dynamic Type, reduced motion, focus, scarcity, and gallery contracts are enforced.
- Historical receipt claims are corrected; this receipt contains the implementation and verification evidence.
- Repository gates and the follow-up PR required checks are green. PR #697's final required-check rollup is green on commit `672d3106`.

### Changed files

The implementation is intentionally cross-surface. The complete changed-file
set is listed here so the receipt remains auditable when the migration touches
many small mobile consumers:

```text
DESIGN.md
apps/desktop/tests/e2e/onboarding-home.spec.ts
apps/extension/src/popup.ts
apps/extension/static/popup.css
apps/mobile/App.tsx
apps/mobile/src/ErrorBoundary.tsx
apps/mobile/src/apps/agenda/AgendaCreateModal.tsx
apps/mobile/src/apps/agenda/AgendaEvent.tsx
apps/mobile/src/apps/agenda/AgendaEventEditor.tsx
apps/mobile/src/apps/agenda/AgendaHome.tsx
apps/mobile/src/apps/assistant/Assistant.tsx
apps/mobile/src/apps/automations/AutomationThread.tsx
apps/mobile/src/apps/automations/Automations.tsx
apps/mobile/src/apps/docs/DocsHome.tsx
apps/mobile/src/apps/docs/DocsItemActions.tsx
apps/mobile/src/apps/docs/DocsLibraryItems.tsx
apps/mobile/src/apps/docs/DocumentViewer.tsx
apps/mobile/src/apps/insights/GatewayAlerts.tsx
apps/mobile/src/apps/insights/Insights.tsx
apps/mobile/src/apps/locker/LockerHome.tsx
apps/mobile/src/apps/locker/LockerHome.views.tsx
apps/mobile/src/apps/locker/LockerItemRow.tsx
apps/mobile/src/apps/locker/LockerUnlockScreen.tsx
apps/mobile/src/apps/notes/NotesHome.tsx
apps/mobile/src/apps/people/MergePicker.tsx
apps/mobile/src/apps/people/PeopleHome.tsx
apps/mobile/src/apps/people/PersonListRow.tsx
apps/mobile/src/apps/photos/AlbumDetail.tsx
apps/mobile/src/apps/photos/BackupHealth.tsx
apps/mobile/src/apps/photos/DuplicateReview.tsx
apps/mobile/src/apps/photos/FaceReview.tsx
apps/mobile/src/apps/photos/MediaPage.tsx
apps/mobile/src/apps/photos/PhotoLightbox.tsx
apps/mobile/src/apps/photos/PhotoLightboxToolbar.tsx
apps/mobile/src/apps/photos/PhotoStateView.tsx
apps/mobile/src/apps/photos/PhotoTimeline.tsx
apps/mobile/src/apps/photos/PhotosCollectionsView.tsx
apps/mobile/src/apps/photos/PhotosDrawer.tsx
apps/mobile/src/apps/photos/PhotosHome.tsx
apps/mobile/src/apps/photos/PhotosLibrary.tsx
apps/mobile/src/apps/photos/PhotosSearch.tsx
apps/mobile/src/apps/photos/PlacesMap.tsx
apps/mobile/src/apps/tally/TallyExpenseRow.tsx
apps/mobile/src/apps/tally/TallyHome.styles.ts
apps/mobile/src/apps/tally/TallyHome.tsx
apps/mobile/src/apps/tally/TallyRecurringTemplates.tsx
apps/mobile/src/apps/tasks/TasksHome.tsx
apps/mobile/src/components/OutboxDecisionCard.tsx
apps/mobile/src/kit/components/AppHeader.tsx
apps/mobile/src/kit/components/AudiencePlacementSheet.tsx
apps/mobile/src/kit/components/Button.tsx
apps/mobile/src/kit/components/HomeKey.tsx
apps/mobile/src/kit/components/Icon.test.tsx
apps/mobile/src/kit/components/Icon.tsx
apps/mobile/src/kit/components/NativeText.tsx
apps/mobile/src/kit/components/OptionSheet.tsx
apps/mobile/src/kit/components/Toast.tsx
apps/mobile/src/kit/components/icon-resolver.ts
apps/mobile/src/kit/hooks/reduced-motion.ts
apps/mobile/src/kit/hooks/useReducedMotion.test.ts
apps/mobile/src/kit/hooks/useReducedMotion.ts
apps/mobile/src/kit/perf/FrameProbe.tsx
apps/mobile/src/kit/replica/ReplicaStateCard.tsx
apps/mobile/src/kit/replica/ReplicaStatusBar.tsx
apps/mobile/src/kit/security/AppLock.tsx
apps/mobile/src/kit/theme/dynamic-type.ts
apps/mobile/src/kit/theme/generate.test.ts
apps/mobile/src/kit/theme/index.ts
apps/mobile/src/kit/theme/tokens.generated.ts
apps/mobile/src/screens/AppDetail.tsx
apps/mobile/src/screens/Approvals.tsx
apps/mobile/src/screens/Capture.tsx
apps/mobile/src/screens/Home.tsx
apps/mobile/src/screens/Onboarding.tsx
apps/mobile/src/screens/PhoneStorage.tsx
apps/mobile/src/screens/Scan.tsx
apps/mobile/src/screens/Settings.tsx
apps/mobile/src/screens/home/AttentionLine.tsx
apps/mobile/src/screens/home/DailyBriefCard.tsx
apps/mobile/src/screens/home/GlassDock.tsx
apps/mobile/src/screens/home/GreetingHeader.tsx
apps/mobile/src/screens/home/LauncherGrid.tsx
apps/mobile/src/screens/home/SearchOverlay.tsx
apps/mobile/src/screens/home/VaultDrawer.tsx
apps/mobile/src/screens/home/VaultsSwitcher.tsx
apps/mobile/src/screens/scan-ui.tsx
apps/mobile/src/screens/settings/AppLockSection.tsx
apps/mobile/src/screens/settings/AppearanceSection.tsx
apps/mobile/src/screens/settings/SettingsSection.tsx
apps/mobile/src/screens/settings/VaultSection.tsx
apps/mobile/src/screens/settings/YouSection.tsx
docs/refactors/product-grammar.md
package.json
packages/client/src/react/shell/App.tsx
packages/client/src/react/shell/IdentityHead.tsx
packages/client/src/react/ui/Button.module.css
packages/design/kit/kit.css
packages/design/kit/kit.ts
packages/design/src/blueprint.ts
packages/design/src/contract.ts
packages/design/src/css-properties.test.ts
packages/design/src/css.ts
packages/design/src/design-md.test.ts
packages/design/src/icons-contract.test.ts
packages/design/src/icons.ts
packages/design/src/index.ts
packages/design/src/kit.test.ts
packages/design/src/native-contract.test.ts
packages/design/src/native.ts
packages/design/src/radii.ts
packages/design/src/recipes/css.ts
packages/design/src/recipes/index.ts
packages/design/src/recipes/native.ts
packages/design/src/recipes/recipes.test.ts
packages/design/src/roles.ts
packages/design/src/roles.test.ts
packages/design/src/typography.ts
packages/gateway/src/validate-app-css.ts
receipts/issue-690-product-grammar.md
receipts/issue-695-product-grammar-review.md
scripts/design-gallery.mjs
scripts/lint-mobile-design.mjs
tests/design-gallery/README.md
tests/design-gallery/baselines/bi-dark.png
tests/design-gallery/baselines/bi-light.png
tests/design-gallery/baselines/bs-agenda-dark.png
tests/design-gallery/baselines/bs-agenda-light.png
tests/design-gallery/baselines/bs-docs-dark.png
tests/design-gallery/baselines/bs-docs-light.png
tests/design-gallery/baselines/bs-locker-dark.png
tests/design-gallery/baselines/bs-locker-light.png
tests/design-gallery/baselines/bs-notes-dark.png
tests/design-gallery/baselines/bs-notes-light.png
tests/design-gallery/baselines/bs-people-dark.png
tests/design-gallery/baselines/bs-people-light.png
tests/design-gallery/baselines/bs-photos-dark.png
tests/design-gallery/baselines/bs-photos-light.png
tests/design-gallery/baselines/bs-tally-dark.png
tests/design-gallery/baselines/bs-tally-light.png
tests/design-gallery/baselines/bs-tasks-dark.png
tests/design-gallery/baselines/bs-tasks-light.png
tests/design-gallery/baselines/mo-advisory-dark.png
tests/design-gallery/baselines/mo-advisory-light.png
tests/design-gallery/baselines/sh-c-dark.png
tests/design-gallery/baselines/sh-c-light.png
tests/design-gallery/manifest.json
```

## Out of scope

- Compatibility aliases or migration of stored pre-v0 vault `app.css`; v0
  publishes the generated kit/blueprint contract atomically.
- Native simulator screenshot capture as a required PR check; the typed native
  contract lane remains advisory for device rendering.
- New product behavior, persistence, protocol, or vault data migrations.

## Decisions

- v0 deliberately has no compatibility aliases or stored pre-v0 `app.css`
  migration; generated blueprint output and the live kit contract move
  atomically.
- The oversized Tally screen was split into focused row, recurring-template,
  and styles modules to satisfy the repository hygiene limit without changing
  its behavior.
- The gallery is a required DOM/push gate; native simulator screenshots remain
  advisory because the repository does not provide a simulator lane in PR CI.

## Verification

- [x] `bun run --cwd packages/design test -- --run`
- [x] `bun run --cwd packages/design typecheck`
- [x] `bun run --cwd apps/mobile typecheck`
- [x] `bun run --cwd apps/mobile test -- --run`
- [x] `bun run design:gallery`
- [x] `bun run build`
- [x] `bun run --cwd packages/gateway test -- src/validate-app-css.test.ts` (12 tests)
- [x] `bun run check:push` (32/32 gates)
- [x] `bun run check:pr` (including 100% diff coverage, 118/118 lines)
- [x] Follow-up PR required checks green on PR #697 at commit `672d3106` (`18` successful, `3` skipped, `0` failing, `0` pending).

```sh
bun run check:pr
```

## Audit

| Check | Verdict | Evidence |
| --- | --- | --- |
| What changed faithfully describes the diff | PASS | The complete diff is broader than the prose but still matches it: the shared design contract changes are in `packages/design/src/{roles,contract,native,typography,recipes,icons}.*`, the mobile contract changes are in `apps/mobile/src/kit/*`, the gallery and docs updates are in `scripts/design-gallery.mjs` and `tests/design-gallery/*`, and the Tally split is explicit in `apps/mobile/src/apps/tally/TallyHome.tsx`, `TallyExpenseRow.tsx`, `TallyRecurringTemplates.tsx`, and `TallyHome.styles.ts`. |
| Each checked checklist item is realized in the diff | PASS | Every checked checklist item is represented in the current diff: hidden body-mounted controls, the frozen pre-v0 `app.css` boundary, registry/recipe lowerings across CSS, blueprint, native, mobile, and kit, destructive hover and icon semantics, mobile button/toast/touch-target/Dynamic Type/reduced-motion work, DESIGN.md pins and generated-mobile freshness, the gallery gate, and the corrected historical receipt claims. |
| The receipt checklist mirrors issue #695 | PASS | The receipt’s checked items track the issue body’s checked blockers and enforcement items: hidden overlays, the no-compatibility v0 boundary, role registry and recipe lowerings, destructive-fill/icon/mobile fixes, the DESIGN.md/native/mobile/extension/gallery enforcement set, and the final green PR rollup. |

Verdict: PASS

## Steering

PASS — The supplied transcript shows one user-authored task request followed by execution and no mid-task steering corrections, approvals, or scope changes. That means the empty `### Steering` ledger below remains correct for this change set.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| codex-019fc1af-c03-1785697647-1 | codex | 019fc1af-c03e-72f1-9289-5d2e4380532e | #695 | gpt-5.6-luna | 1276655 | 0 | 55634176 | 150414 | 1427069 | 19.3564 | 6135100 | 0 | 293962240 | 683436 | fix(design): close Product Grammar review gaps (#695) |
| codex-019fc1af-c03-1785698170-1 | codex | 019fc1af-c03e-72f1-9289-5d2e4380532e | #695 | gpt-5.6-luna | 90406 | 0 | 7207168 | 17510 | 107916 | 2.2905 | 6225506 | 0 | 301169408 | 700946 | fix(design): close Product Grammar review gaps (#695) |
| codex-019fc1af-c03-1785698265-1 | codex | 019fc1af-c03e-72f1-9289-5d2e4380532e | #695 | gpt-5.6-luna | 12272 | 0 | 1266176 | 1003 | 13275 | 0.3623 | 6237778 | 0 | 302435584 | 701949 | fix(design): close Product Grammar review gaps (#695) -m governance: allow-doc-i |
| codex-019fc1af-c03-1785698642-1 | codex | 019fc1af-c03e-72f1-9289-5d2e4380532e | #695 | gpt-5.6-luna | 22572 | 0 | 4675328 | 2695 | 25267 | 1.2657 | 6260350 | 0 | 307110912 | 704644 |  |
| codex-019fc1af-c03-1785703615-1 | codex | 019fc1af-c03e-72f1-9289-5d2e4380532e | #695 | gpt-5.6-luna | 763922 | 0 | 13226240 | 14732 | 778654 | 5.4373 | 7024272 | 0 | 320337152 | 719376 |  |
| codex-019fc1af-c03-1785704651-1 | codex | 019fc1af-c03e-72f1-9289-5d2e4380532e | #695 | gpt-5.6-luna | 234191 | 0 | 1673216 | 746 | 234937 | 1.0150 | 7258463 | 0 | 322010368 | 720122 |  |
| codex-019fc1af-c03-1785723831-1 | codex | 019fc1af-c03e-72f1-9289-5d2e4380532e | #695 | gpt-5.6-luna | 739618 | 0 | 7986688 | 14336 | 753954 | 4.0608 | 7998081 | 0 | 329997056 | 734458 |  |
| codex-019fc1af-c03-1785723916-1 | codex | 019fc1af-c03e-72f1-9289-5d2e4380532e | #695 | gpt-5.6-luna | 11133 | 0 | 766464 | 608 | 11741 | 0.2286 | 8009214 | 0 | 330763520 | 735066 |  |
| codex-019fc1af-c03-1785726868-1 | codex | 019fc1af-c03e-72f1-9289-5d2e4380532e | #695 | gpt-5.6-luna | 289457 | 0 | 16770048 | 21159 | 310616 | 5.2335 | 8298671 | 0 | 347533568 | 756225 |  |

### Steering

| steer-key | session | issue | type | tier | user-reason | commit | ordinal | timestamp |
| --- | --- | --- | --- | --- | --- | --- | ---: | ---: |
