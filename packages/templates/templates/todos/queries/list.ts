import type { QueryHandler } from '@centraid/openclaw-plugin';

interface TodoRow {
  id: number;
  text: string;
  done: number;
  created_at: number;
}

export default (async ({ db }) => {
  const rows = db
    .prepare('SELECT id, text, done, created_at FROM todos ORDER BY done ASC, created_at DESC')
    .all<TodoRow>();
  return rows.map((r) => ({
    id: r.id,
    text: r.text,
    done: r.done === 1,
    createdAt: r.created_at,
  }));
}) satisfies QueryHandler;
