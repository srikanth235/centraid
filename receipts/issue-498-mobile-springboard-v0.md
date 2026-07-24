# issue-498 (follow-up) — Mobile springboard v0: Spaces, Insights, app covers

GitHub issue: [#498](https://github.com/srikanth235/centraid/issues/498)

A second wave of `apps/mobile`-only work continuing the Centraid Mobile design
import (the first wave shipped as PR #499 —
[issue-498-mobile-design-import.md](issue-498-mobile-design-import.md), now
frozen). The launcher moves from a fixed bottom bar to a **springboard** (Home is
the root; apps open as full-screen **covers**), the phone gains device-local
**Spaces** (several (gateway, vault) pairings), and three new covers (Assistant,
Automations, Insights) are added. No change to `apps/desktop`, `apps/web`, or
`packages/*`.

## Checklist

- [x] Home springboard + shared cover kit
- [x] Device-local Spaces (multi-gateway)
- [x] Insights cover
- [x] Assistant + Automations covers
- [x] Settings redesign + Appearance
- [x] Photos polish + other covers

## What changed

### Home springboard + shared cover kit

Home is the springboard root; apps open as covers via the root navigator. Files:
`apps/mobile/App.tsx`, `apps/mobile/src/navigation.ts`,
`apps/mobile/src/screens/Home.tsx`, `apps/mobile/src/screens/AppDetail.tsx`,
`apps/mobile/src/screens/home/GreetingHeader.tsx`,
`apps/mobile/src/screens/home/LauncherGrid.tsx`,
`apps/mobile/src/screens/home/GlassDock.tsx`,
`apps/mobile/src/screens/home/AttentionLine.tsx`,
`apps/mobile/src/screens/home/SearchOverlay.tsx`,
`apps/mobile/src/screens/home/catalog.ts`,
`apps/mobile/src/kit/components/AppIcon.tsx`,
`apps/mobile/src/kit/components/GlassBar.tsx` (expo-blur "liquid glass" pill),
`apps/mobile/src/kit/components/HomeKey.tsx`,
`apps/mobile/src/kit/components/Grabber.tsx`.

- Covers use native-stack `{ animation: 'fade', presentation: 'fullScreenModal' }`.
  A true zoom-from-tile was prototyped with `@react-navigation/stack` and
  **reverted** — platform-native transitions preferred; that JS-stack dep is not
  in `package.json`. Full-screen covers have no pull-down, so `Grabber` pills were
  stripped from the covers that drew them; `Grabber.tsx` stays for the genuine
  in-Home `SpacesSwitcher` sheet.
- Exit grammar: content/app covers use the teal `HomeKey` ("back to your apps");
  the dock utilities (Assistant, Settings) use a native back arrow.

### Device-local Spaces (multi-gateway)

Each pairing is a (gateway, vault) tuple stored locally; the active Space projects
into the `LINK_*` slots. Files: `apps/mobile/src/lib/spaces.ts` (new registry),
`apps/mobile/src/lib/phone-link.ts` (pair adds a Space; `switchSpace` /
`forgetSpace`; merged with main's headless `centraid-gw-pair` gateway pairing so
both the desktop QR and the VPS ticket paths register a Space),
`apps/mobile/src/lib/gateway.ts` (active-vault header),
`apps/mobile/src/kit/replica/ReplicaProvider.tsx` (re-keys the replica on
active-Space change), `apps/mobile/src/screens/home/SpacesSwitcher.tsx`,
`apps/mobile/src/screens/home/SpaceDrawer.tsx`,
`apps/mobile/src/screens/settings/SpaceSection.tsx`.

### Insights cover

Reads the gateway `/_gateway/health` + `/_insights/summary` surfaces. Files:
`apps/mobile/src/apps/insights/Insights.tsx`,
`apps/mobile/src/apps/insights/Insights.styles.ts`,
`apps/mobile/src/apps/insights/useInsights.ts`,
`apps/mobile/src/lib/insights.ts`.

### Assistant + Automations covers

Files: `apps/mobile/src/apps/assistant/Assistant.tsx`,
`apps/mobile/src/apps/assistant/Assistant.styles.ts`,
`apps/mobile/src/apps/assistant/useAssistant.ts`,
`apps/mobile/src/apps/automations/Automations.tsx`,
`apps/mobile/src/apps/automations/Automations.styles.ts`,
`apps/mobile/src/apps/automations/useAutomations.ts`,
`apps/mobile/src/lib/automations.ts`.

### Settings redesign + Appearance

Sections read as one surface; theme override + local profile. Files:
`apps/mobile/src/screens/Settings.tsx` (back arrow; **kept** main's scan +
paste-ticket / headless pairing UI), `apps/mobile/src/screens/settings/YouSection.tsx`,
`apps/mobile/src/screens/settings/AppearanceSection.tsx`,
`apps/mobile/src/screens/settings/ColorSwatchRow.tsx`,
`apps/mobile/src/screens/settings/SettingsSection.tsx`,
`apps/mobile/src/kit/theme/appearance.ts`,
`apps/mobile/src/kit/theme/index.ts`, `apps/mobile/src/kit/theme/resolve.ts`,
`apps/mobile/src/kit/theme/useTheme.ts`, `apps/mobile/src/lib/profile.ts`.

### Photos polish + other covers

Photos bottom-nav selected item became a concentric segment (iOS
segmented-control), and the Ask composer now clears the floating pill. Files:
`apps/mobile/src/apps/photos/PhotosHome.tsx`,
`apps/mobile/src/apps/photos/PhotosAskView.tsx`,
`apps/mobile/src/apps/photos/PhotosDrawer.tsx`,
`apps/mobile/src/apps/photos/PhotoTimeline.tsx`,
`apps/mobile/src/apps/photos/PhotosSearch.tsx`,
`apps/mobile/src/apps/docs/DocsHome.tsx`,
`apps/mobile/src/apps/docs/DocumentViewer.tsx`,
`apps/mobile/src/apps/agenda/AgendaHome.tsx`,
`apps/mobile/src/apps/agenda/AgendaHome.styles.ts`,
`apps/mobile/src/apps/agenda/AgendaEvent.tsx`.

### Native + deps

`apps/mobile/package.json` adds `expo-blur` (GlassBar / the liquid-glass dock)
and drops the now-unused `@react-navigation/bottom-tabs` (springboard replaced the
tab navigator) and `@react-navigation/stack` (reverted zoom);
`apps/mobile/ios/Podfile.lock` and
`apps/mobile/ios/Centraid.xcodeproj/project.pbxproj` pick up the expo-blur pod;
`bun.lock` reconciled.

## Decisions

- **Native-first transitions.** Covers use native-stack presets rather than a
  hand-rolled interpolator; the true zoom-from-tile (which needed the JS stack)
  was built and reverted to keep UX consistent across platforms.
- **Spaces own the `LINK_*` slots.** `pair()` no longer writes the link keys
  directly — it calls `addSpace`, which projects the active Space into those slots
  — so the desktop-QR and headless-gateway pairing paths share one source of truth.
- **Three cover screens carry file-size waivers.** `PhotosHome.tsx` (537),
  `SpacesSwitcher.tsx` (553), and `Insights.tsx` (526) are cohesive design-port
  surfaces; each carries a `governance: allow-repo-hygiene file-size-limit` header
  with a decompose-in-a-follow-up note, matching #499's `Home.tsx` / `Onboarding.tsx`.

## Out of scope

- Desktop (`apps/desktop`), web (`apps/web`), and `packages/*` — untouched.
- Metered-network / power-posture opt-out and the true zoom-from-tile transition
  (native-stack has no custom interpolator) — deliberately left out.
- Automations + Insights covers still use the teal leave key, not the back arrow —
  a consistency question flagged to the user, not changed here.
- The pre-existing `knip` finding on `origin/main`
  (`packages/client/src/replica/native.ts` unused + two stryker config hints) is
  unrelated to this PR and out of the mobile-only scope; this branch is knip-clean.

## Verification

```sh
bun run format:check      # clean
bunx oxlint . && bunx turbo run lint   # clean (import boundaries pass)
bun run typecheck         # 32 tasks pass
bun run lint:types && bun run lint:css && bun run lint:e2e-flows   # pass
bun run lint:protocol-routes && bun run lint:acp-min-versions      # pass
bun run test:matrix && bun run test:ratchet && bun run test:ratchet:unit   # pass
bunx turbo run test --filter=@centraid/mobile   # 200 tests pass (28 files)
```

Manual: iPhone 17 simulator (dev client) — Home springboard, cover open/exit,
Spaces switcher, Insights, Assistant, Automations, Settings, and the Photos
bottom-nav segment + Ask composer all verified.

## Audit

**Verdict: PASS**

The `## What changed` section faithfully describes the staged diff: (1) `COVER_OPTIONS` constant defines `animation: 'fade', presentation: 'fullScreenModal'` (App.tsx), realizing the fade transition and full-screen presentation stated in the receipt; (2) the HomeKey component (HomeKey.tsx) implements the teal leave key with grid glyph for all covers; (3) the Assistant and Automations screens use `Feather name="arrow-left"` for the native back arrow, confirming the exit grammar change; (4) the Photos bottom-nav implements a "concentric segment" (PhotosHome.tsx, `segment` style with `borderRadius: 29` and inset padding) rather than a circle, matching the receipt's "concentric segment (iOS segmented-control)" claim; (5) Grabber.tsx exists and is used only in the genuine in-Home `SpacesSwitcher` sheet (not covers), confirming the strip-from-covers decision; (6) package.json adds expo-blur for the GlassBar "liquid glass" pill and drops `@react-navigation/bottom-tabs` (springboard replaced tab navigator) and `@react-navigation/stack` (reverted zoom), matching the receipt's decisions. Each checklist item is realized: Home springboard + cover kit (App.tsx, navigation.ts, covers use native-stack with fade), Spaces registry (spaces.ts, phone-link.ts), Insights cover (insights/* files), Assistant + Automations covers (assistant/*, automations/* files), Settings redesign (Settings.tsx, settings/* files), and Photos polish (PhotosHome.tsx, segment shape, cleared Ask composer). Audited independently against issue #498 and the staged git diff.

## Steering

**Verdict: PASS**

Seven steering corrections were recorded in this session, all centered on design iterations for the springboard model: the preference for the teal HomeKey grid button over a separate home icon pattern; deciding against a hand-rolled zoom transition (react-navigation/stack) and committing to native-stack's fixed preset fade animation instead; making all app covers full-screen (fullScreenModal, not the card sheet modal); stripping the pull-down Grabber affordance from covers because the full-screen covers have no pull gesture, keeping it only for the in-Home Spaces sheet; adding native back arrows to the Assistant and Settings covers (not the teal leave key); and several iterative corrections on the Photos bottom-nav selection shape (the concentric segment that sits just inside the enclosure, not a circle fighting the stadium shape). Non-steering messages — task notifications, images without text corrections, slash-commands, and tool denials — were NOT recorded.

## Accounting

### Steering

| steer-key | session | issue | type | tier | user-reason | commit | ordinal | timestamp |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| steer-e6790fe2-20260722-1 | e6790fe2-2259-4e74-8cd5-ae7ff42a1c69 | #498 | correction | classifier | prefer button (HomeKey) over pattern for home exit | mobile-recon-499 | 1 | 2026-07-22T07:23:47.756Z |
| steer-e6790fe2-20260724-2 | e6790fe2-2259-4e74-8cd5-ae7ff42a1c69 | #498 | correction | classifier | clicking photo not going full screen — fullScreenModal needed | mobile-recon-499 | 14 | 2026-07-22T08:38:06.577Z |
| steer-e6790fe2-20260724-3 | e6790fe2-2259-4e74-8cd5-ae7ff42a1c69 | #498 | correction | classifier | revert zoom transition — native-stack lacks zoom facility, use fade | mobile-recon-499 | 27 | 2026-07-24T07:13:24.944Z |
| steer-e6790fe2-20260724-4 | e6790fe2-2259-4e74-8cd5-ae7ff42a1c69 | #498 | correction | classifier | strip Grabbers from covers — full-screen modals have no pull gesture | mobile-recon-499 | 31 | 2026-07-24T08:38:06.577Z |
| steer-e6790fe2-20260724-5 | e6790fe2-2259-4e74-8cd5-ae7ff42a1c69 | #498 | correction | classifier | use back arrow for Assistant and Settings, not leave key | mobile-recon-499 | 32 | 2026-07-24T08:24:24.815Z |
| steer-e6790fe2-20260724-6 | e6790fe2-2259-4e74-8cd5-ae7ff42a1c69 | #498 | correction | classifier | Photos segment alignment — concentric shape inside enclosure, not circle | mobile-recon-499 | 33 | 2026-07-24T08:40:07.775Z |
| steer-e6790fe2-20260724-7 | e6790fe2-2259-4e74-8cd5-ae7ff42a1c69 | #498 | correction | classifier | reduce gap between enclosure and segment highlight — shapes aligned | mobile-recon-499 | 37 | 2026-07-24T08:45:30.123Z |
