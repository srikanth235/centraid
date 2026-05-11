export default async ({ body, db }) => {
  const input = body;
  const id = Number(input?.id ?? 0);
  if (!Number.isFinite(id) || id <= 0) {
    return { status: 400, body: { error: 'id is required' } };
  }
  db.prepare('DELETE FROM todos WHERE id = ?').run(id);
  return { status: 200, body: { ok: true } };
};
