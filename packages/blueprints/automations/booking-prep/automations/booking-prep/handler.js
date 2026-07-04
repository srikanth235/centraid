/**
 * Booking prep — a condition trigger hands this handler the confirmed
 * events entering the next-24h window (`ctx.input.rows`); each becomes a
 * prep task due at the event's start. The trigger's row-content dedup means
 * an event fires once — and again if it's rescheduled, which is exactly
 * when the prep task needs redoing.
 *
 * Available on `ctx`:
 *   ctx.vault.read/search/invoke — consent-checked canon access and full-text
 *                            search over the vault's FTS index (this
 *                            automation's enrolled agent; every call is
 *                            receipted)
 *   ctx.vault.parked       — this agent's invocations awaiting the owner
 *   ctx.tool(name, args)   — call an MCP tool
 *   ctx.agent({ prompt })  — one constrained model turn
 *   ctx.state.get/set/del  — cross-run key/value persistence
 *   ctx.runs.last/list     — this automation's prior runs
 *
 * Return `{ summary?, output? }` — `summary` shows in the run list.
 */
export default async ({ ctx, log }) => {
  const rows = (ctx.input && ctx.input.rows) || [];
  const tasks = [];
  for (const event of rows) {
    const title = `Prepare: ${event.summary || 'upcoming booking'}`;
    try {
      const outcome = await ctx.vault.invoke({
        command: 'schedule.add_task',
        input: {
          title,
          ...(event.dtstart ? { due_at: event.dtstart } : {}),
        },
        purpose: 'dpv:ServiceProvision',
      });
      tasks.push({ title, status: outcome.status });
    } catch (err) {
      log.warn(`could not file "${title}": ${err.message}`);
      tasks.push({ title, status: 'error', error: String(err.message) });
    }
  }
  const filed = tasks.filter((t) => t.status === 'executed').length;
  return {
    summary: rows.length === 0 ? 'no bookings entering the window' : `${filed} prep task(s) filed`,
    output: { tasks },
  };
};
