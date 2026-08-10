const BATCH = 16;
const PURPOSE = "dpv:ServiceProvision";

async function modelFor(ctx) {
  const response = await ctx.fetch({
    url: "centraid://enrichment/transcript",
    method: "GET",
  });
  const body = JSON.parse(response.text);
  return body.status === "ok" ? body.model : null;
}

async function seedCursor(ctx, model) {
  const latest = await ctx.vault.read({
    entity: "media.media_asset",
    where: [
      { column: "kind", op: "in", value: ["audio", "video"] },
      { column: "deleted_at", op: "is-null" },
    ],
    orderBy: { column: "asset_id", dir: "desc" },
    limit: 1,
    purpose: PURPOSE,
  });
  const asset = latest.rows?.[0];
  if (!asset) return "";
  const stamps = await ctx.vault.read({
    entity: "enrich.derivation",
    where: [
      { column: "target_id", op: "eq", value: asset.content_id },
      { column: "variant", op: "eq", value: "transcript" },
    ],
    limit: 1,
    purpose: PURPOSE,
  });
  return stamps.rows?.[0]?.model === model ? asset.asset_id : "";
}

export default async function handler({ ctx, log }) {
  const model = await modelFor(ctx);
  if (!model)
    return {
      summary: "transcript skipped — deterministic service unavailable",
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
    entity: "media.media_asset",
    where: [
      { column: "asset_id", op: "gt", value: cursor },
      { column: "deleted_at", op: "is-null" },
    ],
    orderBy: { column: "asset_id", dir: "asc" },
    limit: BATCH,
    purpose: PURPOSE,
  });
  let derived = 0;
  let skipped = 0;
  for (const asset of read.rows ?? []) {
    if (asset.kind !== "audio" && asset.kind !== "video") {
      skipped += 1;
      continue;
    }
    const stamps = await ctx.vault.read({
      entity: "enrich.derivation",
      where: [
        { column: "target_id", op: "eq", value: asset.content_id },
        { column: "variant", op: "eq", value: "transcript" },
      ],
      limit: 1,
      purpose: PURPOSE,
    });
    if (stamps.rows?.[0]?.model === model) {
      skipped += 1;
      continue;
    }
    const response = await ctx.fetch({
      url: "centraid://enrichment/transcript",
      method: "POST",
      body: JSON.stringify({ items: [{ id: asset.content_id }] }),
      content: [
        {
          contentId: asset.content_id,
          variant: "original",
          maxBytes: 16777216,
        },
      ],
    });
    const outcome = JSON.parse(response.text);
    const result = outcome.status === "ok" ? outcome.results[0] : null;
    if (!result || typeof result.text !== "string" || !result.text.trim()) {
      skipped += 1;
      log.info(`asset ${asset.asset_id}: no transcript`);
      continue;
    }
    await ctx.vault.invoke({
      command: "core.set_extracted_text",
      input: {
        content_id: asset.content_id,
        variant: "transcript",
        text: result.text,
        capability: "transcript",
        model: outcome.model,
        ...(result.confidence === undefined
          ? {}
          : { confidence: result.confidence }),
      },
      purpose: PURPOSE,
    });
    derived += 1;
  }
  const last = read.rows?.at(-1)?.asset_id;
  if (last) await ctx.state.set("cursor", last);
  return {
    summary: `transcribed ${derived}; skipped ${skipped}; bounded batch ${read.rows?.length ?? 0}/${BATCH}`,
    output: {
      derived,
      skipped,
      model,
      rearm: (read.rows?.length ?? 0) === BATCH,
    },
  };
}
