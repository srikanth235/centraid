# issue-498 — Port the "Centraid Mobile" design into the Expo app (onboarding, home launcher, photos)

GitHub issue: [#498](https://github.com/srikanth235/centraid/issues/498)

Imported the **Centraid Mobile** claude.ai/design project and implemented it in
`apps/mobile` **only** — desktop (`apps/desktop`) and web (`apps/web`) are
untouched. The design is a **launcher model**: the Home screen and each app
screen carry their own bottom bar, and Photos is a single screen with a
four-view internal switch. Onboarding is an always-dark first-run flow; light
mode across the app uses the design's warm parchment ("solar") palette.

The design `.dc.html` can only be read as source, not rendered standalone (the
DesignSync `get_file` tool hard-caps at 256 KiB and the file is ~267 KB, so its
runtime logic is truncated). Implementation was built from the design markup and
verified against the design screenshots on an iPhone 17 simulator.

## Checklist

- [x] Onboarding + first-run
- [x] Home launcher
- [x] Photos — four views + drawer
- [x] Solar light theme

## What changed

### Onboarding + first-run

Files: `apps/mobile/src/lib/profile.ts` (new),
`apps/mobile/src/screens/Onboarding.tsx` (new), `apps/mobile/App.tsx`,
`apps/mobile/src/kit/theme/index.ts`, `apps/mobile/package.json`, `bun.lock`.

- Local profile state (name / accent color / onboarded) in the AsyncStorage
  `Store`; `BRAND_TEAL #128A78` for the avatar and greeting highlight.
- `Onboarding.tsx` — always-dark welcome → identity → (recover) → pair → done;
  pair reuses `expo-camera` + `pair()`.
- `App.tsx` gates render on `profile.onboarded`, loads Playfair Display, and
  **hides the OS tab bar** (`tabBarStyle:{display:'none'}`) so screens render
  the design's own bottom bars while the tab navigator stays a route container.
- Added `@expo-google-fonts/playfair-display` (JS asset — no native rebuild);
  `family.serif` / `family.serifItalic` in `kit/theme`.

### Home launcher

Files: `apps/mobile/src/screens/Home.tsx`,
`apps/mobile/src/kit/components/Logo.tsx` (deleted).

- Greeting header (date eyebrow, "Good morning," in Playfair serif, name in
  Playfair italic teal, initials avatar), 4-up squircle app grid, Automations
  row, and the fixed Approvals / Search / Assistant (FAB) / Settings / Gateway
  bottom bar. Real gateway app-loading preserved.
- Removed the old pinwheel `Logo` mark — the launcher header no longer uses it,
  which orphaned the file (knip, the strict dead-code gate, flagged it).

### Photos — four views + drawer

Files: `apps/mobile/src/apps/photos/PhotosHome.tsx`,
`apps/mobile/src/apps/photos/PhotosDrawer.tsx` (new),
`apps/mobile/src/apps/photos/PhotosCollectionsView.tsx` (new),
`apps/mobile/src/apps/photos/PhotosCreateView.tsx` (new),
`apps/mobile/src/apps/photos/PhotosAskView.tsx` (new).

- One screen with a `view` switch (Photos timeline + memory hero / Collections /
  Create / Ask) and a Photos / Collections / Create / Home bottom nav (ochre
  active). Selection, backup, and on-this-day logic preserved.
- The ☰ button opens the design's slide-in drawer (RN `Modal` + `Animated`
  translateX slide + fade scrim): profile header, Switch-vault pill, storage
  card, "More from Photos" (Backup + On badge, Free up space on device, Your
  data in Centraid), and a Home / Settings footer.

### Solar light theme

Files: `apps/mobile/src/kit/theme/resolve.ts`,
`apps/mobile/src/kit/theme/resolve.test.ts`.

- Overrode the light ramp with the design's warm palette (canvas `#f1ece1`,
  elevated `#fbf8f1`, sunken `#e7dfcf`, warm inks, warm hairlines; indigo accent
  unchanged) in `resolve.ts`, which feeds both `useTheme()` and the React
  Navigation theme — so the whole mobile app goes warm in light mode.
- Did **not** touch `tokens.generated.ts` (generated) or the shared
  `packages/blueprints/kit/tokens.css` (desktop + web read it). Dark mode left
  as-is (already ≈ the design's `#14171C`).

## Decisions

- **Launcher model via a hidden OS tab bar.** The design gives Home and each app
  screen its own bottom bar. Rather than rewrite the navigator, the tab bar is
  hidden (`tabBarStyle:{display:'none'}`) and the tab navigator stays a route
  container — zero churn to Docs/Agenda/Settings nav types.
- **Solar light theme applied app-wide, not per-screen.** The design's warm
  palette is a whole-app identity, so it is injected once in `resolve.ts` (which
  feeds `useTheme()` and the nav theme) instead of touching the generated
  palette or the shared `tokens.css` desktop + web read. All mobile screens go
  warm in light mode; that is intentional, not scope creep.
- **Drawer storage figures are static.** "0.86 GB of 5 TB" and the 6% bar mirror
  the design mock; no storage-accounting API exists on the phone yet, so they
  are placeholders rather than fabricated live numbers.
- **`Home.tsx` (549) and `Onboarding.tsx` (632) carry file-size-limit waivers.**
  Both are cohesive design-port screens; splitting them into subcomponents is
  sensible follow-up but was deferred to avoid re-refactoring already
  simulator-verified UI in this PR. Waivers are documented in each file's header.

## Out of scope

- Desktop (`apps/desktop`) and web (`apps/web`) — untouched.
- Re-skinning non-Photos blueprint apps beyond inheriting the shared theme.
- Live storage accounting — the drawer's "0.86 GB of 5 TB" and 6% bar are the
  design's static mock values; no storage API is wired yet.

## Verification

```sh
bun run check:pr          # format, oxlint, sherif, turbo lint, typecheck, knip, test:matrix
bunx turbo run test --filter=@centraid/mobile   # 196 tests pass (27 files)
```

Manual: iPhone 17 simulator (`bun expo start`, dev build) — onboarding, Home,
Photos + all four views, and the drawer render faithfully to the design in both
light (warm parchment) and dark.

## Audit
**Verdict: PASS**

The staged diff faithfully realizes all four checklist items. Onboarding is implemented in `Onboarding.tsx` (633 lines, with governance waiver) and `profile.ts` (73 lines) for local profile state (name, accent color, onboarded flag); `App.tsx` gates first-run render on profile hydration and hides the OS tab bar. Home launcher is in `Home.tsx` (549 lines, with waiver) rendering the serif greeting, app grid, automations row, and bottom bar; `Logo.tsx` (26 lines) was deleted as it orphaned when the pinwheel mark was removed. Photos is decomposed into four views (`PhotosAskView.tsx`, `PhotosCollectionsView.tsx`, `PhotosCreateView.tsx`, and new-except-home) plus `PhotosDrawer.tsx` (275 lines) with the slide-in navigation drawer. Solar light theme is implemented in `resolve.ts` via the `SOLAR_LIGHT` constant with warm palette values (`#f1ece1` canvas, `#fbf8f1` elevated, `#e7dfcf` sunken, warm inks) and is NOT applied to shared `tokens.css`; `resolve.test.ts` was updated to cover the theme. Changes are confined to `apps/mobile`, `package.json` added `@expo-google-fonts/playfair-display`, and `bun.lock` was regenerated. Receipt structure matches the issue scope exactly.

— audited independently against issue #498 and the staged `git diff --cached`.

## Steering
**Verdict: PASS**

Eight steering events were recorded: two user interrupts (ordinals 419, 644) and six corrections redirecting the agent on verify-against-upstream, expo-build fallthrough, unbuilt home+photos screens, missed sidebar, and solar light mode. Non-steering messages (images, task-notifications, and slash-commands) were not recorded.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code-8873d135-a2e-1784657576-1 | claude-code | 8873d135-a2e7-4294-829d-84c0e0d8e73e | #498 | claude-opus-4-8 | 1088 | 2682304 | 141096993 | 615030 | 3298422 | 102.6941 | 1088 | 2682304 | 141096993 | 615030 | feat(mobile): always-dark onboarding flow + first-run profile (#498)Port the "Ce |
| claude-code-8873d135-a2e-1784658079-1 | claude-code | 8873d135-a2e7-4294-829d-84c0e0d8e73e | #498 | claude-opus-4-8 | 74 | 104724 | 8692445 | 54455 | 159253 | 6.3625 | 1162 | 2787028 | 149789438 | 669485 | feat(mobile): port the Centraid Mobile design — onboarding, home launcher, photo |
| claude-code-8873d135-a2e-1784658163-1 | claude-code | 8873d135-a2e7-4294-829d-84c0e0d8e73e | #498 | claude-opus-4-8 | 18 | 14916 | 2088849 | 9279 | 24213 | 1.3697 | 1180 | 2801944 | 151878287 | 678764 | feat(mobile): port the Centraid Mobile design — onboarding, home launcher, photo |
| claude-code-8873d135-a2e-1784658221-1 | claude-code | 8873d135-a2e7-4294-829d-84c0e0d8e73e | #498 | claude-opus-4-8 | 3 | 15849 | 703860 | 3291 | 19143 | 0.5333 | 1183 | 2817793 | 152582147 | 682055 | feat(mobile): port Centraid Mobile design — onboarding, home, photos, solar ligh |

### Steering

| steer-key | session | issue | type | tier | user-reason | commit | ordinal | timestamp |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| steer-8873d135-1784657976-1 | 8873d135-a2e7-4294-829d-84c0e0d8e73e | #498 | correction | classifier | compare screenshots vs upstream | PENDING | 285 | 2026-07-21T16:34:51.501Z |
| steer-8873d135-1784657976-2 | 8873d135-a2e7-4294-829d-84c0e0d8e73e | #498 | interrupt | structural |  | PENDING | 419 | 2026-07-21T16:43:32.903Z |
| steer-8873d135-1784657976-3 | 8873d135-a2e7-4294-829d-84c0e0d8e73e | #498 | correction | classifier | can expo be used | PENDING | 422 | 2026-07-21T16:43:39.021Z |
| steer-8873d135-1784657976-4 | 8873d135-a2e7-4294-829d-84c0e0d8e73e | #498 | correction | classifier | build failed | PENDING | 542 | 2026-07-21T16:53:44.633Z |
| steer-8873d135-1784657976-5 | 8873d135-a2e7-4294-829d-84c0e0d8e73e | #498 | interrupt | structural |  | PENDING | 644 | 2026-07-21T17:00:07.134Z |
| steer-8873d135-1784657976-6 | 8873d135-a2e7-4294-829d-84c0e0d8e73e | #498 | correction | classifier | only onboarding done - build home+photos | PENDING | 647 | 2026-07-21T17:01:31.055Z |
| steer-8873d135-1784657976-7 | 8873d135-a2e7-4294-829d-84c0e0d8e73e | #498 | correction | classifier | you missed the sidebar | PENDING | 867 | 2026-07-21T17:26:01.224Z |
| steer-8873d135-1784657976-8 | 8873d135-a2e7-4294-829d-84c0e0d8e73e | #498 | correction | classifier | implement solar light mode | PENDING | 1061 | 2026-07-21T17:37:30.578Z |
