/**
 * Payee search as a vault projection: the FTS5 index inside the vault does
 * the matching over core.transaction descriptions, so the app never greps
 * its loaded month client-side — a search reaches the entire ledger, not
 * just the fetched window. Only the matched rows are joined with their
 * receipt attachments, mirroring the overview projection's row shape so the
 * UI renders either list with the same code. Accounts, budgets and the
 * concept vocabulary are deliberately not refetched: they are small tables
 * the page already holds from `overview`.
 *
 * A consent denial is a first-class outcome, not an error: the UI renders
 * it as the "ask the owner for access" state, receipt id included.
 *
 * @type {import('@centraid/openclaw-plugin').QueryHandler}
 */

/** The shared attachment projection — see overview.js for the shape's home. */
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

export default async ({ input, ctx }) => {
  const purpose = 'dpv:Billing';
  const term = String(input?.term ?? '').trim();
  if (!term) return { transactions: [] };
  try {
    const matches = await ctx.vault.search({
      entity: 'core.transaction',
      query: term,
      limit: 100,
      purpose,
    });
    const hits = matches.rows ?? [];
    if (hits.length === 0) return { transactions: [] };
    const txnIds = hits.map((t) => t.txn_id);

    // Joins are `in`-bounded by the matched rows — attachment edges first,
    // then one content pull covering only the bytes those edges cite.
    const attachments = await ctx.vault.read({
      entity: 'core.attachment',
      where: [
        { column: 'subject_type', op: 'eq', value: 'core.transaction' },
        { column: 'subject_id', op: 'in', value: txnIds },
      ],
      purpose,
    });
    const contentIds = [...new Set((attachments.rows ?? []).map((a) => a.content_id))].filter(
      Boolean,
    );
    const contents =
      contentIds.length > 0
        ? await ctx.vault.read({
            entity: 'core.content_item',
            where: [{ column: 'content_id', op: 'in', value: contentIds }],
            purpose,
          })
        : { rows: [] };
    const contentById = new Map((contents.rows ?? []).map((c) => [c.content_id, c]));
    const attByTxn = attachmentsBySubject('core.transaction', attachments.rows ?? [], contentById);

    // Vault order is rank order (best match first) — keep it. Each row is
    // the overview shape (spread txn + attachments) plus the hit snippet.
    const transactions = hits.map((t) => {
      const { _snippet, ...txn } = t;
      return {
        ...txn,
        attachments: attByTxn.get(t.txn_id) ?? [],
        snippet: typeof _snippet === 'string' ? _snippet : '',
      };
    });
    return { transactions };
  } catch (err) {
    return { transactions: [], vaultDenied: { code: err.code, message: err.message } };
  }
};
