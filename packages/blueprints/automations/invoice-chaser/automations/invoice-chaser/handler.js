/**
 * Invoice chaser — the §09 "bill the workshop" tail, decomposed: a
 * condition trigger hands this handler sent invoices entering the 3-day
 * due window (`ctx.input.rows`); each becomes a DRAFT payment reminder to
 * the client. Draft ≠ send: `social.draft_message` is low-risk and lands
 * as a draft in Threads; sending remains the owner's move (and would park
 * for confirmation anyway — risk high exceeds an agent's ceiling).
 *
 * Available on `ctx`:
 *   ctx.vault.read/invoke  — consent-checked canon access (this automation's
 *                            enrolled agent; every call is receipted)
 *   ctx.vault.parked       — this agent's invocations awaiting the owner
 *   ctx.state.get/set/del  — cross-run key/value persistence
 *
 * Return `{ summary?, output? }` — `summary` shows in the run list.
 */
export default async ({ ctx, log }) => {
  const rows = (ctx.input && ctx.input.rows) || [];
  const drafts = [];
  for (const invoice of rows) {
    try {
      const clients = await ctx.vault.read({
        entity: 'business.client',
        where: [{ column: 'client_id', op: 'eq', value: invoice.client_id }],
        purpose: 'dpv:Billing',
      });
      const client = clients.rows && clients.rows[0];
      if (!client || !client.party_id) {
        log.warn(`invoice ${invoice.number}: no client party to remind`);
        continue;
      }
      const amount =
        typeof invoice.amount_minor === 'number'
          ? (invoice.amount_minor / 100).toFixed(2)
          : String(invoice.amount_minor);
      const due = String(invoice.due_at || '').slice(0, 10);
      const outcome = await ctx.vault.invoke({
        command: 'social.draft_message',
        input: {
          recipient_party_id: client.party_id,
          body_text:
            `Hi — a gentle reminder that invoice ${invoice.number} ` +
            `(${amount}) is due on ${due}. ` +
            `Do let me know if anything needs clarifying. Thank you!`,
        },
        purpose: 'dpv:Billing',
      });
      drafts.push({ invoice: invoice.number, status: outcome.status });
    } catch (err) {
      log.warn(`invoice ${invoice.number}: ${err.message}`);
      drafts.push({ invoice: invoice.number, status: 'error', error: String(err.message) });
    }
  }
  return {
    summary:
      rows.length === 0
        ? 'nothing coming due'
        : `${drafts.filter((d) => d.status === 'executed').length} reminder draft(s) staged`,
    output: { drafts },
  };
};
