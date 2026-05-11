import type { ActionHandler } from '@centraid/openclaw-plugin';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export default (async ({ body, db }) => {
  const input = body as { date?: string; body?: string } | undefined;
  const date = String(input?.date ?? '');
  if (!DATE_RE.test(date)) {
    return { status: 400, body: { error: 'invalid_date' } };
  }
  const text = String(input?.body ?? '');
  const now = Date.now();
  db.prepare(
    `INSERT INTO journal_entries (date, body, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(date) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at`,
  ).run(date, text, now);
  return { status: 200, body: { date, updatedAt: now } };
}) satisfies ActionHandler;
