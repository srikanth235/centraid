/**
 * The studio projection: clients, projects, and invoices from the business
 * schema, joined against core parties for names and core activities for
 * tracked time. Everything comes from the vault — this app holds no rows
 * of its own, and until the business domain's command pack ships it is a
 * pure read-only surface.
 *
 * A consent denial is a first-class outcome, not an error: the UI renders
 * it as the "ask the owner for access" state, receipt id included.
 *
 * @type {import('@centraid/openclaw-plugin').QueryHandler}
 */
export default async ({ ctx }) => {
  const purpose = 'dpv:Billing';
  try {
    const [clients, projects, entries, invoices, lines, parties, activities] = await Promise.all([
      ctx.vault.read({ entity: 'business.client', purpose }),
      ctx.vault.read({ entity: 'business.project', purpose }),
      ctx.vault.read({ entity: 'business.time_entry', purpose }),
      ctx.vault.read({ entity: 'business.invoice', purpose }),
      ctx.vault.read({ entity: 'business.invoice_line', purpose }),
      ctx.vault.read({ entity: 'core.party', purpose }),
      ctx.vault.read({ entity: 'core.activity', purpose }),
    ]);

    const partyName = new Map((parties.rows ?? []).map((p) => [p.party_id, p.display_name]));
    const clientRows = clients.rows ?? [];
    const clientName = new Map(
      clientRows.map((c) => [c.client_id, partyName.get(c.party_id) ?? c.client_id]),
    );

    // Tracked hours per project: a time entry's duration lives on its
    // canonical core.activity (started_at → ended_at); open entries count 0.
    const activityById = new Map((activities.rows ?? []).map((a) => [a.activity_id, a]));
    const hoursByProject = new Map();
    for (const entry of entries.rows ?? []) {
      const act = activityById.get(entry.activity_id);
      if (!act?.started_at || !act.ended_at) continue;
      const ms = new Date(act.ended_at).getTime() - new Date(act.started_at).getTime();
      if (!Number.isFinite(ms) || ms <= 0) continue;
      hoursByProject.set(
        entry.project_id,
        (hoursByProject.get(entry.project_id) ?? 0) + ms / 3_600_000,
      );
    }

    // Invoice totals from their lines (amount_minor is integer minor units);
    // an invoice with no lines yet falls back to its own total_minor.
    const lineTotal = new Map();
    for (const line of lines.rows ?? []) {
      lineTotal.set(line.invoice_id, (lineTotal.get(line.invoice_id) ?? 0) + line.amount_minor);
    }

    const projectRows = (projects.rows ?? []).map((p) => ({
      project_id: p.project_id,
      name: p.name,
      status: p.status,
      client: clientName.get(p.client_id) ?? p.client_id,
      hours: hoursByProject.get(p.project_id) ?? 0,
    }));
    const statusRank = { active: 0, proposed: 1, done: 2, cancelled: 3 };
    projectRows.sort(
      (a, b) =>
        (statusRank[a.status] ?? 9) - (statusRank[b.status] ?? 9) || a.name.localeCompare(b.name),
    );

    const projectCount = new Map();
    for (const p of projects.rows ?? []) {
      projectCount.set(p.client_id, (projectCount.get(p.client_id) ?? 0) + 1);
    }
    const clientList = clientRows
      .map((c) => ({
        client_id: c.client_id,
        name: clientName.get(c.client_id),
        status: c.status,
        projects: projectCount.get(c.client_id) ?? 0,
      }))
      .toSorted((a, b) => a.name.localeCompare(b.name));

    const invoiceRows = (invoices.rows ?? [])
      .map((inv) => ({
        invoice_id: inv.invoice_id,
        number: inv.number,
        status: inv.status,
        issued_on: inv.issued_on,
        currency: inv.currency,
        total_minor: lineTotal.get(inv.invoice_id) ?? inv.total_minor,
        client: clientName.get(inv.client_id) ?? inv.client_id,
      }))
      .toSorted((a, b) => String(b.issued_on).localeCompare(String(a.issued_on)));

    return { clients: clientList, projects: projectRows, invoices: invoiceRows };
  } catch (err) {
    return {
      clients: [],
      projects: [],
      invoices: [],
      vaultDenied: { code: err.code, message: err.message },
    };
  }
};
