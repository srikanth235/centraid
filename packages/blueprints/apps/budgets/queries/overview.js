/**
 * The budgets projection: canonical transactions for a window, the accounts
 * they move through, the owner's budget caps, and the concept vocabulary the
 * category selects are built from. Everything comes from the vault — this
 * app holds no rows of its own; budget progress is computed in the page.
 *
 * Input (both optional):
 *  - `month` ("YYYY-MM"): fetch that month's transactions, padded a day on
 *    each side so the client's local-month bucketing keeps edge rows.
 *  - `limit`: row cap for the transaction read (defaults: 500 for a month
 *    fetch, 1000 for the recent window). `truncated` reports when it hit.
 * No month means the recent six-month window — enough for the summary, the
 * trend chart, and near-past navigation in one read.
 *
 * A consent denial is a first-class outcome, not an error: the UI renders
 * it as the "ask the owner for access" state, receipt id included.
 *
 * @type {import('@centraid/openclaw-plugin').QueryHandler}
 */

const DAY_MS = 86_400_000;

/**
 * The vault-seeded spend-category notations. They are only anchors: the
 * category list is every concept sharing a scheme with an anchor or with a
 * concept already used as a budget/transaction category — so categories the
 * owner adds to the scheme appear here without a code change.
 */
const SEED_CATEGORY_NOTATIONS = ['groceries', 'dining', 'transport', 'gifts'];

/**
 * Derive the spend-category vocabulary from the concepts themselves. The
 * app cannot read core.concept_scheme, so the spend scheme is identified by
 * its members: seed notations plus any concept referenced as a category.
 */
function spendCategories(concepts, budgets, transactions) {
  const byId = new Map(concepts.map((c) => [c.concept_id, c]));
  const schemeIds = new Set();
  for (const c of concepts) {
    if (SEED_CATEGORY_NOTATIONS.includes(c.notation)) schemeIds.add(c.scheme_id);
  }
  for (const b of budgets) {
    const c = byId.get(b.category_concept_id);
    if (c) schemeIds.add(c.scheme_id);
  }
  for (const t of transactions) {
    if (!t.category_concept_id) continue;
    const c = byId.get(t.category_concept_id);
    if (c) schemeIds.add(c.scheme_id);
  }
  return concepts
    .filter((c) => schemeIds.has(c.scheme_id))
    .toSorted((a, b) => String(a.pref_label ?? '').localeCompare(String(b.pref_label ?? '')));
}

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

export default async ({ query, ctx }) => {
  const purpose = 'dpv:Billing';
  const month =
    typeof query?.month === 'string' && /^\d{4}-\d{2}$/.test(query.month) ? query.month : null;
  const limit = Math.min(
    Math.max(Math.trunc(Number(query?.limit)) || (month ? 500 : 1000), 1),
    2000,
  );

  // The transaction window. Reads have no ORDER BY, so an unbounded read
  // with a limit would return an *arbitrary* subset — the window filter is
  // what makes the cap honest. Boundaries are padded a day each side so the
  // viewer's local-month bucketing (which can differ from UTC by up to a
  // day) never loses an edge transaction.
  let where;
  let windowStart = null; // first local month the recent window covers
  if (month) {
    const [y, m] = month.split('-').map(Number);
    where = [
      {
        column: 'posted_at',
        op: 'gte',
        value: new Date(Date.UTC(y, m - 1, 1) - DAY_MS).toISOString(),
      },
      { column: 'posted_at', op: 'lt', value: new Date(Date.UTC(y, m, 1) + DAY_MS).toISOString() },
    ];
  } else {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth() - 5, 1);
    windowStart = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}`;
    where = [
      { column: 'posted_at', op: 'gte', value: new Date(start.getTime() - DAY_MS).toISOString() },
    ];
  }

  try {
    // Accounts, budgets and concepts are small vocabulary tables — read
    // whole. Transactions are the windowed read the where/limit above bound.
    const [transactions, accounts, budgets, concepts] = await Promise.all([
      ctx.vault.read({ entity: 'core.transaction', where, limit, purpose }),
      ctx.vault.read({ entity: 'core.account', purpose }),
      ctx.vault.read({ entity: 'finance.budget', purpose }),
      ctx.vault.read({ entity: 'core.concept', purpose }),
    ]);

    // Joins are `in`-bounded by the windowed transactions — attachment
    // edges first, then one content pull covering only the bytes those
    // edges cite. core.content_item holds every attachment in the vault
    // (receipts here, but also photos, manuals, note bodies…) and has no
    // upper bound, so it must never be read whole.
    const txnIds = (transactions.rows ?? []).map((t) => t.txn_id);
    const attachments =
      txnIds.length > 0
        ? await ctx.vault.read({
            entity: 'core.attachment',
            where: [
              { column: 'subject_type', op: 'eq', value: 'core.transaction' },
              { column: 'subject_id', op: 'in', value: txnIds },
            ],
            purpose,
          })
        : { rows: [] };
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
    // Rows arrive unordered; newest movement first is the ledger's natural
    // reading order.
    const rows = (transactions.rows ?? [])
      .map((t) => ({ ...t, attachments: attByTxn.get(t.txn_id) ?? [] }))
      .toSorted((a, b) => String(b.posted_at).localeCompare(String(a.posted_at)));
    const conceptRows = concepts.rows ?? [];
    const budgetRows = budgets.rows ?? [];
    return {
      transactions: rows,
      accounts: accounts.rows ?? [],
      budgets: budgetRows,
      concepts: conceptRows,
      categories: spendCategories(conceptRows, budgetRows, rows),
      month,
      windowStart,
      limit,
      truncated: rows.length >= limit,
    };
  } catch (err) {
    return {
      transactions: [],
      accounts: [],
      budgets: [],
      concepts: [],
      categories: [],
      vaultDenied: { code: err.code, message: err.message },
    };
  }
};
