import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

/**
 * Propose an event. The outcome passes through verbatim — `executed`,
 * `parked`, `denied`, `failed` (a precondition such as the busy-conflict
 * check) — so the UI can narrate what the consent plane decided.
 */
export default async function propose({
  body,
  ctx,
}: HandlerArgs): Promise<ActionResult> {
  const input = actionInput(body);
  return runVaultAction(ctx, {
    command: "schedule.propose_event",
    input: {
      summary: String(input.summary ?? ""),
      dtstart: String(input.dtstart ?? ""),
      dtend: String(input.dtend ?? ""),
      calendar_id: String(input.calendar_id ?? ""),
      ...(input.description ? { description: String(input.description) } : {}),
      ...(input.start_tz ? { start_tz: String(input.start_tz) } : {}),
      ...(input.end_tz ? { end_tz: String(input.end_tz) } : {}),
      ...(input.recurrence_semantics
        ? { recurrence_semantics: String(input.recurrence_semantics) }
        : {}),
      ...(input.rrule ? { rrule: String(input.rrule) } : {}),
      ...(input.location_place_id
        ? { location_place_id: String(input.location_place_id) }
        : {}),
      ...(input.conferencing_uri
        ? { conferencing_uri: String(input.conferencing_uri) }
        : {}),
      ...(Array.isArray(input.reminders) ? { reminders: input.reminders } : {}),
      ...(Array.isArray(input.attendee_party_ids) &&
      input.attendee_party_ids.length
        ? { attendee_party_ids: input.attendee_party_ids.map(String) }
        : {}),
    },
  });
}
