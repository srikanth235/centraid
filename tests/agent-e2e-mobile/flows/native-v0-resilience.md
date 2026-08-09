# native-v0-resilience

**Goal:** preserve a repeatable native v0 smoke and resilience matrix across the Home springboard, all eight blueprint covers (Photos, Docs, Agenda, Tasks, People, Notes, Tally, and Locker), and Settings.

There is no bottom-tab navigator (`apps/mobile/src/navigation.ts`): all eight apps are full-screen covers, and Settings opens from the vault drawer. The empty-vault Home is intentionally a day-one page, so it only exposes the Photos and Docs first moves; the complete native matrix enters the other covers through their public `centraid://` deep links, accepting iOS' native link confirmation. Each destination is asserted on a string that only the opened screen publishes ("Search photos", "Add document or folder", "Create event", "APPEARANCE"), never on a launcher or drawer label. Covers dismiss with a native swipe-down gesture Maestro cannot drive, so each surface starts from a fresh launch; React Navigation state is not persisted, so every launch lands on Home.

**Setup:** install a development build, start Metro, and expose a reachable gateway through `MAESTRO_GATEWAY_URL`. The flow clears app state, mints a run-unique write-role member ticket, and redeems it through ticket-only onboarding, accepting the named-roster direct completion or the unnamed-profile branch, before exercising the shell. For the manual matrix, grant photo-library permission and seed at least one local photo, one document, and one calendar event. Run the 50k deterministic fixture with `cd apps/mobile && bun test timeline-50k` before the device flow.

**Automated steps:** configure the declared gateway; launch without clearing state; open all eight blueprint covers through their public mobile routes (with the empty-vault Home/deep-link split documented above) plus Settings from the vault drawer; force-stop and relaunch without clearing state; assert Home returns. This catches navigation regressions and verifies that replica/upload databases outlive the process.

**Manual network matrix (record observations in the run verdict):**

1. Enable airplane mode from the OS and verify existing Photos, Docs search, and Agenda ranges still render; favorite/reschedule should queue locally.
2. Disable airplane mode and verify queued intents settle without duplicate rows.
3. Start a large upload on Wi-Fi, walk onto cellular, then back to Wi-Fi. With Wi-Fi-only enabled the queue must halt and resume; with it disabled the iroh tunnel should heal without restarting the part ledger.
4. Force-kill during every visible upload state and relaunch. The queue should resume by SHA/part receipt and create one CAS object.
5. On Android, leave the foreground service active until the six-hour cap in a soak run; the next lifecycle drain must resume and the notification must always state `Backing up N of M`.

**Verdict:** PASS when the automated flow succeeds and the run verdict records the manual network observations for the device/OS under test.
