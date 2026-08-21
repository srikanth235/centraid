/**
 * Scenario generator (issue #708): one lived-in week on the calendar —
 * something small today so the brief is never blank, dinner with a friend,
 * a deadline, a weekly recurring run with a reminder, and next week's
 * dentist. Runs under the demo register: owner credential, `seed.demo`
 * provenance, invisible to automations, one-click purge. Deterministic:
 * every dtstart derives from input.now, so a reload reproduces the week.
 *
 * No attendees: seeds fire in PARALLEL, so resolving "Maya" to a party would
 * either race the people/tally seeds or mint a duplicate of their friend.
 * The dinner names her in the summary instead — cheap, honest, race-free.
 */
const PURPOSE = "dpv:ServiceProvision";

export default async function seedHandler({ input, log, ctx }) {
  const now = new Date(input?.now ?? Date.now());
  const invoke = async (command, args) => {
    const out = await ctx.vault.invoke({
      command,
      input: args,
      purpose: PURPOSE,
    });
    if (out.status !== "executed") {
      throw new Error(`${command} ${out.status}: ${out.reason ?? "no reason"}`);
    }
    return out.output;
  };

  // Events need a calendar (propose_event's calendar_exists precondition) and
  // no command mints one — bootstrap's default "Personal" calendar is the only
  // one a fresh vault has. Discover it; never hardcode the id.
  const calendars = await ctx.vault.read({
    entity: "schedule.calendar",
    purpose: PURPOSE,
    limit: 1,
  });
  const calendarId = calendars.rows?.[0]?.calendar_id;
  if (!calendarId) throw new Error("vault has no calendar");

  /** Local wall-clock slot `n` days out — 7pm reads as 7pm to the owner. */
  const slot = (n, hour, minute, minutes) => {
    const start = new Date(now);
    start.setDate(start.getDate() + n);
    start.setHours(hour, minute, 0, 0);
    return {
      dtstart: start.toISOString(),
      dtend: new Date(start.getTime() + minutes * 60000).toISOString(),
    };
  };

  // Every slot is disjoint: propose_event refuses ANY busy overlap, vault-wide.
  const event = (args) =>
    invoke("schedule.propose_event", { calendar_id: calendarId, ...args });

  await event({
    summary: "Pick up the dry cleaning",
    ...slot(0, 17, 0, 30),
  });
  await event({
    summary: "Morning run",
    description: "Loop around the reservoir.",
    ...slot(1, 6, 30, 45),
    // The series repeats from this event's own dtstart; the reminder rides
    // along on schedule_event_ext.
    rrule: "FREQ=WEEKLY",
    reminders: [{ minutes_before: 15 }],
  });
  await event({
    summary: "Dinner with Maya",
    description: "She picked the place — Thai, near the park.",
    ...slot(2, 19, 0, 120),
  });
  await event({
    summary: "Book the Tahoe cabin",
    description: "Last call before the long-weekend rates jump.",
    ...slot(3, 9, 0, 30),
    reminders: [{ minutes_before: 60 }],
  });
  await event({
    summary: "Dentist — cleaning",
    ...slot(8, 15, 0, 60),
  });

  log.info(
    "agenda scenario: 5 events seeded (1 recurring with a reminder, 1 next week)"
  );
  return { seeded: 5 };
}
