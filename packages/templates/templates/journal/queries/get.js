const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export default async ({ query, db }) => {
  const date = String(query.date ?? '');
  if (!DATE_RE.test(date)) {
    return { error: 'invalid_date' };
  }
  const row = db
    .prepare('SELECT date, body, updated_at FROM journal_entries WHERE date = ?')
    .get(date);
  if (!row) {
    return { date, body: '', updatedAt: null };
  }
  return { date: row.date, body: row.body, updatedAt: row.updated_at };
};
