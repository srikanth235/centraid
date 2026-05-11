import type { QueryHandler } from '@centraid/openclaw-plugin';

interface EntryRow {
  date: string;
  body: string;
}

/**
 * Returns every entry's date plus a short preview of its body (first 80
 * chars). Body itself is fetched per-entry via `get` to keep the list
 * response small when there are many days of writing.
 */
export default (async ({ db }) => {
  const rows = db
    .prepare('SELECT date, body FROM journal_entries ORDER BY date DESC')
    .all<EntryRow>();
  return rows.map((r) => ({
    date: r.date,
    preview: (r.body ?? '').trim().slice(0, 80),
  }));
}) satisfies QueryHandler;
