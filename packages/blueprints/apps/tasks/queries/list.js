/**
 * The tasks projection: every canonical task from schedule.task, sorted so
 * open work surfaces first. Everything comes from the vault — this app
 * holds no rows of its own, and (until the schedule domain grows a task
 * command pack) writes nothing back either.
 *
 * A consent denial is a first-class outcome, not an error: the UI renders
 * it as the "ask the owner for access" state, receipt id included.
 *
 * @type {import('@centraid/openclaw-plugin').QueryHandler}
 */
export default async ({ ctx }) => {
  const purpose = 'dpv:ServiceProvision';
  // schedule_task's CHECK constraint: needs-action | in-process | completed | cancelled.
  // Open statuses outrank closed ones; within a group, soonest due first,
  // undated tasks last.
  const openRank = { 'needs-action': 0, 'in-process': 0, completed: 1, cancelled: 1 };
  try {
    const result = await ctx.vault.read({ entity: 'schedule.task', purpose });
    const tasks = (result.rows ?? []).toSorted((a, b) => {
      const rank = (openRank[a.status] ?? 1) - (openRank[b.status] ?? 1);
      if (rank !== 0) return rank;
      if (a.due_at == null && b.due_at == null) return 0;
      if (a.due_at == null) return 1;
      if (b.due_at == null) return -1;
      return String(a.due_at).localeCompare(String(b.due_at));
    });
    return { tasks };
  } catch (err) {
    return { tasks: [], vaultDenied: { code: err.code, message: err.message } };
  }
};
