const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Upsert a journal entry for a given date.
 *
 * @typedef {Object} SaveInput
 * @property {string} [date]
 * @property {string} [body]
 *
 * @type {import('@centraid/openclaw-plugin').ActionHandler}
 */
export default async ({ body, db }) => {
  const input = /** @type {SaveInput | undefined} */ (body);
  const date = String(input?.date ?? '');
  if (!DATE_RE.test(date)) {
    return { status: 400, body: { error: 'invalid_date' } };
  }
  const text = String(input?.body ?? '');
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO journal_entries (date, body, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(date) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at`,
    )
    .run(date, text, now);
  return { status: 200, body: { date, updatedAt: now } };
};
