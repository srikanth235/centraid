const PURPOSE = "dpv:ServiceProvision";

export default async function seedHandler({ input, log, ctx }) {
  const now = new Date(input?.now ?? Date.now()).getTime();
  const day = (n) => new Date(now + n * 86400000).toISOString().slice(0, 10);
  const invoke = async (command, args) => {
    const out = await ctx.vault.invoke({
      command,
      input: args,
      purpose: PURPOSE,
    });
    if (out.status !== "executed") {
      throw new Error(`${command} ${out.status}: ${out.reason ?? "no reason"}`);
    }
    return out.output;
  };

  const vaultRow = await ctx.vault.read({
    entity: "core.vault",
    purpose: PURPOSE,
    limit: 1,
  });
  const me = vaultRow.rows?.[0]?.self_party_id;
  if (!me) throw new Error("vault has no owner party");

  const maya = await invoke("tally.add_friend", { name: "Maya" });
  const jake = await invoke("tally.add_friend", { name: "Jake" });
  const chris = await invoke("tally.add_friend", { name: "Chris" });
  const friends = [maya.party_id, jake.party_id, chris.party_id];

  const group = await invoke("tally.create_group", {
    name: "Tahoe Trip",
    icon: "🏔️",
    color: "steelblue",
    member_ids: friends,
  });

  const even = (amount, parties, payer) => {
    const base = Math.floor(amount / parties.length);
    const splits = parties.map((party_id) => ({ party_id, share_minor: base }));
    const rest = amount - base * parties.length;
    const payerSplit = splits.find((s) => s.party_id === payer) ?? splits[0];
    payerSplit.share_minor += rest;
    return splits;
  };

  const everyone = [me, ...friends];
  const expense = (
    description,
    amount_minor,
    paid_by,
    category,
    spentDaysAgo,
    parties = everyone
  ) =>
    invoke("tally.add_expense", {
      group_id: group.group_id,
      description,
      amount_minor,
      paid_by,
      category,
      spent_on: day(-spentDaysAgo),
      splits: even(amount_minor, parties, paid_by),
    });

  await expense("Cabin deposit", 30000, me, "travel", 6);
  await expense("Gas for the drive up", 4820, jake.party_id, "transport", 6);
  await expense(
    "Groceries for the cabin",
    11267,
    maya.party_id,
    "groceries",
    5
  );
  await expense("Ski rentals", 9200, chris.party_id, "fun", 4, [
    me,
    maya.party_id,
    chris.party_id,
  ]);
  await expense("Lift tickets", 6000, me, "travel", 4);

  await invoke("tally.settle_up", {
    from_party: chris.party_id,
    to_party: me,
    amount_minor: 5000,
    group_id: group.group_id,
    paid_on: day(-2),
  });

  log.info("tally scenario: 3 friends, 1 group, 5 expenses, 1 settlement");
  return { seeded: 10 };
}
