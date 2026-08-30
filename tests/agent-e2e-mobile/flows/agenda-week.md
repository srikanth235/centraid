# agenda-week

**Goal:** prove the phone's Agenda seat over the real seeded week — the Day surface draws its own chrome, the Schedule surface's forward window carries the seeded events out of the replica, and a card opens the event's own screen with the vault's description on it.

**Setup:** `ctx.ensureDemo("agenda")` runs before pairing, so the initial replica clone holds the deterministic week (`packages/blueprints/apps/agenda/seed.js`: five events derived from the gateway's own clock — something today, a weekly recurring run with a reminder, dinner two days out, a deadline three days out, and a dentist next week). The flow then pairs via `ctx.configureGateway()`.

**Steps:** open Agenda from Home's launcher tile, observe the Day surface's two header actions, **press `New event` and compose one**, switch to **Schedule**, observe two seeded events plus the composed one in its forward window, open the dinner card, and observe the event screen's back control, the seeded description, and the two acts the screen offers.

**Expectations:**

1. **The Day surface is the arrival.** `Go to today` and `New event` (`AgendaHome.tsx:311`, `:318`) are published by the Agenda home header alone — neither is a tab label and neither renders anywhere else in the app.
2. **The composer writes** ([#890](https://github.com/srikanth235/centraid/issues/890) W5). `New event` was asserted here for the flow's whole life and never pressed, and Agenda had no `inputText` anywhere in this layer. It is pressed now: `agenda-new-event` opens `AgendaCreateModal`, a summary carrying `ctx.state.runId` is typed and asserted **at the field**, `Save this event` fires the create, and the composer's disappearance is the write being accepted (`submit` calls `onClose` only behind `if (created)`). Acceptance is not readability, which is what claim 3 is for. The run id matters because `ctx.ensureDemo` seeds only when the scenario is absent — on a long-lived gateway an event left by an earlier run would otherwise satisfy the assertion without this run writing anything.

   The composed event is deliberately **not** asserted on the Day surface: the composer starts at the next half hour, which rolls into tomorrow between 23:30 and midnight, and a one-day read would then be honestly empty of it. A flow that fails for half an hour a night is a flow people learn to re-run.

3. **The Schedule window reads the replica.** `AgendaHome.tsx:139` gives the two list surfaces a 120-day forward window from the anchor, so today's errand, the dinner two days out **and the event this run composed** must all be in it. Each card's accessible name is `<summary>, <time>` (`AgendaHome.tsx:582`), so the assertions carry the seeded summaries and the typed one alike; the list is virtualized, so anything past the first rows is scrolled to rather than assumed on screen.
4. **A card opens the event.** `agenda-event-back`, whose label is `Back to the agenda` (`AgendaEvent.tsx:156`), exists only on the pushed event screen.
5. **The event screen carries the vault's own words.** The seeded description (`AgendaEvent.tsx:187`) plus `Edit this event` and `Ask to cancel this event` (`:271`, `:283`) — the two acts, one of which is a proposal rather than a delete.

**Selectors.** Chrome by handle (`agenda-today`, `agenda-new-event`, `agenda-band-schedule`, `agenda-event-back`), content by its own words. The labels stay asserted beside the handles: a handle proves a control was drawn, the label is what a member hears, and a handle on a control that lost its accessible name would hide that loss.

**Known gap:** the composer's Title field carries no `testID`, no placeholder and no `accessibilityLabel` — it is reached only because it `autoFocus`es. An id is not invented here; `scripts/lint-mobile-testids.mjs` fails on an id no screen renders, and adding one is an `apps/mobile` change.

**Marginal cost:** ~30 s on a journey that has already paid the boot, the pairing and the seed — one sheet open, one autofocused field, one save, and one extra `scrollUntilVisible` on a surface the flow was already standing on.

**Verdict:** PASS only if the Schedule surface shows the seeded events AND the event this run composed AND the opened card carries the vault's description. A Schedule surface that renders its chrome over an empty list is the defect this flow exists to catch: the read reached the screen and the rows did not.
