/**
 * Weekly hydrate encouragement — runs every Sunday at 8 PM.
 *
 * A small multi-step pipeline so every fire produces a readable run on
 * the Automations → Executions page. It reads the week's cup counts
 * (standing in a sample week when the log is still empty), then makes
 * three `ctx.agent` calls — assess the week, write the encouragement
 * line, suggest one tip — and writes the recap row.
 *
 * Each `ctx.agent` / `ctx.tool` call is captured as a
 * step on the run, with its own timing, args and output.
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

  let rows =
    /** @type {Array<{ date: string, cups: number }>} */ (
      await db
        .prepare(`SELECT date, cups FROM hydrate_daily WHERE date >= ? AND date <= ? ORDER BY date`)
        .all(weekStartIso, weekEndIso)
    );

  // Keep the recap meaningful before any cups are logged: stand in a
  // sample week so the automation — and its run on the Executions
  // page — always has something to work with.
  let sampled = false;
  if (rows.length === 0) {
    sampled = true;
    rows = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(weekStart);
      d.setDate(weekStart.getDate() + i + 1);
      return { date: d.toISOString().slice(0, 10), cups: 3 + ((i * 2) % 6) };
    });
    log.info('hydrate_daily empty — using a sample week for this recap');
  }

  const totalCups = rows.reduce((sum, r) => sum + r.cups, 0);
  const goalHits = rows.filter((r) => r.cups >= GOAL).length;
  const stats = rows.map((r) => `${r.date}: ${r.cups}/${GOAL}`).join('\n');

  // ── Step 1 — assess the week ─────────────────────────────────────────
  const assessment = await safeAgent(
    ctx,
    log,
    {
      prompt: `Hydration log for the week (goal ${GOAL} cups/day):\n\n${stats}\n\nClassify the week's trend and name the weakest day.`,
      json: {
        type: 'object',
        properties: {
          trend: { type: 'string', enum: ['improving', 'steady', 'slipping'] },
          weakestDay: { type: 'string' },
        },
        required: ['trend', 'weakestDay'],
      },
    },
    { trend: goalHits >= 4 ? 'steady' : 'slipping', weakestDay: weekEndIso },
  );

  // ── Step 2 — write the encouragement line ────────────────────────────
  const reply = await safeAgent(
    ctx,
    log,
    {
      prompt: `The week trended "${assessment.trend}" — ${goalHits}/${rows.length} goal days, ${totalCups} cups total. Write ONE short kind sentence (under 20 words) responding to this week specifically. No emoji, no exclamation marks.`,
      json: {
        type: 'object',
        properties: { encouragement: { type: 'string' } },
        required: ['encouragement'],
      },
    },
    {
      encouragement: `You logged ${totalCups} cups across ${rows.length} days — steady, quiet progress.`,
    },
  );

  // ── Step 3 — suggest one practical tip ───────────────────────────────
  const tip = await safeAgent(
    ctx,
    log,
    {
      prompt: `Suggest ONE specific, practical hydration tip for someone whose week was "${assessment.trend}". Under 15 words.`,
      json: {
        type: 'object',
        properties: { tip: { type: 'string' } },
        required: ['tip'],
      },
    },
    { tip: 'Keep a filled glass within reach of where you work.' },
  );

  await db
    .prepare(
      `INSERT OR REPLACE INTO hydrate_weekly_recaps
         (week_ending, total_cups, goal_hits, encouragement, generated_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(weekEndIso, totalCups, goalHits, reply.encouragement, Date.now());

  log.info(
    `recap for week ending ${weekEndIso}: ${totalCups} cups, ${goalHits}/${rows.length} goal days${
      sampled ? ' (sampled)' : ''
    }`,
  );

  return {
    summary: reply.encouragement,
    output: {
      weekEnding: weekEndIso,
      totalCups,
      goalHits,
      trend: assessment.trend,
      encouragement: reply.encouragement,
      tip: tip.tip,
      sampled,
    },
  };
};

/**
 * Run a `ctx.agent` call but never let a provider/CLI hiccup abort the
 * whole automation — on failure we log and fall back to a deterministic
 * value. The call is still recorded as a step on the run either way.
 *
 * @template T
 * @param {import('@centraid/openclaw-plugin').AutomationCtx} ctx
 * @param {{ warn: (msg: string) => void }} log
 * @param {{ prompt: string, json?: unknown }} call
 * @param {T} fallback
 * @returns {Promise<T>}
 */
async function safeAgent(ctx, log, call, fallback) {
  try {
    return /** @type {T} */ (await ctx.agent(call));
  } catch (err) {
    log.warn(
      `ctx.agent step failed, using fallback — ${err instanceof Error ? err.message : String(err)}`,
    );
    return fallback;
  }
}
