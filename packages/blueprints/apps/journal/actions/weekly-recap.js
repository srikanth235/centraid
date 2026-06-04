/**
 * Weekly journal recap — runs every Sunday at 8 PM.
 *
 * Pulls the last 7 days of entries, asks ctx.agent for a structured
 * summary, and writes one row to journal_recaps. The corresponding
 * manifest lives at automations/weekly-recap.json.
 *
 * @type {import('@centraid/openclaw-plugin').AutomationHandler}
 */
export default async ({ ctx, db, log }) => {
  // Anchor the week to the most recent Sunday (UTC) for stable keys.
  const now = new Date();
  const weekEndIso = now.toISOString().slice(0, 10);
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - 7);
  const weekStartIso = weekStart.toISOString().slice(0, 10);

  const entries =
    /** @type {Array<{date: string, body: string}>} */ (
      await db
        .prepare(
          `SELECT date, body FROM journal_entries WHERE date >= ? AND date <= ? ORDER BY date`,
        )
        .all(weekStartIso, weekEndIso)
    );

  if (entries.length === 0) {
    log.info(`no journal entries between ${weekStartIso} and ${weekEndIso}; skipping recap`);
    return 'no entries';
  }

  const corpus = entries.map((e) => `# ${e.date}\n${e.body}`).join('\n\n');
  const summary =
    /** @type {{ summary: string, mood: string }} */ (
      await ctx.agent({
        prompt: `Summarize this week of journal entries in 3 short paragraphs and label the dominant mood.\n\nEntries:\n\n${corpus}`,
        json: {
          type: 'object',
          properties: {
            summary: { type: 'string' },
            mood: { type: 'string' },
          },
          required: ['summary', 'mood'],
        },
      })
    );

  await db
    .prepare(
      `INSERT OR REPLACE INTO journal_recaps (week_ending, summary, mood, generated_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(weekEndIso, summary.summary, summary.mood, Date.now());

  log.info(`wrote recap for week ending ${weekEndIso} (mood: ${summary.mood})`);
  return `recap-${weekEndIso}`;
};
