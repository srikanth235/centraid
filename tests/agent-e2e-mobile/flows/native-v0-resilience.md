# native-v0-resilience

**Goal:** preserve a repeatable native v0 smoke and resilience matrix across
the Home, Photos, Docs, Agenda, and Settings families.

Note the tab is **Home**, not "Apps". The route is registered as `Apps` (see
`navigation.ts` and Settings' `navigate('Apps', …)`), but it renders as "Home",
and an earlier version of this flow asserted the route name — matching nothing.
Each tab is also verified by a string unique to the screen it opens rather than
by its own label: the label is in the tab bar on every screen, so
`tapOn: "Docs"` + `assertVisible: "Docs"` passes even when the tap does nothing.

**Setup:** install a development build, start Metro, and expose a reachable
gateway through `MAESTRO_GATEWAY_URL`. The flow clears app state and saves that
gateway through Settings → Advanced before exercising the shell. For the manual
matrix, grant photo-library permission and seed at least one local photo, one
document, and one calendar event. Run the 50k deterministic fixture with
`cd apps/mobile && bun test timeline-50k` before the device flow.

**Automated steps:** configure the declared gateway; launch without clearing
state; visit all five tabs; open Photos again; force-stop and relaunch without
clearing state; assert the local Photos surface returns. This catches navigation
regressions and verifies that replica/upload databases outlive the process.

**Manual network matrix (record observations in the run verdict):**

1. Enable airplane mode from the OS and verify existing Photos, Docs search,
   and Agenda ranges still render; favorite/reschedule should queue locally.
2. Disable airplane mode and verify queued intents settle without duplicate
   rows.
3. Start a large upload on Wi-Fi, walk onto cellular, then back to Wi-Fi. With
   Wi-Fi-only enabled the queue must halt and resume; with it disabled the iroh
   tunnel should heal without restarting the part ledger.
4. Force-kill during every visible upload state and relaunch. The queue should
   resume by SHA/part receipt and create one CAS object.
5. On Android, leave the foreground service active until the six-hour cap in a
   soak run; the next lifecycle drain must resume and the notification must
   always state `Backing up N of M`.

**Verdict:** PASS when the automated flow succeeds and the run verdict records
the manual network observations for the device/OS under test.
