/**
 * Weekly hydrate encouragement — runs every Sunday at 8 PM.
 *
 * Reads the past 7 days of cup counts, asks ctx.agent for a short
 * kind line keyed to the actual numbers, and writes one row to
 * hydrate_weekly_recaps. The manifest lives at
 * automations/weekly-encouragement.json.
 *
 * @type {import('@centraid/openclaw-plugin').AutomationHandler}
 */
export default async ({ ctx, db, log }) => {
  const GOAL = 8;
  const now = new Date();
  const weekEndIso = now.toISOString().slice(0, 10);
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - 7);
  const weekStartIso = weekStart.toISOString().slice(0, 10);

  const rows =
    /** @type {Array<{ date: string, cups: number }>} */ (
      await db
        .prepare(`SELECT date, cups FROM hydrate_daily WHERE date >= ? AND date <= ? ORDER BY date`)
        .all(weekStartIso, weekEndIso)
    );

  const totalCups = rows.reduce((sum, r) => sum + r.cups, 0);
  const goalHits = rows.filter((r) => r.cups >= GOAL).length;

  if (rows.length === 0) {
    log.info(`no hydration data for week ending ${weekEndIso}; skipping`);
    return 'no data';
  }

  const stats = rows.map((r) => `${r.date}: ${r.cups}/${GOAL}`).join('\n');
  const reply =
    /** @type {{ encouragement: string }} */ (
      await ctx.agent({
        prompt: `Here's a week of hydration tracking (goal ${GOAL} cups/day):\n\n${stats}\n\nWrite ONE short kind sentence (under 20 words) that responds to this week specifically. No emoji, no exclamation marks.`,
        json: {
          type: 'object',
          properties: { encouragement: { type: 'string' } },
          required: ['encouragement'],
        },
      })
    );

  await db
    .prepare(
      `INSERT OR REPLACE INTO hydrate_weekly_recaps
         (week_ending, total_cups, goal_hits, encouragement, generated_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(weekEndIso, totalCups, goalHits, reply.encouragement, Date.now());

  log.info(
    `recap for week ending ${weekEndIso}: ${totalCups} cups, ${goalHits}/${rows.length} goal days`,
  );
  return `recap-${weekEndIso}`;
};
