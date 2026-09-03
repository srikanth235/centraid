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

  const markdown = (text) =>
    `data:text/markdown;charset=utf-8,${encodeURIComponent(text)}`;

  const travel = await invoke("core.create_folder", { name: "Travel" });
  const home = await invoke("core.create_folder", { name: "Home" });

  const packing = await invoke("core.add_document", {
    title: "Tahoe packing list",
    folder_id: travel.folder_id,
    data_uri: markdown(
      `# Tahoe packing list\n\nLeaving ${day(3)}, back ${day(6)}.\n\n` +
        "- Rain shell\n- Hiking boots\n- Headlamp\n- Swimsuit (the cabin has a hot tub)\n- Board games\n"
    ),
  });
  // `revises` links between CONTENT items, minted by this call (issue #352).
  await invoke("core.edit_document", {
    document_id: packing.document_id,
    body_text:
      `# Tahoe packing list\n\nLeaving ${day(3)}, back ${day(6)}.\n\n` +
      "- Rain shell\n- Hiking boots\n- Headlamp\n- Swimsuit (the cabin has a hot tub)\n- Board games\n" +
      "- Tire chains (I-80 requires them after a storm)\n- Cooler for the drive\n",
  });
  await invoke("core.star_document", { document_id: packing.document_id });
  await invoke("core.tag_item", {
    subject_type: "core.document",
    subject_id: packing.document_id,
    label: "tahoe",
  });

  await invoke("core.add_document", {
    title: "Cabin rental agreement (sample)",
    folder_id: travel.folder_id,
    data_uri: markdown(
      "# Cabin rental agreement (sample)\n\nThis is sample demo data, not a real agreement.\n\n" +
        `- Property: 3BR cabin, South Lake Tahoe\n- Nights: ${day(3)} to ${day(6)}\n` +
        "- Rate: $180 per night\n- Deposit: $300, refundable\n- Check-in 4pm, check-out 10am\n- No smoking; dogs welcome\n"
    ),
  });
  await invoke("core.add_document", {
    title: "Renters insurance policy (sample)",
    folder_id: home.folder_id,
    data_uri: markdown(
      "# Renters insurance policy (sample)\n\nThis is sample demo data, not a real policy.\n\n" +
        "- Policy number: SAMPLE-0000-0000\n- Personal property: $30,000\n- Liability: $100,000\n" +
        "- Deductible: $500\n- Renews annually\n"
    ),
  });

  log.info(
    "docs scenario: 2 folders, 3 documents (1 starred + tagged, 1 with two versions)"
  );
  return { seeded: 5 };
}
