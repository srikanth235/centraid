export default async ({ body, db }) => {
  const input = body;
  const text = String(input?.text ?? '').trim();
  if (!text) {
    return { status: 400, body: { error: 'text is required' } };
  }
  const now = Date.now();
  const result = db
    .prepare('INSERT INTO todos (text, done, created_at) VALUES (?, 0, ?)')
    .run(text, now);
  const id = Number(result.lastInsertRowid);
  return { status: 200, body: { id, text, done: false, createdAt: now } };
};
