# tally-derived

**Goal:** prove that the phone's Tally cover derives every figure at read time — and says so with the arithmetic behind it — and that it draws no verb this seat's transport cannot fire.

**Setup:** Tally ships a demo scenario (`packages/blueprints/apps/tally/seed.js`: three friends, one trip group, a lived-in ledger with uneven payers, exact splits and one settlement), so the flow seeds it with `ctx.ensureDemo("tally")` and pairs via `ctx.configureGateway()`. The seeded ledger matters: the hero's counts are the vault's own, which is precisely what a component test cannot supply.

**Steps:** from Home, open Tally, observe the app bar's ambient sentence and the hero's sub-line; then tap the band's **Waiting** slot and observe that surface's own scope sentence and the two verbs that are absent from it.

**Expectations:**

1. **No balance is stored, and the screen says so.** `Every figure is derived at read time · no balance is stored and none is transmitted` is Balances' own ambient sentence (`packages/blueprints/apps/tally/view-copy.ts` `BALANCES_STATUS`), drawn into the app bar by `apps/mobile/src/apps/tally/TallyScreen.tsx` and published on no other screen.
2. **The figure names the rows it came from.** `Derived from N expenses and M settlements — no balance is stored, and none is ever sent.` is `view-copy.ts` `balancesHeroSub`, rendered by `BalancesView.tsx`. The counts are matched rather than pinned because they are the seeded vault's. A cover that read a _stored_ balance would have no counts to name at all, which is the failure this catches.
3. **Waiting says whose writes it is showing.** `Every contribution says whose it is, where it is, and what it is waiting on` is `ROUTE_STATUS.contrib`; `Your own writes, from this device · a contribution from another member is answered in Approvals.` is `apps/mobile/src/apps/tally/tally-seat-copy.ts` `WAITING_OWN_SCOPE`, and it exists because `session.pendingChanges()` answers with THIS phone's outbox and nothing else.
4. **Neither Approve nor Decline is drawn.** The gateway grew a per-intent decide door with the #872 backend (`packages/core/src/protocol/routes.ts` `commonsIntentDecidePath`), but no mobile transport reaches it, so `tally-view-model.ts` sets `TALLY_CONTRIB_DOORS.decide = false` and `contrib-model.ts` emits neither verb — with no fallback standing in for one that cannot fire (protocol C1). The **absence** of both words on a live Waiting screen is the assertion; adding the buttons without adding the door turns this step red.

**Verdict:** PASS only if all four hold. The failures this exists to catch are a Tally cover that shows a figure it cannot account for, and a Waiting surface that offers a steward's answer this seat has no way to send.

**Deliberately not asserted:** committing a write. Every Tally act queues in the durable outbox when the gateway is out of reach, so a commit's _outcome_ on a paired device is timing-dependent; the queued and executed sentences are pinned in `apps/mobile/src/apps/tally/tally-store.test.ts` and `WaitingView.test.tsx` instead, where the transport is controlled. The band's Waiting slot is also not asserted for the ABSENCE of a count — Maestro cannot distinguish "no badge" from "a badge that happens to read empty", and `tally-band.test.ts` pins the destination shape so no count can exist to draw.
