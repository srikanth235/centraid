/**
 * Lead follow-up — a data trigger hands this handler the vault's change
 * entries for `business.client` (`ctx.input.changes`, each `{provId,
 * entity, entityId, activity, …}`). New enrollments (`command.business.
 * add_client`) become follow-up tasks naming the lead; updates and other
 * activities pass through untouched.
 *
 * Available on `ctx`:
 *   ctx.vault.read/invoke  — consent-checked canon access (this automation's
 *                            enrolled agent; every call is receipted)
 *   ctx.vault.changes      — catch-up pulls off the same consented feed
 *   ctx.state.get/set/del  — cross-run key/value persistence
 *   ctx.runs.last/list     — this automation's prior runs
 *
 * Return `{ summary?, output? }` — `summary` shows in the run list.
 */
export default async ({ ctx, log }) => {
  const changes = (ctx.input && ctx.input.changes) || [];
  const added = changes.filter((c) => c.activity === 'command.business.add_client');
  const tasks = [];
  for (const change of added) {
    let name = 'new lead';
    try {
      const clients = await ctx.vault.read({
        entity: 'business.client',
        where: [{ column: 'client_id', op: 'eq', value: change.entityId }],
        purpose: 'dpv:ServiceProvision',
      });
      const client = clients.rows && clients.rows[0];
      if (client && client.party_id) {
        const parties = await ctx.vault.read({
          entity: 'core.party',
          where: [{ column: 'party_id', op: 'eq', value: client.party_id }],
          purpose: 'dpv:ServiceProvision',
        });
        const party = parties.rows && parties.rows[0];
        if (party && party.display_name) name = party.display_name;
      }
    } catch (err) {
      log.warn(`could not resolve lead ${change.entityId}: ${err.message}`);
    }
    const title = `Follow up with ${name}`;
    try {
      const outcome = await ctx.vault.invoke({
        command: 'schedule.add_task',
        input: { title, description: 'First touch for a new lead in the pipeline.' },
        purpose: 'dpv:ServiceProvision',
      });
      tasks.push({ title, status: outcome.status });
    } catch (err) {
      log.warn(`could not file "${title}": ${err.message}`);
      tasks.push({ title, status: 'error', error: String(err.message) });
    }
  }
  return {
    summary:
      added.length === 0
        ? 'no new leads in this batch'
        : `${tasks.filter((t) => t.status === 'executed').length} follow-up task(s) filed`,
    output: { tasks },
  };
};
