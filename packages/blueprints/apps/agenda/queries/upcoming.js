/**
 * The agenda projection: non-cancelled canonical events from the start of
 * today forward, plus the calendars a proposal could land on. Everything
 * comes from the vault — this app holds no rows of its own.
 *
 * A consent denial is a first-class outcome, not an error: the UI renders
 * it as the "ask the owner for access" state, receipt id included.
 *
 * @type {import('@centraid/openclaw-plugin').QueryHandler}
 */
export default async ({ ctx }) => {
  const purpose = 'dpv:ServiceProvision';
  try {
    const startOfToday = `${new Date().toISOString().slice(0, 10)}T00:00:00Z`;
    const [events, calendars] = await Promise.all([
      ctx.vault.read({
        entity: 'core.event',
        where: [
          { column: 'status', op: 'ne', value: 'cancelled' },
          { column: 'dtstart', op: 'gte', value: startOfToday },
        ],
        purpose,
      }),
      ctx.vault.read({ entity: 'schedule.calendar', purpose }),
    ]);
    const rows = (events.rows ?? []).toSorted((a, b) =>
      String(a.dtstart).localeCompare(String(b.dtstart)),
    );
    return {
      events: rows,
      calendars: calendars.rows ?? [],
    };
  } catch (err) {
    return { events: [], calendars: [], vaultDenied: { code: err.code, message: err.message } };
  }
};
