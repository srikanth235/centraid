export default async ({ db }) => {
  const rows = db.prepare('SELECT date, body FROM journal_entries ORDER BY date DESC').all();
  return rows.map((r) => ({
    date: r.date,
    preview: (r.body ?? '').trim().slice(0, 80),
  }));
};
