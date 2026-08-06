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
