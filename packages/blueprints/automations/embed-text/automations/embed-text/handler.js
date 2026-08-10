const BATCH = 16;
const PURPOSE = "dpv:ServiceProvision";

async function modelFor(ctx) {
  const response = await ctx.fetch({
    url: "centraid://enrichment/embed-text",
    method: "GET",
  });
  const body = JSON.parse(response.text);
  return body.status === "ok" ? body.model : null;
}

async function seedCursor(ctx, model) {
  const latest = await ctx.vault.read({
    entity: "core.content_derivative",
    where: [{ column: "variant", op: "in", value: ["text", "transcript"] }],
    orderBy: { column: "derivative_id", dir: "desc" },
    limit: 1,
    purpose: PURPOSE,
  });
  const item = latest.rows?.[0];
  if (!item) return "";
  const stamps = await ctx.vault.read({
    entity: "enrich.derivation",
    where: [
      { column: "target_id", op: "eq", value: item.content_id },
      { column: "variant", op: "eq", value: "embedding" },
    ],
    limit: 1,
    purpose: PURPOSE,
  });
  return stamps.rows?.[0]?.model === model ? item.derivative_id : "";
}

export default async function handler({ ctx, log }) {
  const model = await modelFor(ctx);
  if (!model)
    return {
      summary: "text embedding skipped — deterministic service unavailable",
    };
  const priorModel = await ctx.state.get("model");
  if (priorModel !== model) {
    await ctx.state.set(
      "cursor",
      priorModel === undefined ? await seedCursor(ctx, model) : ""
    );
    await ctx.state.set("model", model);
  }
  const cursor = (await ctx.state.get("cursor")) ?? "";
  const read = await ctx.vault.read({
    entity: "core.content_derivative",
    where: [
      { column: "derivative_id", op: "gt", value: cursor },
      { column: "variant", op: "in", value: ["text", "transcript"] },
    ],
    orderBy: { column: "derivative_id", dir: "asc" },
    limit: BATCH,
    purpose: PURPOSE,
  });
  let derived = 0;
  let skipped = 0;
  for (const item of read.rows ?? []) {
    const stamps = await ctx.vault.read({
      entity: "enrich.derivation",
      where: [
        { column: "target_id", op: "eq", value: item.content_id },
        { column: "variant", op: "eq", value: "embedding" },
      ],
      limit: 1,
      purpose: PURPOSE,
    });
    if (stamps.rows?.[0]?.model === model) {
      skipped += 1;
      continue;
    }
    const response = await ctx.fetch({
      url: "centraid://enrichment/embed-text",
      method: "POST",
      body: JSON.stringify({ items: [{ id: item.content_id }] }),
      content: [
        {
          contentId: item.content_id,
          variant: item.variant,
          maxBytes: 1048576,
        },
      ],
    });
    const outcome = JSON.parse(response.text);
    const result = outcome.status === "ok" ? outcome.results[0] : null;
    if (!result || !Array.isArray(result.vector)) {
      skipped += 1;
      log.info(`content ${item.content_id}: no text vector`);
      continue;
    }
    await ctx.vault.invoke({
      command: "enrich.upsert_embedding",
      input: {
        entity_type: "core.content_item",
        entity_id: item.content_id,
        model: outcome.model,
        vector: result.vector,
        capability: "embed-text",
      },
      purpose: PURPOSE,
    });
    derived += 1;
  }
  const last = read.rows?.at(-1)?.derivative_id;
  if (last) await ctx.state.set("cursor", last);
  return {
    summary: `embedded ${derived} texts; skipped ${skipped}; bounded batch ${read.rows?.length ?? 0}/${BATCH}`,
    output: {
      derived,
      skipped,
      model,
      rearm: (read.rows?.length ?? 0) === BATCH,
    },
  };
}
