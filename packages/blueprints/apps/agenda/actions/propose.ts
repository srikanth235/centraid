/**
 * Propose an event through the vault's typed command. The outcome is passed
 * through verbatim — `executed`, `parked` (awaiting owner confirmation),
 * `denied`, or `failed` (a precondition such as the busy-conflict check) —
 * so the UI can narrate what the consent plane decided.
 */
export default async function propose({
  body,
  ctx,
}: HandlerArgs): Promise<ActionResult> {
  const input = (body ?? {}) as Record<string, unknown>;
  try {
    const outcome = await ctx.vault.invoke({
      command: "schedule.propose_event",
      input: {
        summary: String(input.summary ?? ""),
        dtstart: String(input.dtstart ?? ""),
        dtend: String(input.dtend ?? ""),
        calendar_id: String(input.calendar_id ?? ""),
        ...(input.description
          ? { description: String(input.description) }
          : {}),
        ...(input.start_tz ? { start_tz: String(input.start_tz) } : {}),
        ...(input.end_tz ? { end_tz: String(input.end_tz) } : {}),
        ...(input.recurrence_semantics
          ? { recurrence_semantics: String(input.recurrence_semantics) }
          : {}),
        ...(input.rrule ? { rrule: String(input.rrule) } : {}),
        ...(input.conferencing_uri
          ? { conferencing_uri: String(input.conferencing_uri) }
          : {}),
        ...(Array.isArray(input.reminders)
          ? { reminders: input.reminders }
          : {}),
        ...(Array.isArray(input.attendee_party_ids) &&
        input.attendee_party_ids.length
          ? { attendee_party_ids: input.attendee_party_ids.map(String) }
          : {}),
      },
      purpose: "dpv:ServiceProvision",
    });
    return { status: 200, body: outcome };
  } catch (error) {
    const e = error as { code?: string; message?: string };
    return {
      status: 200,
      body: { status: "denied", reason: e.message, code: e.code },
    };
  }
}
