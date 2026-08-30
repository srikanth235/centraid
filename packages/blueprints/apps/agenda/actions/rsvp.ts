import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

/**
 * Record an RSVP (RFC 5545 PARTSTAT). The vault refuses one from a party never
 * invited, or to a cancelled event; both arrive as `failed`.
 */
export default async function rsvp({
  body,
  ctx,
}: HandlerArgs): Promise<ActionResult> {
  const input = actionInput(body);
  return runVaultAction(ctx, {
    command: "schedule.respond_rsvp",
    input: {
      event_id: String(input.event_id ?? ""),
      party_id: String(input.party_id ?? ""),
      partstat: String(input.partstat ?? ""),
    },
  });
}
