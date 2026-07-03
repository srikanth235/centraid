/**
 * Vitals nudge — an evening cron asks the canon one question: did anything
 * get observed in the last day? The time window rides the vault's
 * `within-days` filter (the gateway computes "now" server-side), so the
 * handler stays deterministic and replay-safe — no wall-clock reads here.
 *
 * Available on `ctx`:
 *   ctx.vault.read/invoke  — consent-checked canon access (this automation's
 *                            enrolled agent; every call is receipted)
 *   ctx.state.get/set/del  — cross-run key/value persistence
 *
 * Return `{ summary?, output? }` — `summary` shows in the run list.
 */
export default async ({ ctx }) => {
  const today = await ctx.vault.read({
    entity: 'core.observation',
    where: [{ column: 'observed_at', op: 'within-days', value: 1 }],
    limit: 1,
    purpose: 'dpv:HealthMonitoring',
  });
  if ((today.rows || []).length > 0) {
    return { summary: 'vitals already logged today', output: { nudged: false } };
  }
  const outcome = await ctx.vault.invoke({
    command: 'schedule.add_task',
    input: {
      title: 'Log your vitals',
      description: 'No reading landed today — take one before bed to keep the record honest.',
    },
    purpose: 'dpv:HealthMonitoring',
  });
  return { summary: 'nudge task filed', output: { nudged: true, status: outcome.status } };
};
