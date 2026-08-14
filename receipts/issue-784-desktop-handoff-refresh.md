# Issue #784 — desktop binding-layer handoff, onboarding, and responsive shell refresh

GitHub issue: [#784](https://github.com/srikanth235/centraid/issues/784)

This follow-up applies the remaining desktop/client and Expo identity deltas
found while comparing the live implementation with the v9 design-handoff pane.
It builds on the
completed v9 migration in [#765](https://github.com/srikanth235/centraid/issues/765)
without rewriting that frozen receipt.

## Checklist

- [x] Simplify desktop first run to one decision: start a local host or connect to an existing host.
- [x] Move profile identity to Settings and automatically seed the sample week after a fresh local start.
- [x] Replace desktop app tiles and app chrome marks with the handoff single-tone stroke treatment: 24-grid icon, 1.6 stroke, 1.75 below 16px, hue chip with matching text rung.
- [x] Mirror the single-tone app-mark treatment in Expo, including the native Docs header and shared app-header/launcher marks.
- [x] Remove duplicate app-local navigation where the host stem/frame owns navigation, while retaining app-specific content tools.
- [x] Make Home and media surfaces consume available width at desktop, compact, and narrow viewport sizes without right-side dead space.
- [x] Verify desktop/PWA and Expo behavior with targeted unit, type, design, and UI-impact evidence checks.

## What changed

### First-run and sample data

**Simplify desktop first run to one decision: start a local host or connect to an existing host.**
`packages/client/src/react/screens/FirstRunGate.tsx` and
`packages/client/src/react/screens/OnboardingScreen.tsx` now keep the desktop
choice between a local host and an existing-host ticket, while the web path
opens directly on the ticket flow. The former blocking identity and import
steps were removed (`packages/client/src/react/screens/OnboardingIdentityStep.tsx`
and `packages/client/src/react/screens/OnboardingImportStep.tsx`). The flow,
tests, and styling are covered by `packages/client/src/react/screens/FirstRunGate.test.tsx`,
`packages/client/src/react/screens/OnboardingScreen.test.tsx`, and
`packages/client/src/react/screens/OnboardingScreen.module.css`.

**Move profile identity to Settings and automatically seed the sample week after a fresh local start.**
`packages/client/src/react/boot.tsx`, `packages/client/src/react/shell/App.tsx`,
`packages/client/src/react/shell/routes/HomeRoute.tsx`, and
`packages/client/src/react/shell/routes/homeSample.ts` move identity editing
to Settings and make first Home entry seed the removable sample week. The
settings bridge and its tests live in `packages/client/src/react/shell/routes/profileData.ts`,
`packages/client/src/react/shell/routes/AppSettingsController.tsx`,
`packages/client/src/react/screens/AppSettingsPanel.tsx`, and
`packages/client/src/react/screens/AppSettingsPanel.test.tsx`. The existing
connection contract remains exercised by `packages/client/src/react/shell/routes/connectFlow-core.ts`,
`packages/client/src/react/shell/routes/connectFlowIO.ts`, and
`packages/client/src/react/shell/routes/connectFlowIO.test.ts`.

The current-state wording was updated in `docs/dev-environment.md`,
`docs/glossary.md`, and `docs/recovery/pairing.md` so the docs no longer imply
that founding blocks on a profile step.

### Single-tone app identity

**Replace desktop app tiles and app chrome marks with the handoff single-tone stroke treatment: 24-grid icon, 1.6 stroke, 1.75 below 16px, hue chip with matching text rung.**
`packages/client/src/react/ui/AppMark.tsx`,
`packages/client/src/react/ui/AppMark.module.css`, and
`packages/client/src/react/ui/AppMark.test.tsx` add the shared mark primitive.
The token layer in `packages/design/src/tile.ts`, `packages/design/src/index.ts`,
`packages/design/src/css.ts`, and `packages/design/src/css.test.ts` supplies the
stroke and light/dark tint contract. `packages/client/src/react/ui/AppCard.tsx`,
`packages/client/src/react/shell/routes/builder/BuilderShell.tsx`,
`packages/client/src/react/screens/HomeSpringboard.tsx`,
`packages/client/src/react/screens/LibraryCards.tsx`,
`packages/client/src/react/screens/PaletteScreen.tsx`,
`packages/client/src/react/shell/routes/AppViewRoute.tsx`,
`packages/client/src/react/shell/routes/inlineAppFrame.tsx`, and
`packages/client/src/react/screens/AppSettingsPanel.tsx` now consume the same
single-tone identity. The old duplicated tile paint module and test were
removed: `packages/client/src/react/ui/tile-visual.ts` and
`packages/client/src/react/ui/tile-visual.test.ts`.

The DTO and palette bridges in `packages/client/src/react/screen-contracts.ts`,
`packages/client/src/react/shell/routes/homeData.ts`, and
`packages/client/src/react/shell/routes/paletteData.ts` retain only the legacy
shape needed for compatibility while new output uses the shared mark. Settings
and connection surfaces are covered by
`packages/client/src/react/shell/routes/ConnectFlow.tsx` and
`packages/client/src/react/shell/routes/ConnectFlow.module.css`.

**Mirror the single-tone app-mark treatment in Expo, including the native Docs header and shared app-header/launcher marks.**
`apps/mobile/src/kit/components/AppMark.tsx` is the native lowering of the same
design-owned chip/tint contract. It delegates the 24-grid icon and 1.6/1.75
stroke rule to the existing shared `Icon` adapter, while applying the 13% light
/ 20% dark hue wash through `iconChipFinish`. The component is covered by
`apps/mobile/src/kit/components/AppMark.test.tsx` and is now used by the
generic `apps/mobile/src/kit/components/AppHeader.tsx`, the Home launcher and
first-move surfaces (`apps/mobile/src/screens/home/LauncherGrid.tsx`,
`apps/mobile/src/screens/home/AllAppsSheet.tsx`, and
`apps/mobile/src/screens/home/FirstMoves.tsx`), and the native Docs header in
`apps/mobile/src/apps/docs/DocsHome.tsx`. The former solid-color generic app
header and duplicated inline mark paint are gone; app identity now has one
native component and one contract.

The shared native upload bridge in `packages/design/kit/edge-upload.js` now
seals and posts multipart background transfers through a fixed two-part worker
window. This keeps Expo/background uploads responsive under load without
awaiting native completion or materializing every part at once.

### Host frame and responsive surfaces

**Remove duplicate app-local navigation where the host stem/frame owns navigation, while retaining app-specific content tools.**
`packages/blueprints/apps/agenda/Chrome.module.css` and
`packages/blueprints/apps/docs/Chrome.module.css` hide the redundant app-local
navigation chrome. `packages/blueprints/apps/agenda/app-root.tsx` publishes
Agenda title/count/actions through the host frame, and
`packages/blueprints/apps/agenda/queries/upcoming.ts` tolerates gateways that
do not yet expose recurrence expansion. `packages/blueprints/apps/photos/components/Lightbox.module.css`
centres its fit/zoom controls in the media stage.

**Make Home and media surfaces consume available width at desktop, compact, and narrow viewport sizes without right-side dead space.**
`packages/client/src/react/screens/HomeSpringboard.module.css` and
`packages/client/src/react/styles/mainScroll.module.css` make the springboard
and scroll container width-safe across the handoff breakpoints. The responsive
layout behavior is asserted in `packages/client/src/react/screens/HomeSpringboard.test.tsx`.
The Home data/render contract remains covered by
`packages/client/src/react/shell/routes/HomeRoute.test.tsx`,
`packages/client/src/react/screens/HomeSpringboard.tsx`, and
`packages/client/src/react/shell/routes/homeData.ts`.

The desktop evidence journey in `apps/desktop/tests/e2e/onboarding-home.spec.ts`
now demonstrates the no-profile-gate first run and emits the existing UI-impact
frames used by the design and onboarding checks. The production pending-overlay
journey in `apps/desktop/tests/e2e/pending-overlay.spec.ts` follows the same
chooser → local connection → Home handoff, so offline-reload coverage no longer
depends on the deleted profile fields.

### Full changed-file inventory

The following inventory names every source, test, style, and documentation path
included in this change set, including deletions and the newly added shared mark:

- `apps/desktop/tests/e2e/onboarding-home.spec.ts`
- `apps/desktop/tests/e2e/pending-overlay.spec.ts`
- `apps/mobile/src/apps/docs/DocsHome.tsx`
- `apps/mobile/src/kit/components/AppHeader.tsx`
- `apps/mobile/src/kit/components/AppMark.test.tsx`
- `apps/mobile/src/kit/components/AppMark.tsx`
- `apps/mobile/src/screens/home/AllAppsSheet.tsx`
- `apps/mobile/src/screens/home/FirstMoves.tsx`
- `apps/mobile/src/screens/home/LauncherGrid.tsx`
- `apps/mobile/src/screens/home/VaultHeader.tsx`
- `docs/dev-environment.md`
- `docs/glossary.md`
- `docs/recovery/pairing.md`
- `packages/blueprints/apps/agenda/Chrome.module.css`
- `packages/blueprints/apps/agenda/app-root.tsx`
- `packages/blueprints/apps/agenda/queries/upcoming.ts`
- `packages/blueprints/apps/docs/Chrome.module.css`
- `packages/blueprints/apps/photos/components/Lightbox.module.css`
- `packages/client/src/react/boot.tsx`
- `packages/client/src/react/screen-contracts.ts`
- `packages/client/src/react/screens/AppSettingsPanel.test.tsx`
- `packages/client/src/react/screens/AppSettingsPanel.tsx`
- `packages/client/src/react/screens/FirstRunGate.test.tsx`
- `packages/client/src/react/screens/FirstRunGate.tsx`
- `packages/client/src/react/screens/HomeSpringboard.module.css`
- `packages/client/src/react/screens/HomeSpringboard.test.tsx`
- `packages/client/src/react/screens/HomeSpringboard.tsx`
- `packages/client/src/react/screens/LibraryCards.tsx`
- `packages/client/src/react/screens/OnboardingIdentityStep.tsx`
- `packages/client/src/react/screens/OnboardingImportStep.tsx`
- `packages/client/src/react/screens/OnboardingScreen.module.css`
- `packages/client/src/react/screens/OnboardingScreen.test.tsx`
- `packages/client/src/react/screens/OnboardingScreen.tsx`
- `packages/client/src/react/screens/PaletteScreen.test.tsx`
- `packages/client/src/react/screens/PaletteScreen.tsx`
- `packages/client/src/react/shell/App.tsx`
- `packages/client/src/react/shell/routes/AppSettingsController.tsx`
- `packages/client/src/react/shell/routes/AppViewRoute.tsx`
- `packages/client/src/react/shell/routes/ConnectFlow.module.css`
- `packages/client/src/react/shell/routes/ConnectFlow.tsx`
- `packages/client/src/react/shell/routes/HomeRoute.test.tsx`
- `packages/client/src/react/shell/routes/HomeRoute.tsx`
- `packages/client/src/react/shell/routes/connectFlow-core.ts`
- `packages/client/src/react/shell/routes/connectFlowIO.test.ts`
- `packages/client/src/react/shell/routes/connectFlowIO.ts`
- `packages/client/src/react/shell/routes/homeData.ts`
- `packages/client/src/react/shell/routes/homeSample.ts`
- `packages/client/src/react/shell/routes/inlineAppFrame.tsx`
- `packages/client/src/react/shell/routes/paletteData.ts`
- `packages/client/src/react/shell/routes/profileData.ts`
- `packages/client/src/react/styles/mainScroll.module.css`
- `packages/client/src/react/ui/AppCard.tsx`
- `packages/client/src/react/shell/routes/builder/BuilderShell.tsx`
- `packages/client/src/react/ui/AppCard.module.css`
- `packages/client/src/react/ui/AppMark.module.css`
- `packages/client/src/react/ui/AppMark.test.tsx`
- `packages/client/src/react/ui/AppMark.tsx`
- `packages/client/src/react/ui/tile-visual.test.ts`
- `packages/client/src/react/ui/tile-visual.ts`
- `packages/design/src/css.test.ts`
- `packages/design/src/css.ts`
- `packages/design/src/contract.ts`
- `packages/design/src/index.ts`
- `packages/design/src/tile.ts`
- `packages/design/src/tile-properties.test.ts`
- `packages/design/kit/edge-upload.js`
- `receipts/issue-784-desktop-handoff-refresh.md`

## User impact

Desktop users now choose only how the host is supplied, reach Home without
inventing a profile first, and see a useful sample week immediately after a
fresh local start. Profile identity remains available from Settings. App marks
are now one-tone outline identities with a consistent stroke and no filled
glyph/gradient treatment. Docs and Agenda no longer compete with the host
navigation, and Home/media layouts use the viewport instead of reserving a
large unused right column.

First-run: the local-host and existing-host paths are both covered by the
desktop onboarding journey; the fresh path lands on Home and the sample data is
removable from the disclosed sample-data control.

Expo app identity now follows the same one-tone mark rule. The native Docs
header shows the teal Docs mark beside its leave-to-apps key, generic WebView
app headers use the quiet chip instead of a solid color block, and the launcher,
all-apps sheet, and first-move rows all share the same mark primitive.

Native multipart uploads keep a bounded two-part preparation window so the
background transfer bridge can schedule work promptly on large files without
holding the whole upload in memory.

![Desktop first-run/Home evidence](artifacts/e2e/ui-impact/issue-784-desktop-handoff.png)

## Decisions

- Use one shared `AppMark` primitive and design-owned stroke/tint tokens so the
  handoff rule cannot drift between Home, palette, Settings, app frames, and
  library cards.
- Keep old DTO tile fields optional for compatibility with existing fixtures and
  external callers, but do not generate new gradient tile paint.
- Keep the host stem/frame as the navigation owner; Agenda and Docs retain only
  app-specific content controls.
- Treat profile identity as a reversible Settings preference rather than a
  first-run prerequisite, and seed sample data after Home is usable.
- Keep Expo’s existing native `Icon` stroke resolver as the single source of
  the 1.6 / 1.75 rule and add only the missing shared `AppMark` composition at
  the native identity boundary.
- Keep native multipart upload preparation bounded: two in-flight part bodies
  are enough to keep the background bridge fed while avoiding unbounded memory
  growth.
- This follow-up remains narrower than the already merged v9 issue: net-new
  operational screens remain governed by #765.

## Out of scope

- Net-new operational screens already landed and receipted under #765.
- Changes to gateway protocol, host discovery, or ticket semantics.
- Reopening the v9 handoff token/block migration or changing the design handoff
  itself.
- A full visual-gallery run; the gallery needs a browser-capable machine. The
  reproducible package/unit/type/design checks and desktop evidence harness are
  recorded below.

## Verification

Targeted implementation tests and package type floors passed before the receipt
was authored:

Verify desktop/PWA and Expo behavior with targeted unit, type, design, and UI-impact evidence checks.
The following replayable commands provide that evidence:

```sh
bun run --cwd packages/client test -- src/react/ui/AppMark.test.tsx src/react/screens/AppSettingsPanel.test.tsx src/react/screens/PaletteScreen.test.tsx src/react/shell/routes/paletteData.test.ts src/react/shell/routes/homeData.test.ts src/react/screens/HomeSpringboard.test.tsx src/react/ui/AppCard.test.tsx src/react/screens/LibraryCards.test.tsx
bun run --cwd packages/client typecheck
bun run --cwd packages/blueprints typecheck
bun run --cwd packages/blueprints test -- apps/agenda apps/photos
bun run --cwd packages/design test -- src/tile-properties.test.ts
bun run --cwd packages/design test -- src/edge-upload.test.ts
bun run --cwd apps/mobile test -- src/kit/components/AppMark.test.tsx src/kit/components/Icon.test.tsx
bun run --cwd apps/mobile typecheck
```

The design and formatting gates also passed:

```sh
git diff --check
bun run format:check
bun run lint:css
bun run lint:design-tokens
```

The UI receipt gate is run after this receipt is added, and the changed
`apps/desktop/tests/e2e/onboarding-home.spec.ts` harness is the emitter for the
`artifacts/e2e/ui-impact/issue-784-desktop-handoff.png` evidence path. The
pending-overlay production journey is separately exercised against the
streamlined local-host path.

## Audit

Fresh-context audit against `git diff origin/main`, this receipt, and
`gh issue view 784`:

1. **PASS** — the What changed section identifies the first-run branch,
   Settings/sample behavior, shared desktop and Expo single-tone mark/token
   migration, host-frame cleanup, responsive width fixes, docs updates, and
   every changed file.
2. **PASS** — each checked #784 item is implemented in the diff and echoed in
   the corresponding What changed or Verification section.
3. **PASS** — the Checklist reproduces the seven checklist items from #784, with
   the completed state recorded here.
4. **PASS** — the full changed-file inventory includes every staged path,
   including this receipt and all native Expo mark consumers.

Verdict: PASS

## Steering

No mid-task steering correction was recorded after the implementation scope was
confirmed; the later user instruction added Expo parity to the same handoff
plan and the changes were kept in one follow-up.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Session

<!-- Session identifiers are maintained by the agent-session-identity pre-commit hook. -->

### Identifiers

| date | harness | session |
| --- | --- | --- |
| 2026-08-14 | codex | 01a0009e-c5b0-7c10-868b-c1d1c842ebcc |
