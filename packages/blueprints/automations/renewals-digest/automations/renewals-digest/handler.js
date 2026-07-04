/**
 * Renewals digest — a Monday cron reads the active recurring series from
 * the canon and files a scannable note. Per the projection doctrine, the
 * digest is derived content the owner can delete freely; the durable facts
 * stay in `finance.recurring_series`.
 *
 * Available on `ctx`:
 *   ctx.vault.read/search/invoke — consent-checked canon access and full-text
 *                            search over the vault's FTS index (this
 *                            automation's enrolled agent; every call is
 *                            receipted)
 *   ctx.state.get/set/del  — cross-run key/value persistence
 *
 * Return `{ summary?, output? }` — `summary` shows in the run list.
 */
export default async ({ ctx, log }) => {
  const series = await ctx.vault.read({
    entity: 'finance.recurring_series',
    where: [{ column: 'status', op: 'eq', value: 'active' }],
    purpose: 'dpv:Billing',
  });
  const rows = series.rows || [];
  if (rows.length === 0) {
    return { summary: 'no active recurring charges', output: { count: 0 } };
  }
  const lines = [];
  for (const s of rows) {
    let who = 'unknown counterparty';
    if (s.counterparty_party_id) {
      try {
        const parties = await ctx.vault.read({
          entity: 'core.party',
          where: [{ column: 'party_id', op: 'eq', value: s.counterparty_party_id }],
          purpose: 'dpv:Billing',
        });
        const party = parties.rows && parties.rows[0];
        if (party && party.display_name) who = party.display_name;
      } catch (err) {
        log.warn(`could not resolve counterparty for series ${s.series_id}: ${err.message}`);
      }
    }
    const amount = typeof s.expected_minor === 'number' ? (s.expected_minor / 100).toFixed(2) : '—';
    lines.push(`- **${who}** — expected ${amount} (${s.rrule || 'no rule'})`);
  }
  const body = `# Upcoming renewals\n\n${rows.length} active recurring charge(s):\n\n${lines.join('\n')}\n`;
  const outcome = await ctx.vault.invoke({
    command: 'knowledge.create_note',
    input: { title: 'Renewals digest', body },
    purpose: 'dpv:Billing',
  });
  return {
    summary: `${rows.length} renewal(s) filed as a note`,
    output: { count: rows.length, note: outcome.status },
  };
};
