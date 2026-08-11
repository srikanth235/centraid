/* oxlint-disable no-await-in-loop -- bounded page and vault walks are intentionally serial to cap native-model memory and preserve cursor/write order */
/* oxlint-disable typescript/no-extraneous-class, eslint/max-classes-per-file -- pdf.js requires constructor classes for its DOMMatrix and CanvasFactory extension points */
import { pathToFileURL } from "node:url";

import {
  OCR_MODEL_ID,
  ocr,
  ocrWeightsPresent,
} from "../src/capabilities/ocr.js";
import { resolveRuntimeModule } from "../src/onnx.js";

const BATCH = 16;
const PURPOSE = "dpv:ServiceProvision";
const PROMPT_REV = "ocr-v1";

let recognize = ocr;
let weightsPresent = ocrWeightsPresent;
const loadRuntimePdfJs = async () => {
  const resolved = resolveRuntimeModule("pdfjs-dist/legacy/build/pdf.mjs");
  return import(pathToFileURL(resolved).href);
};
let loadPdfJs = loadRuntimePdfJs;

/** Test-only replacement retained in the generated bundle. */
export function setPhotoOcrRuntimeForTests(runtime) {
  recognize = runtime?.recognize ?? ocr;
  weightsPresent = runtime?.weightsPresent ?? ocrWeightsPresent;
  loadPdfJs = runtime?.loadPdfJs ?? loadRuntimePdfJs;
}

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

function modelAvailable() {
  return weightsPresent() ? OCR_MODEL_ID : null;
}

function captureInput(input) {
  const capture = input?.capture;
  if (!capture || typeof capture !== "object") return null;
  if (typeof capture.bytes !== "string" || !capture.bytes)
    throw new Error("capture OCR needs base64 content bytes");
  if (
    typeof capture.mediaType !== "string" ||
    (!capture.mediaType.startsWith("image/") &&
      capture.mediaType !== "application/pdf")
  )
    throw new Error("capture OCR needs an image or PDF media type");
  return capture;
}

async function recognizeOne(item) {
  const result = await recognize(item);
  if (!result || result.error)
    throw new Error(result?.error ?? "OCR returned no result");
  return result;
}

async function recognizePdf(capture) {
  // pdf.js constructs one identity matrix while evaluating its display layer,
  // even when we only ask for a born-digital text layer. The automation worker
  // deliberately has no browser DOM, so give that parse-only path the tiny
  // 2D shape it needs without making text PDFs depend on native canvas.
  globalThis.DOMMatrix ??= class ParseOnlyDOMMatrix {
    constructor(values = [1, 0, 0, 1, 0, 0]) {
      [this.a, this.b, this.c, this.d, this.e, this.f] = values;
    }
  };
  // Load PDF.js from the shared recognition runtime rather than embedding its
  // ~2.6 MB worker/runtime in every published handler. Because pdf.mjs keeps
  // its real package URL, its sibling pdf.worker.mjs resolves normally.
  const pdfjs = await loadPdfJs();
  const bytes = Buffer.from(capture.bytes, "base64");
  const document = await pdfjs.getDocument({
    data: new Uint8Array(bytes),
    disableWorker: true,
  }).promise;
  const regions = [];
  let renderedDocument;
  const pageLimit = Math.min(document.numPages, 64);
  for (let pageNumber = 1; pageNumber <= pageLimit; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const textLayer = await page.getTextContent();
    const embeddedText = textLayer.items
      .flatMap((item) =>
        item && typeof item === "object" && "str" in item
          ? [String(item.str).trim()]
          : []
      )
      .filter(Boolean)
      .join(" ");
    if (embeddedText) {
      regions.push({ text: embeddedText, page: pageNumber });
      continue;
    }
    const canvasModule = await import(resolveRuntimeModule("@napi-rs/canvas"));
    globalThis.DOMMatrix = canvasModule.DOMMatrix;
    globalThis.ImageData = canvasModule.ImageData;
    globalThis.Path2D = canvasModule.Path2D;
    class AutomationCanvasFactory {
      create(width, height) {
        const canvas = canvasModule.createCanvas(width, height);
        return { canvas, context: canvas.getContext("2d") };
      }
      reset(entry, width, height) {
        entry.canvas.width = width;
        entry.canvas.height = height;
      }
      destroy(entry) {
        entry.canvas.width = 0;
        entry.canvas.height = 0;
      }
    }
    renderedDocument ??= await pdfjs.getDocument({
      data: new Uint8Array(bytes),
      disableWorker: true,
      CanvasFactory: AutomationCanvasFactory,
    }).promise;
    const renderedPage = await renderedDocument.getPage(pageNumber);
    const viewport = renderedPage.getViewport({ scale: 2 });
    const canvas = canvasModule.createCanvas(
      Math.ceil(viewport.width),
      Math.ceil(viewport.height)
    );
    const context = canvas.getContext("2d");
    await renderedPage.render({
      canvas,
      canvasContext: context,
      viewport,
    }).promise;
    const rendered = canvas.toBuffer("image/png").toString("base64");
    const result = await recognizeOne({
      id: `capture:${pageNumber}`,
      bytes: rendered,
      mediaType: "image/png",
    });
    for (const region of result.regions ?? [])
      regions.push({ ...region, page: pageNumber });
  }
  return { id: "capture", regions };
}

async function recognizeCapture(capture) {
  if (!modelAvailable())
    throw new Error(
      "capture OCR unavailable: install the bundled automation model assets"
    );
  const result =
    capture.mediaType === "application/pdf"
      ? await recognizePdf(capture)
      : await recognizeOne({
          id: "capture",
          bytes: capture.bytes,
          mediaType: capture.mediaType,
        });
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
      engine: "automation",
      model: OCR_MODEL_ID,
      ...(confidence === undefined ? {} : { confidence }),
    },
  };
}

async function seedAssetCursor(ctx, model) {
  const latest = await ctx.vault.read({
    entity: "media.asset",
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

async function deterministicRegions(ctx, asset) {
  const content = await ctx.vault.content({
    contentId: asset.content_id,
    variant: "preview",
    maxBytes: 4 * 1024 * 1024,
    purpose: PURPOSE,
  });
  if (content?.status !== "ok" || content.kind !== "bytes")
    throw new Error(`asset ${asset.asset_id}: preview is unavailable`);
  const result = await recognizeOne({
    id: asset.content_id,
    bytes: content.base64,
    mediaType: content.mediaType,
    originalWidth: asset.width,
    originalHeight: asset.height,
  });
  return canonicalRegions(result, asset.width, asset.height);
}

export default async function handler({ ctx, log }) {
  const capture = captureInput(ctx.input);
  if (capture) return recognizeCapture(capture);
  const agentVariant = ctx.input?.variant === "agent";
  const pinnedModel = agentVariant ? ctx.input?.agentModel : modelAvailable();
  if (!pinnedModel) {
    if (agentVariant)
      throw new Error("agent OCR requires an explicit pinned model");
    return { summary: "OCR skipped — automation model assets unavailable" };
  }
  const selection = `${agentVariant ? "agent" : "deterministic"}:${pinnedModel}:${agentVariant ? PROMPT_REV : "local"}`;
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
    entity: "media.asset",
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
    if (agentVariant) {
      const answer = await ctx.delegate({
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
            maxBytes: 4 * 1024 * 1024,
          },
        ],
      });
      if (typeof answer?.__centraidModel !== "string")
        throw new Error("agent OCR returned no ACP-confirmed model identity");
      confirmedModel = answer.__centraidModel;
      await ctx.state.set("confirmedModel", confirmedModel);
      regions = canonicalRegions(answer, asset.width, asset.height);
    } else {
      regions = await deterministicRegions(ctx, asset);
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
  return {
    summary: `OCR derived ${derived}; skipped ${skipped}; batch ${read.rows?.length ?? 0}/${BATCH}`,
    output: {
      derived,
      skipped,
      model: agentVariant
        ? ((await ctx.state.get("confirmedModel")) ?? pinnedModel)
        : pinnedModel,
      rearm: (read.rows?.length ?? 0) === BATCH,
    },
  };
}
