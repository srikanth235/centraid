/**
 * List todos with open items first, then by most-recently created.
 *
 * @typedef {Object} TodoRow
 * @property {number} id
 * @property {string} text
 * @property {number} done
 * @property {number} created_at
 *
 * @type {import('@centraid/openclaw-plugin').QueryHandler}
 */
export default async ({ db }) => {
  const rows = /** @type {TodoRow[]} */ (
    db
      .prepare('SELECT id, text, done, created_at FROM todos ORDER BY done ASC, created_at DESC')
      .all()
  );
  return rows.map((r) => ({
    id: r.id,
    text: r.text,
    done: r.done === 1,
    createdAt: r.created_at,
  }));
};
