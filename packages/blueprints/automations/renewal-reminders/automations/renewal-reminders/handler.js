/**
 * Renewal reminders (issue #299 phase 4) — the watch half of "your
 * documents watch your deadlines".
 *
 * The condition trigger carries the whole reminder logic (tentative
 * core.event, dtstart within the next 14 days, evaluated on a morning
 * gate): this handler only formats the brief. It fires with the matched
 * rows as input, reads nothing extra, writes nothing — a reminder is a
 * surfaced run, not a mutation.
 */

export default async ({ ctx, log }) => {
  const matches = Array.isArray(ctx.input?.rows) ? ctx.input.rows : [];
  const upcoming = matches
    .filter((row) => typeof row.dtstart === 'string')
    .map((row) => ({ summary: row.summary ?? 'Untitled deadline', due: row.dtstart.slice(0, 10) }))
    .sort((a, b) => (a.due < b.due ? -1 : 1));
  if (upcoming.length === 0) return { summary: 'nothing coming due in the next two weeks' };
  for (const item of upcoming) log.info(`due ${item.due}: ${item.summary}`);
  const lead = upcoming[0];
  return {
    summary:
      upcoming.length === 1
        ? `1 deadline coming up — ${lead.summary} on ${lead.due}`
        : `${upcoming.length} deadlines in the next two weeks — first: ${lead.summary} on ${lead.due}`,
    output: { upcoming },
  };
};
