import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

/**
 * Cancel an event. Medium-risk against the app risk ceiling, so the vault
 * parks it for the owner: `parked` is a first-class outcome to narrate, an
 * ask in flight rather than an error.
 */
export default async function cancelEvent({
  body,
  ctx,
}: HandlerArgs): Promise<ActionResult> {
  const input = actionInput(body);
  return runVaultAction(ctx, {
    command: "schedule.cancel_event",
    input: {
      event_id: String(input.event_id ?? ""),
    },
  });
}
