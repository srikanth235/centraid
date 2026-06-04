const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Delete the journal entry for a given date. No-op when no row matches.
 *
 * @typedef {Object} DeleteInput
 * @property {string} [date]
 *
 * @type {import('@centraid/openclaw-plugin').ActionHandler}
 */
export default async ({ body, db }) => {
  const input = /** @type {DeleteInput | undefined} */ (body);
  const date = String(input?.date ?? '');
  if (!DATE_RE.test(date)) {
    return { status: 400, body: { error: 'invalid_date' } };
  }
  await db.prepare('DELETE FROM journal_entries WHERE date = ?').run(date);
  return { status: 200, body: { ok: true } };
};
