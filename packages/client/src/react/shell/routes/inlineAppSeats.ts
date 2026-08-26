// Per-app seat restrictions (docs/blueprint-seats.md, decision S5) — which
// SEATs (docs/platform-gating.md) an inline app refuses to mount on.
//
// Sourced from each bundled app's `app.json#seats.disabledOn` block, but kept
// as its OWN small synchronous table here rather than read off the async
// template catalog (`templatesData.ts` → gateway `listTemplates()`):
// `InlineAppRoute` needs the answer on the very first render, before the
// scopes fetch resolves and before the app's lazy chunk is ever imported —
// a network round trip would either delay the wall or let the app flash on
// screen first. `inlineAppSeats.test.ts` reads every bundled `app.json`
// directly and cross-checks this table, so a manifest edit that adds or
// drops a `disabledOn` entry fails CI here instead of drifting silently.
export const INLINE_APP_DISABLED_SEATS: Readonly<
  Record<string, readonly string[]>
> = {
  locker: ["viewer"],
};

/** Whether `appId` refuses to mount on `seat` (docs/blueprint-seats.md S5). */
export function isDisabledOnSeat(appId: string, seat: string): boolean {
  return (INLINE_APP_DISABLED_SEATS[appId] ?? []).includes(seat);
}

/** An app's own words for its seat wall, where it has them. The body is the
 *  app's sentence — Locker's is reconciled with `VIEWER_REFUSED` in
 *  `packages/blueprints/apps/locker/view-copy.ts`, restated here for the same
 *  reason the seat table itself is: the wall renders before any app chunk is
 *  fetched. `wayIn` names how the thing gets done instead — a refusal that
 *  names no way in reads as broken (v17 handoff, #872). */
export const INLINE_APP_SEAT_REFUSALS: Readonly<
  Record<string, { title: string; body: string; wayIn: string }>
> = {
  locker: {
    title: "Locker does not open on a shared browser",
    body: "A shared browser cannot hold the user-presence boundary this app depends on, so Locker refuses the seat outright.",
    wayIn: "Use the desktop app beside your gateway, or your phone.",
  },
};
