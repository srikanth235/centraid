export default async ({ body, db }) => {
  const input = body;
  const id = Number(input?.id ?? 0);
  if (!Number.isFinite(id) || id <= 0) {
    return { status: 400, body: { error: 'id is required' } };
  }
  const result = db.prepare('UPDATE todos SET done = 1 - done WHERE id = ?').run(id);
  if (result.changes === 0) {
    return { status: 404, body: { error: 'not found' } };
  }
  return { status: 200, body: { ok: true } };
};
