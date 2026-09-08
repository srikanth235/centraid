/**
 * Scenario generator (issue #290 phase 1): a small living circle — people
 * with contact cadences, logged interactions, birthdays, canonical gift tasks
 * and one outstanding debt. Runs under the demo register — `seed.demo` provenance,
 * one-click purge, never fires triggers or reminders.
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
  const person = (args) => invoke("people.add_person", args);

  const maya = await person({
    display_name: "Maya Alvarez",
    role: "College friend",
    cadence_days: 30,
  });
  const jake = await person({
    display_name: "Jake Bennett",
    role: "Old roommate from Portland",
    cadence_days: 45,
  });
  const grandpa = await person({
    display_name: "Grandpa Ray",
    role: "Grandfather",
    cadence_days: 7,
  });
  const chris = await person({
    display_name: "Chris Okafor",
    role: "Design lead, ex-colleague",
    cadence_days: 60,
  });

  await invoke("people.log_interaction", {
    party_id: maya.party_id,
    kind: "call",
    text: "Caught up about her Denver move; she wants the Tahoe dates.",
  });
  await invoke("people.log_interaction", {
    party_id: grandpa.party_id,
    kind: "visit",
    text: "Sunday lunch. Blood pressure is under control again; he beat me at cribbage twice.",
  });
  await invoke("people.log_interaction", {
    party_id: chris.party_id,
    kind: "message",
    text: "Sent the portfolio feedback he asked for.",
  });

  await invoke("people.add_important_date", {
    party_id: grandpa.party_id,
    label: "Birthday",
    month_day: "08-14",
    reminder_on: true,
  });
  await invoke("people.add_important_date", {
    party_id: maya.party_id,
    label: "Birthday",
    month_day: "11-02",
  });

  await invoke("people.add_gift", {
    party_id: grandpa.party_id,
    text: "Large-print edition of Lonesome Dove",
  });
  await invoke("people.add_gift", {
    party_id: chris.party_id,
    text: "Fountain pen ink sampler",
  });

  await invoke("people.add_debt", {
    party_id: jake.party_id,
    direction: "owe",
    amount_minor: 15000,
    reason: "His half of the cabin deposit",
  });

  log.info(
    "people scenario: 4 people, 3 interactions, 2 dates, 2 gifts, 1 debt"
  );
  return { seeded: 12 };
}
