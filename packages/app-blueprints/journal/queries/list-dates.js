/**
 * Return every entry's date plus a short preview of its body (first 80
 * chars). The body itself is fetched per-entry via `get` so this list
 * response stays small when there are many days of writing.
 *
 * @typedef {Object} EntryRow
 * @property {string} date
 * @property {string} body
 *
 * @type {import('@centraid/openclaw-plugin').QueryHandler}
 */
export default async ({ db }) => {
  const rows = /** @type {EntryRow[]} */ (
    await db.prepare('SELECT date, body FROM journal_entries ORDER BY date DESC').all()
  );
  return rows.map((r) => ({
    date: r.date,
    preview: (r.body ?? '').trim().slice(0, 80),
  }));
};
