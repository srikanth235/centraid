/**
 * Delete a todo by id. No-op when the id is unknown (idempotent).
 *
 * @typedef {Object} Input
 * @property {number} [id]
 *
 * @type {import('@centraid/openclaw-plugin').ActionHandler}
 */
export default async ({ body, db }) => {
  const input = /** @type {Input | undefined} */ (body);
  const id = Number(input?.id ?? 0);
  if (!Number.isFinite(id) || id <= 0) {
    return { status: 400, body: { error: 'id is required' } };
  }
  db.prepare('DELETE FROM todos WHERE id = ?').run(id);
  return { status: 200, body: { ok: true } };
};
