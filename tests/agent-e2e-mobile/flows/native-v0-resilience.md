# native-v0-resilience

**Goal:** preserve a repeatable native v0 smoke and resilience matrix across
the Home springboard and the Photos, Docs, Agenda, and Settings surfaces.

There is no bottom-tab navigator (`apps/mobile/src/navigation.ts`): Photos,
Docs and Agenda are full-screen covers launched from Home's tiles, and Settings
opens from the glass dock. Each surface is therefore entered the way a user
enters it — by the tile's `Open <name>` accessibility label — and asserted on a
string that only the opened SCREEN publishes ("Search photos",
"Add document or folder", "Create event", "APPEARANCE"), never on the tile or
dock label, which is on Home whether or not the tap did anything. Covers dismiss
with a native swipe-down gesture Maestro cannot drive, so each surface starts
from a fresh launch; React Navigation state is not persisted, so every launch
lands on Home.

**Setup:** install a development build, start Metro, and expose a reachable
gateway through `MAESTRO_GATEWAY_URL`. The flow clears app state, mints a
run-unique write-role member ticket, and redeems it through ticket-only
onboarding before exercising the shell. For the manual matrix, grant
photo-library permission and seed at least one local photo, one document, and
one calendar event. Run the 50k deterministic fixture with `cd apps/mobile &&
bun test timeline-50k` before the device flow.

**Automated steps:** configure the declared gateway; launch without clearing
state; open each of the four surfaces from Home; force-stop and relaunch without
clearing state; assert Home returns. This catches navigation
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
