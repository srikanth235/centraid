/**
 * The budgets projection: recent canonical transactions, the accounts they
 * move through, the owner's budget caps, and the concept vocabulary the
 * category selects are built from. Everything comes from the vault — this
 * app holds no rows of its own; budget progress is computed in the page.
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
    const [transactions, accounts, budgets, concepts, contents, attachments] = await Promise.all([
      ctx.vault.read({ entity: 'core.transaction', limit: 100, purpose }),
      ctx.vault.read({ entity: 'core.account', purpose }),
      ctx.vault.read({ entity: 'finance.budget', purpose }),
      ctx.vault.read({ entity: 'core.concept', purpose }),
      ctx.vault.read({ entity: 'core.content_item', purpose }),
      ctx.vault.read({
        entity: 'core.attachment',
        where: [{ column: 'subject_type', op: 'eq', value: 'core.transaction' }],
        purpose,
      }),
    ]);
    const contentById = new Map((contents.rows ?? []).map((c) => [c.content_id, c]));
    const attByTxn = attachmentsBySubject('core.transaction', attachments.rows ?? [], contentById);
    // Rows arrive unordered; newest movement first is the ledger's natural
    // reading order.
    const rows = (transactions.rows ?? [])
      .map((t) => ({ ...t, attachments: attByTxn.get(t.txn_id) ?? [] }))
      .toSorted((a, b) => String(b.posted_at).localeCompare(String(a.posted_at)));
    return {
      transactions: rows,
      accounts: accounts.rows ?? [],
      budgets: budgets.rows ?? [],
      concepts: concepts.rows ?? [],
    };
  } catch (err) {
    return {
      transactions: [],
      accounts: [],
      budgets: [],
      concepts: [],
      vaultDenied: { code: err.code, message: err.message },
    };
  }
};
