export default async ({ db }) => {
  const rows = db
    .prepare('SELECT id, text, done, created_at FROM todos ORDER BY done ASC, created_at DESC')
    .all();
  return rows.map((r) => ({
    id: r.id,
    text: r.text,
    done: r.done === 1,
    createdAt: r.created_at,
  }));
};
