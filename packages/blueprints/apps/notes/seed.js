/**
 * Scenario generator (issue #290 phase 1): two notebooks and a handful of
 * lived-in markdown notes, plus one loose scratch note. Runs under the demo
 * register — `seed.demo` provenance, one-click purge, never fires triggers.
 */

export default async function seedHandler({ log, ctx }) {
  const invoke = async (command, args) => {
    const out = await ctx.vault.invoke({
      command,
      input: args,
    });
    if (out.status !== "executed") {
      throw new Error(`${command} ${out.status}: ${out.reason ?? "no reason"}`);
    }
    return out.output;
  };

  const travel = await invoke("knowledge.create_notebook", { name: "Travel" });
  const recipes = await invoke("knowledge.create_notebook", {
    name: "Recipes",
  });

  await invoke("knowledge.create_note", {
    title: "Tahoe long weekend — shortlist",
    body_text:
      "## Stays\n- South Lake: walkable, closer to the good food\n- Truckee: quieter, longer drive to the water\n\n## Rough budget\nCabin ~$180/night, plus gas both ways.",
    format: "markdown",
    notebook_id: travel.notebook_id,
  });
  await invoke("knowledge.create_note", {
    title: "Drive vs fly",
    body_text:
      "I-80 is four hours clean, six if we leave Friday after five. Reno flight lands 09:40 but door-to-door is a wash. Book by Thursday either way.",
    format: "plain",
    notebook_id: travel.notebook_id,
  });
  await invoke("knowledge.create_note", {
    title: "Mom's chili, written down properly",
    body_text:
      "1. Brown 2 lb chuck in batches — crowding steams it.\n2. Onion, garlic, one poblano until soft.\n3. Chili powder 3 tbsp, cumin 1 tbsp, bloom in the fat.\n4. Crushed tomatoes, beans, a splash of coffee. Two hours low.\n\n*Do not skip the coffee.*",
    format: "markdown",
    notebook_id: recipes.notebook_id,
  });
  await invoke("knowledge.create_note", {
    title: "Weeknight mac and cheese",
    body_text:
      "Boil the pasta short. Butter, flour, milk, then sharp cheddar off the heat. Freezes well in 2-portion boxes.",
    format: "plain",
    notebook_id: recipes.notebook_id,
  });
  await invoke("knowledge.create_note", {
    title: "Scratch — books people keep recommending",
    body_text:
      "The Design of Everyday Things (again), Salt Fat Acid Heat, Project Hail Mary.",
    format: "plain",
  });

  log.info("notes scenario: 2 notebooks + 5 notes seeded");
  return { seeded: 7 };
}
