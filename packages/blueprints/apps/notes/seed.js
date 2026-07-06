/**
 * Scenario generator (issue #290 phase 1): two notebooks and a handful of
 * lived-in markdown notes, plus one loose scratch note. Runs under the demo
 * register — `seed.demo` provenance, one-click purge, never fires triggers.
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

  const travel = await invoke('knowledge.create_notebook', { name: 'Travel' });
  const recipes = await invoke('knowledge.create_notebook', { name: 'Recipes' });

  await invoke('knowledge.create_note', {
    title: 'Goa long weekend — shortlist',
    body_text:
      '## Stays\n- Anjuna: quiet, near the flea market\n- Palolem: calmer beach, longer drive\n\n## Rough budget\nStay ~₹3.5k/night, scooters ₹400/day.',
    format: 'markdown',
    notebook_id: travel.notebook_id,
  });
  await invoke('knowledge.create_note', {
    title: 'Train vs flight',
    body_text:
      'Vande Bharat gets in at 13:20, flight lands 09:40 but door-to-door is a wash. Book by Thursday either way.',
    format: 'plain',
    notebook_id: travel.notebook_id,
  });
  await invoke('knowledge.create_note', {
    title: "Amma's rasam, written down properly",
    body_text:
      '1. Pressure-cook toor dal (1/2 cup) to mush.\n2. Tamarind water from a lime-sized ball.\n3. Rasam powder 2 tsp — the Mylapore packet, not the supermarket one.\n4. Temper: mustard, curry leaves, one crushed garlic clove.\n\n*Do not skip the coriander stems.*',
    format: 'markdown',
    notebook_id: recipes.notebook_id,
  });
  await invoke('knowledge.create_note', {
    title: 'Weeknight dal makhani (pressure cooker)',
    body_text:
      'Soak urad overnight. 20 min high pressure. Finish with butter + kasuri methi. Freezes well in 2-portion boxes.',
    format: 'plain',
    notebook_id: recipes.notebook_id,
  });
  await invoke('knowledge.create_note', {
    title: 'Scratch — books people keep recommending',
    body_text: 'The Design of Everyday Things (again), Salt Fat Acid Heat, Project Hail Mary.',
    format: 'plain',
  });

  log.info('notes scenario: 2 notebooks + 5 notes seeded');
  return { seeded: 7 };
};
