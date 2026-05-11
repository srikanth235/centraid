const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Return a single journal entry by date, or an empty entry when the date
 * has nothing saved yet. Date is validated against ISO `YYYY-MM-DD` to keep
 * the SQL `=` comparison total.
 *
 * @typedef {Object} EntryRow
 * @property {string} date
 * @property {string} body
 * @property {number} updated_at
 *
 * @type {import('@centraid/openclaw-plugin').QueryHandler}
 */
export default async ({ query, db }) => {
  const date = String(query.date ?? '');
  if (!DATE_RE.test(date)) {
    return { error: 'invalid_date' };
  }
  const row = /** @type {EntryRow | undefined} */ (
    db.prepare('SELECT date, body, updated_at FROM journal_entries WHERE date = ?').get(date)
  );
  if (!row) {
    return { date, body: '', updatedAt: null };
  }
  return { date: row.date, body: row.body, updatedAt: row.updated_at };
};
