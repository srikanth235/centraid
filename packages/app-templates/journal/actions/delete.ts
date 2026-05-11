import type { ActionHandler } from '@centraid/openclaw-plugin';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export default (async ({ body, db }) => {
  const input = body as { date?: string } | undefined;
  const date = String(input?.date ?? '');
  if (!DATE_RE.test(date)) {
    return { status: 400, body: { error: 'invalid_date' } };
  }
  db.prepare('DELETE FROM journal_entries WHERE date = ?').run(date);
  return { status: 200, body: { ok: true } };
}) satisfies ActionHandler;
