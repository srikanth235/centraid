/**
 * Scenario generator (issue #290 phase 1): a believable week on the board —
 * overdue errands, a project with subtasks, done items, a someday idea.
 * Runs under the demo register: owner credential, `seed.demo` provenance,
 * invisible to automations, one-click purge. Deterministic: dates derive
 * from input.now and choices from input.seed, so a reload reproduces the
 * same scenario (tests ride this too).
 */
const PURPOSE = 'dpv:ServiceProvision';

export default async ({ input, log, ctx }) => {
  const now = new Date(input?.now ?? Date.now()).getTime();
  const day = (n) => new Date(now + n * 86400000).toISOString();
  const invoke = async (command, args) => {
    const out = await ctx.vault.invoke({ command, input: args, purpose: PURPOSE });
    if (out.status !== 'executed') {
      throw new Error(`${command} ${out.status}: ${out.reason ?? 'no reason'}`);
    }
    return out.output;
  };

  const add = (args) => invoke('schedule.add_task', args);
  const done = (task_id) => invoke('schedule.set_task_status', { task_id, status: 'completed' });

  await add({ title: 'Renew car insurance', due_at: day(-2), priority: 8 });
  await add({ title: 'Book dentist appointment', due_at: day(1), priority: 5, effort_min: 15 });
  await add({
    title: 'Water the balcony plants',
    description: 'The basil is looking thirsty.',
    due_at: day(0),
    priority: 3,
  });

  const trip = await add({
    title: 'Plan the Goa trip',
    description: 'Long weekend with the college gang.',
    due_at: day(7),
    priority: 6,
  });
  await add({ title: 'Compare beach-side stays', parent_task_id: trip.task_id, effort_min: 45 });
  await add({ title: 'Check train availability', parent_task_id: trip.task_id, due_at: day(3) });
  const packed = await add({ title: 'Draft packing list', parent_task_id: trip.task_id });
  await done(packed.task_id);

  const groceries = await add({ title: 'Weekly groceries run', due_at: day(-1), priority: 4 });
  await done(groceries.task_id);
  await add({ title: 'Learn to make sourdough', priority: 1 });

  log.info('tasks scenario: 9 tasks seeded (2 completed, 1 project with subtasks)');
  return { seeded: 9 };
};
