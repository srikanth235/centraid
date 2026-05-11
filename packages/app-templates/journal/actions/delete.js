const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export default async ({ body, db }) => {
  const input = body;
  const date = String(input?.date ?? '');
  if (!DATE_RE.test(date)) {
    return { status: 400, body: { error: 'invalid_date' } };
  }
  db.prepare('DELETE FROM journal_entries WHERE date = ?').run(date);
  return { status: 200, body: { ok: true } };
};
