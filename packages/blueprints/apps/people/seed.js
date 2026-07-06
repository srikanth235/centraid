/**
 * Scenario generator (issue #290 phase 1): a small living circle — people
 * with contact cadences, logged interactions, birthdays, gift ideas and one
 * outstanding debt. Runs under the demo register — `seed.demo` provenance,
 * one-click purge, never fires triggers or reminders.
 */
const PURPOSE = 'dpv:ServiceProvision';

export default async ({ log, ctx }) => {
  const invoke = async (command, args) => {
    const out = await ctx.vault.invoke({ command, input: args, purpose: PURPOSE });
    if (out.status !== 'executed') {
      throw new Error(`${command} ${out.status}: ${out.reason ?? 'no reason'}`);
    }
    return out.output;
  };
  const person = (args) => invoke('people.add_person', args);

  const meera = await person({
    display_name: 'Meera Pillai',
    role: 'College friend',
    cadence_days: 30,
  });
  const arjun = await person({
    display_name: 'Arjun Rao',
    role: 'Flatmate from Bangalore days',
    cadence_days: 45,
  });
  const dadu = await person({ display_name: 'Dadu', role: 'Grandfather', cadence_days: 7 });
  const sana = await person({
    display_name: 'Sana Qureshi',
    role: 'Design lead, ex-colleague',
    cadence_days: 60,
  });

  await invoke('people.log_interaction', {
    party_id: meera.party_id,
    kind: 'call',
    text: 'Caught up about her Pune move; she wants the Goa dates.',
  });
  await invoke('people.log_interaction', {
    party_id: dadu.party_id,
    kind: 'visit',
    text: 'Sunday lunch. BP is under control again; he beat me at carrom twice.',
  });
  await invoke('people.log_interaction', {
    party_id: sana.party_id,
    kind: 'message',
    text: 'Sent the portfolio feedback she asked for.',
  });

  await invoke('people.add_important_date', {
    party_id: dadu.party_id,
    label: 'Birthday',
    month_day: '08-14',
    reminder_on: true,
  });
  await invoke('people.add_important_date', {
    party_id: meera.party_id,
    label: 'Birthday',
    month_day: '11-02',
  });

  await invoke('people.add_gift', {
    party_id: dadu.party_id,
    text: 'Large-print edition of Malgudi Days',
  });
  await invoke('people.add_gift', { party_id: sana.party_id, text: 'Fountain pen ink sampler' });

  await invoke('people.add_debt', {
    party_id: arjun.party_id,
    direction: 'owe',
    amount_minor: 120000,
    reason: 'His half of the deposit refund',
  });

  log.info('people scenario: 4 people, 3 interactions, 2 dates, 2 gifts, 1 debt');
  return { seeded: 12 };
};
