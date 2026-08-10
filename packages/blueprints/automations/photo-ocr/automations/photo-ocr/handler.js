const BATCH = 16;
const PURPOSE = "dpv:ServiceProvision";
const PROMPT_REV = "ocr-v1";

function canonicalRegions(raw, width, height) {
  if (!raw) return [];
  if (!Array.isArray(raw.regions))
    return typeof raw.text === "string" && raw.text.trim()
      ? [{ text: raw.text, order: 0 }]
      : [];
  return raw.regions.flatMap((region, order) => {
    if (!region || typeof region.text !== "string") return [];
    const confidence = region.confidence;
    if (
      confidence !== undefined &&
      (typeof confidence !== "number" || confidence < 0 || confidence > 1)
    )
      return [];
    const box =
      Array.isArray(region.box) && region.box.length === 4 ? region.box : null;
    const validBox =
      box &&
      box.every(
        (value) =>
          typeof value === "number" && Number.isSafeInteger(value) && value >= 0
      ) &&
      box[2] > 0 &&
      box[3] > 0 &&
      (!width || box[0] + box[2] <= width) &&
      (!height || box[1] + box[3] <= height);
    return [
      {
        text: region.text,
        order,
        ...(validBox ? { box } : {}),
        ...(confidence === undefined ? {} : { confidence }),
      },
    ];
  });
}

function readingOrder(regions) {
  return [...regions]
    .sort((a, b) =>
      a.box && b.box
        ? a.box[1] - b.box[1] || a.box[0] - b.box[0]
        : a.order - b.order
    )
    .map((region) => region.text)
    .join("\n");
}

async function serviceModel(ctx) {
  const response = await ctx.fetch({
    url: "centraid://enrichment/ocr",
    method: "GET",
  });
  const body = JSON.parse(response.text);
  return body.status === "ok" ? body.model : null;
}

function captureInput(input) {
  const capture = input?.capture;
  if (!capture || typeof capture !== "object") return null;
  if (typeof capture.bytes !== "string" || !capture.bytes)
    throw new Error("capture OCR needs base64 image bytes");
  if (
    typeof capture.mediaType !== "string" ||
    !capture.mediaType.startsWith("image/")
  )
    throw new Error("capture OCR needs an image media type");
  return capture;
}

async function recognizeCapture(ctx, capture) {
  const response = await ctx.fetch({
    url: "centraid://enrichment/ocr",
    method: "POST",
    body: JSON.stringify({
      items: [
        { id: "capture", bytes: capture.bytes, mediaType: capture.mediaType },
      ],
    }),
  });
  const outcome = JSON.parse(response.text);
  if (outcome.status !== "ok")
    throw new Error(
      `capture OCR unavailable: ${outcome.reason ?? "service refused the request"}`
    );
  const result = outcome.results?.[0];
  if (!result || result.error)
    throw new Error(result?.error ?? "capture OCR returned no result");
  const regions = canonicalRegions(result);
  const scored = regions.filter((region) => region.confidence !== undefined);
  const confidence = scored.length
    ? scored.reduce((sum, region) => sum + region.confidence, 0) / scored.length
    : undefined;
  const text = readingOrder(regions);
  return {
    summary: text
      ? "Capture OCR completed"
      : "Capture OCR found no legible text",
    output: {
      text,
      engine: "enrichment-service",
      model: outcome.model,
      ...(confidence === undefined ? {} : { confidence }),
    },
  };
}

async function seedAssetCursor(ctx, model) {
  const latest = await ctx.vault.read({
    entity: "media.media_asset",
    where: [
      { column: "kind", op: "in", value: ["photo", "scan"] },
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
      { column: "variant", op: "eq", value: "text" },
    ],
    limit: 1,
    purpose: PURPOSE,
  });
  return stamps.rows?.[0]?.model === model ? asset.asset_id : "";
}

export default async function handler({ ctx, log }) {
  const capture = captureInput(ctx.input);
  if (capture) return recognizeCapture(ctx, capture);
  const agentVariant = ctx.input?.variant === "agent";
  const pinnedModel = agentVariant
    ? ctx.input?.agentModel
    : await serviceModel(ctx);
  if (!pinnedModel) {
    if (agentVariant)
      throw new Error("agent OCR requires an explicit pinned model");
    return { summary: "OCR skipped — deterministic service unavailable" };
  }
  const selection = `${agentVariant ? "agent" : "deterministic"}:${pinnedModel}:${agentVariant ? PROMPT_REV : "service"}`;
  const priorSelection = await ctx.state.get("selection");
  if (priorSelection !== selection) {
    const seed =
      priorSelection === undefined && !agentVariant
        ? await seedAssetCursor(ctx, pinnedModel)
        : "";
    await ctx.state.set("cursor", seed);
    await ctx.state.set("selection", selection);
    await ctx.state.delete("confirmedModel");
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
  const assets = (read.rows ?? []).filter(
    (row) => row.kind === "photo" || row.kind === "scan"
  );
  let derived = 0;
  let skipped = 0;
  for (const asset of assets) {
    const stamps = await ctx.vault.read({
      entity: "enrich.derivation",
      where: [
        { column: "target_id", op: "eq", value: asset.content_id },
        { column: "variant", op: "eq", value: "text" },
      ],
      limit: 1,
      purpose: PURPOSE,
    });
    const stamp = stamps.rows?.[0];
    let confirmedModel = agentVariant
      ? await ctx.state.get("confirmedModel")
      : pinnedModel;
    const stampedPrompt =
      typeof stamp?.payload_json === "string"
        ? JSON.parse(stamp.payload_json).prompt_rev
        : stamp?.prompt_rev;
    if (
      stamp?.model === confirmedModel &&
      (!agentVariant || stampedPrompt === PROMPT_REV)
    ) {
      skipped += 1;
      continue;
    }
    let regions;
    if (ctx.input?.variant === "agent") {
      const answer = await ctx.agent({
        prompt:
          "Transcribe all visible text in reading order. Return regions with text and optional [x,y,w,h] boxes; never invent confidence.",
        json: {
          type: "object",
          required: ["regions"],
          properties: { regions: { type: "array" } },
        },
        content: [
          {
            contentId: asset.content_id,
            variant: "preview",
            maxBytes: 8388608,
          },
        ],
      });
      if (typeof answer?.__centraidModel !== "string")
        throw new Error("agent OCR returned no ACP-confirmed model identity");
      confirmedModel = answer.__centraidModel;
      await ctx.state.set("confirmedModel", confirmedModel);
      regions = canonicalRegions(answer, asset.width, asset.height);
    } else {
      const response = await ctx.fetch({
        url: "centraid://enrichment/ocr",
        method: "POST",
        body: JSON.stringify({
          items: [
            {
              id: asset.content_id,
              originalWidth: asset.width,
              originalHeight: asset.height,
            },
          ],
        }),
        content: [
          {
            contentId: asset.content_id,
            variant: "preview",
            maxBytes: 8388608,
          },
        ],
      });
      const outcome = JSON.parse(response.text);
      regions =
        outcome.status === "ok"
          ? canonicalRegions(outcome.results[0], asset.width, asset.height)
          : [];
    }
    const text = readingOrder(regions);
    if (!text) {
      skipped += 1;
      log.info(`photo ${asset.asset_id}: no legible text`);
      continue;
    }
    const scored = regions.filter((region) => region.confidence !== undefined);
    const confidence = scored.length
      ? scored.reduce((sum, region) => sum + region.confidence, 0) /
        scored.length
      : undefined;
    const normalizedRegions = regions.map(
      ({ order: _order, ...region }) => region
    );
    await ctx.vault.invoke({
      command: "core.set_extracted_text",
      input: {
        content_id: asset.content_id,
        text,
        capability: "ocr",
        model: confirmedModel,
        regions: normalizedRegions,
        ...(agentVariant ? { prompt_rev: PROMPT_REV } : {}),
        ...(confidence === undefined ? {} : { confidence }),
      },
      purpose: PURPOSE,
    });
    derived += 1;
  }
  const last = read.rows?.at(-1)?.asset_id;
  if (last) await ctx.state.set("cursor", last);
  const rearm = (read.rows?.length ?? 0) === BATCH;
  return {
    summary: `OCR derived ${derived}; skipped ${skipped}; batch ${read.rows?.length ?? 0}/${BATCH}`,
    output: {
      derived,
      skipped,
      model: agentVariant
        ? ((await ctx.state.get("confirmedModel")) ?? pinnedModel)
        : pinnedModel,
      rearm,
    },
  };
}
