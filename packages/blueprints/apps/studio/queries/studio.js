/**
 * The studio projection: clients, projects, unbilled time, and invoices
 * from the business schema, joined against core parties for names, core
 * activities for tracked time, and core transactions for settlement
 * candidates. Everything comes from the vault — this app holds no rows of
 * its own; writes go through the business domain's typed commands via this
 * app's actions.
 *
 * A consent denial is a first-class outcome, not an error: the UI renders
 * it as the "ask the owner for access" state, receipt id included.
 *
 * @type {import('@centraid/openclaw-plugin').QueryHandler}
 */

/**
 * Group the owner's attachments for one subject type into a map keyed by
 * subject_id, each value a UI-ready list joined to its content item. This is
 * the shared attachment-projection shape every app copies — polymorphic edges
 * in core.attachment, bytes in core.content_item.
 */
function attachmentsBySubject(subjectType, attachments, contentById) {
  const bySubject = new Map();
  for (const a of attachments) {
    if (a.subject_type !== subjectType) continue;
    const content = contentById.get(a.content_id);
    if (!bySubject.has(a.subject_id)) bySubject.set(a.subject_id, []);
    bySubject.get(a.subject_id).push({
      attachment_id: a.attachment_id,
      content_id: a.content_id,
      role: a.role,
      is_primary: a.is_primary,
      media_type: content?.media_type ?? 'application/octet-stream',
      title: content?.title ?? null,
      content_uri: content?.content_uri ?? '',
      byte_size: content?.byte_size ?? 0,
    });
  }
  for (const list of bySubject.values()) {
    list.sort((x, y) => (y.is_primary ?? 0) - (x.is_primary ?? 0));
  }
  return bySubject;
}

export default async ({ ctx }) => {
  const purpose = 'dpv:Billing';
  try {
    const [
      clients,
      projects,
      entries,
      invoices,
      lines,
      parties,
      activities,
      txns,
      contents,
      attachments,
    ] = await Promise.all([
      ctx.vault.read({ entity: 'business.client', purpose }),
      ctx.vault.read({ entity: 'business.project', purpose }),
      ctx.vault.read({ entity: 'business.time_entry', purpose }),
      ctx.vault.read({ entity: 'business.invoice', purpose }),
      ctx.vault.read({ entity: 'business.invoice_line', purpose }),
      ctx.vault.read({ entity: 'core.party', purpose }),
      ctx.vault.read({ entity: 'core.activity', purpose }),
      ctx.vault.read({ entity: 'core.transaction', purpose }),
      ctx.vault.read({ entity: 'core.content_item', purpose }),
      ctx.vault.read({
        entity: 'core.attachment',
        where: [{ column: 'subject_type', op: 'eq', value: 'business.invoice' }],
        purpose,
      }),
    ]);

    const contentById = new Map((contents.rows ?? []).map((c) => [c.content_id, c]));
    const attByInvoice = attachmentsBySubject(
      'business.invoice',
      attachments.rows ?? [],
      contentById,
    );

    const partyName = new Map((parties.rows ?? []).map((p) => [p.party_id, p.display_name]));
    const clientRows = clients.rows ?? [];
    const clientName = new Map(
      clientRows.map((c) => [c.client_id, partyName.get(c.party_id) ?? c.client_id]),
    );
    const projectById = new Map((projects.rows ?? []).map((p) => [p.project_id, p]));
    const activityById = new Map((activities.rows ?? []).map((a) => [a.activity_id, a]));

    // Tracked hours per project and the unbilled queue the invoice flow
    // selects from: billable, closed, and not yet on a line.
    const hoursByProject = new Map();
    const unbilled = [];
    for (const entry of entries.rows ?? []) {
      const act = activityById.get(entry.activity_id);
      if (!act?.started_at || !act.ended_at) continue;
      const ms = new Date(act.ended_at).getTime() - new Date(act.started_at).getTime();
      if (!Number.isFinite(ms) || ms <= 0) continue;
      const hours = ms / 3_600_000;
      hoursByProject.set(entry.project_id, (hoursByProject.get(entry.project_id) ?? 0) + hours);
      const project = projectById.get(entry.project_id);
      if (entry.billable === 1 && entry.invoice_line_id === null && project) {
        unbilled.push({
          entry_id: entry.entry_id,
          project_id: entry.project_id,
          project: project.name,
          client_id: project.client_id,
          client: clientName.get(project.client_id) ?? project.client_id,
          date: String(act.started_at).slice(0, 10),
          hours,
          rate_minor: entry.rate_minor,
          note: act.note ?? null,
        });
      }
    }
    unbilled.sort((a, b) => a.date.localeCompare(b.date));

    // Invoice totals from their lines (amount_minor is integer minor units);
    // an invoice with no lines yet falls back to its own total_minor.
    const lineTotal = new Map();
    for (const line of lines.rows ?? []) {
      lineTotal.set(line.invoice_id, (lineTotal.get(line.invoice_id) ?? 0) + line.amount_minor);
    }

    const projectRows = (projects.rows ?? []).map((p) => ({
      project_id: p.project_id,
      client_id: p.client_id,
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
        currency: c.currency,
        default_rate_minor: c.default_rate_minor,
        projects: projectCount.get(c.client_id) ?? 0,
      }))
      .toSorted((a, b) => a.name.localeCompare(b.name));

    const invoiceRows = (invoices.rows ?? [])
      .map((inv) => ({
        invoice_id: inv.invoice_id,
        number: inv.number,
        status: inv.status,
        issued_on: inv.issued_on,
        due_on: inv.due_on,
        currency: inv.currency,
        total_minor: lineTotal.get(inv.invoice_id) ?? inv.total_minor,
        client: clientName.get(inv.client_id) ?? inv.client_id,
        attachments: attByInvoice.get(inv.invoice_id) ?? [],
      }))
      .toSorted((a, b) => String(b.issued_on).localeCompare(String(a.issued_on)));

    // Parties not yet enrolled as clients — the add-client picker. Includes
    // the owner (harmless; one row) rather than guessing which party it is.
    const enrolledParties = new Set(clientRows.map((c) => c.party_id));
    const candidateParties = (parties.rows ?? [])
      .filter((p) => !enrolledParties.has(p.party_id))
      .map((p) => ({ party_id: p.party_id, display_name: p.display_name }))
      .toSorted((a, b) => String(a.display_name).localeCompare(String(b.display_name)));

    // Settlement candidates for mark-paid: posted incoming money, newest
    // first. mark_invoice_paid links an existing transaction — nothing here
    // creates ledger rows, so a user who doesn't track deposits can't close
    // the loop yet.
    const credits = (txns.rows ?? [])
      .filter((t) => t.direction === 'credit' && t.status === 'posted')
      .map((t) => ({
        txn_id: t.txn_id,
        posted_at: t.posted_at,
        amount_minor: t.amount_minor,
        currency: t.currency,
        description: t.description ?? '',
      }))
      .toSorted((a, b) => String(b.posted_at).localeCompare(String(a.posted_at)))
      .slice(0, 50);

    return {
      clients: clientList,
      projects: projectRows,
      invoices: invoiceRows,
      unbilled,
      parties: candidateParties,
      credits,
    };
  } catch (err) {
    return {
      clients: [],
      projects: [],
      invoices: [],
      unbilled: [],
      parties: [],
      credits: [],
      vaultDenied: { code: err.code, message: err.message },
    };
  }
};
