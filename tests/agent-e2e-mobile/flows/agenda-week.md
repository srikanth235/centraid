# agenda-week

**Goal:** prove the phone's Agenda seat over the real seeded week — the Day surface draws its own chrome, the Schedule surface's forward window carries the seeded events out of the replica, and a card opens the event's own screen with the vault's description on it.

**Setup:** `ctx.ensureDemo("agenda")` runs before pairing, so the initial replica clone holds the deterministic week (`packages/blueprints/apps/agenda/seed.js`: five events derived from the gateway's own clock — something today, a weekly recurring run with a reminder, dinner two days out, a deadline three days out, and a dentist next week). The flow then pairs via `ctx.configureGateway()`.

**Steps:** open Agenda from Home's launcher tile, observe the Day surface's two header actions, switch to **Schedule**, observe two seeded events in its forward window, open the dinner card, and observe the event screen's back control, the seeded description, and the two acts the screen offers.

**Expectations:**

1. **The Day surface is the arrival.** `Go to today` and `New event` (`AgendaHome.tsx:311`, `:318`) are published by the Agenda home header alone — neither is a tab label and neither renders anywhere else in the app.
2. **The Schedule window reads the replica.** `AgendaHome.tsx:139` gives the two list surfaces a 120-day forward window from the anchor, so both today's errand and the dinner two days out must be in it. Each card's accessible name is `<summary>, <time>` (`AgendaHome.tsx:582`), so the assertions carry the seeded summaries.
3. **A card opens the event.** `Back to the agenda` (`AgendaEvent.tsx:156`) exists only on the pushed event screen.
4. **The event screen carries the vault's own words.** The seeded description (`AgendaEvent.tsx:187`) plus `Edit this event` and `Ask to cancel this event` (`:271`, `:283`) — the two acts, one of which is a proposal rather than a delete.

**Verdict:** PASS only if the Schedule surface shows the seeded events AND the opened card carries the vault's description. A Schedule surface that renders its chrome over an empty list is the defect this flow exists to catch: the read reached the screen and the rows did not.
