/**
 * Daily todos digest — runs every weekday at 5 PM.
 *
 * Pulls open + done counts (and the oldest open item by created_at)
 * and asks ctx.agent for a two-line digest. Persists to todo_digests
 * keyed by ISO day. The manifest lives at
 * automations/daily-digest.json.
 *
 * @type {import('@centraid/openclaw-plugin').AutomationHandler}
 */
export default async ({ ctx, db, log }) => {
  const dayIso = new Date().toISOString().slice(0, 10);
  const startOfDay = Math.floor(new Date(`${dayIso}T00:00:00Z`).getTime());

  const openRow = /** @type {{ n: number } | undefined} */ (
    await db.prepare(`SELECT COUNT(*) AS n FROM todos WHERE done = 0`).get()
  );
  const doneTodayRow = /** @type {{ n: number } | undefined} */ (
    await db
      .prepare(`SELECT COUNT(*) AS n FROM todos WHERE done = 1 AND created_at >= ?`)
      .get(startOfDay)
  );
  const oldestOpen =
    /** @type {{ text: string, created_at: number } | undefined} */ (
      await db
        .prepare(
          `SELECT text, created_at FROM todos WHERE done = 0 ORDER BY created_at ASC LIMIT 1`,
        )
        .get()
    );

  const openCount = openRow?.n ?? 0;
  const doneCount = doneTodayRow?.n ?? 0;

  if (openCount === 0 && doneCount === 0) {
    log.info(`no todo activity for ${dayIso}; skipping digest`);
    return 'no activity';
  }

  const ageDays = oldestOpen
    ? Math.max(0, Math.floor((Date.now() - oldestOpen.created_at) / 86400000))
    : 0;
  const oldestLine = oldestOpen
    ? `Oldest open item (${ageDays}d): "${oldestOpen.text}"`
    : 'No open items.';

  const reply =
    /** @type {{ summary: string }} */ (
      await ctx.agent({
        prompt: `Daily todo snapshot for ${dayIso}:\n- ${openCount} open\n- ${doneCount} closed today\n- ${oldestLine}\n\nWrite a TWO-LINE digest (line 1: state of play, line 2: nudge about the oldest open item if any). Plain text, no emoji, no headers.`,
        json: {
          type: 'object',
          properties: { summary: { type: 'string' } },
          required: ['summary'],
        },
      })
    );

  await db
    .prepare(
      `INSERT OR REPLACE INTO todo_digests
         (day, open_count, done_count, summary, generated_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(dayIso, openCount, doneCount, reply.summary, Date.now());

  log.info(`digest ${dayIso}: ${openCount} open, ${doneCount} done`);
  return `digest-${dayIso}`;
};
