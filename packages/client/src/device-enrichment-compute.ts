// oxlint-disable-next-line typescript-eslint/triple-slash-reference -- consumer tsconfigs follow this source without including sibling declarations; governance: allow-no-unjustified-suppressions Vite asset type boundary (#414)
/// <reference path="./vite-assets.d.ts" />

// Browser compute adapters for the idle-device queue (#414 D11/D13).
// The shell owns scheduling/eligibility; this file owns bounded PDF.js text
// extraction and hardware-decoded video poster generation.
//
// TRANSCRIPTION IS NOT HERE ANY MORE (#724). Handing a recording to the
// desktop's file-ASR adapter was this file's third adapter; transcription is
// owned by its self-contained recognition automation so every derived row can
// name the versioned local model that produced it. A
// browser lane keeps only the rungs that are format conversion, where which
// implementation ran does not change the answer.

import type { PDFDocumentProxy } from "pdfjs-dist";
// oxlint-disable-next-line import/default -- Vite's ?url loader synthesizes the default URL export; governance: allow-no-unjustified-suppressions upstream module has no source-level default (#414)
import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";

// The shared browser capture pipeline. It sits on the blueprints side of the
// package edge because Photos' upload path needs it too and blueprints must
// never import `@centraid/client` — see that module's header.
import { captureVideoFrames } from "@centraid/blueprints/apps/_shared/video-frame";

import type { DeviceEnrichmentLease } from "./gateway-client-devices.js";

const MAX_TEXT_CHARS = 1_000_000;
const MAX_PDF_PAGES = 2_000;

export interface DeviceWorkContribution {
  variant: "poster" | "thumb" | "text";
  body: Blob;
  mediaType: string;
}

type PdfJs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");

let pdfRuntime: Promise<PdfJs> | undefined;

function readBlobBytes(source: Blob): Promise<ArrayBuffer> {
  const native = source as Blob & { arrayBuffer?: () => Promise<ArrayBuffer> };
  if (typeof native.arrayBuffer === "function") return native.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener(
      "load",
      () => resolve(reader.result as ArrayBuffer),
      { once: true }
    );
    reader.addEventListener(
      "error",
      () => reject(reader.error ?? new Error("blob read failed")),
      {
        once: true,
      }
    );
    // oxlint-disable-next-line unicorn/prefer-blob-reading-methods -- older WebViews/jsdom lack Blob.arrayBuffer(); governance: allow-no-unjustified-suppressions runtime compatibility fallback (#414)
    reader.readAsArrayBuffer(source);
  });
}

async function loadPdfJs(): Promise<PdfJs> {
  pdfRuntime ??= import("pdfjs-dist/legacy/build/pdf.mjs").then((pdfjs) => {
    pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
    return pdfjs;
  });
  return pdfRuntime;
}

async function extractPdfText(source: Blob): Promise<string | null> {
  const pdfjs = await loadPdfJs();
  let pdfDocument: PDFDocumentProxy | undefined;
  try {
    const options = {
      data: new Uint8Array(await readBlobBytes(source)),
      useSystemFonts: true,
      isEvalSupported: false,
    } as Parameters<typeof pdfjs.getDocument>[0] & { isEvalSupported: boolean };
    const loading = pdfjs.getDocument(options);
    const document = await loading.promise;
    pdfDocument = document;
    const pages: string[] = [];
    let chars = 0;
    const lastPage = Math.min(document.numPages, MAX_PDF_PAGES);
    // Concatenate text in document page order; parallel extraction would make
    // the rendered transcript depend on worker completion timing.
    const extractNextPage = async (pageNo: number): Promise<void> => {
      if (pageNo > lastPage) return;
      const page = await document.getPage(pageNo);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) =>
          "str" in item && typeof item.str === "string" ? item.str : ""
        )
        .filter(Boolean)
        .join(" ")
        .replace(/\s+/gu, " ")
        .trim();
      if (!text) return extractNextPage(pageNo + 1);
      const remaining = MAX_TEXT_CHARS - chars;
      if (remaining <= 0) return;
      pages.push(text.slice(0, remaining));
      chars += Math.min(text.length, remaining) + 1;
      return extractNextPage(pageNo + 1);
    };
    await extractNextPage(1);
    return pages.join("\n").trim() || null;
  } catch {
    return null;
  } finally {
    try {
      // pdfjs 6 has no `PDFDocumentProxy.destroy()`; worker teardown lives on
      // the owning loading task.
      await pdfDocument?.loadingTask.destroy();
    } catch {
      // A captured text layer remains valid when worker cleanup fails.
    }
  }
}

async function videoContributions(
  source: Blob
): Promise<DeviceWorkContribution[]> {
  const captured = await captureVideoFrames(source);
  return captured
    ? [
        ...(captured.poster
          ? [
              {
                variant: "poster" as const,
                body: captured.poster,
                mediaType: "image/jpeg",
              },
            ]
          : []),
        ...(captured.thumb
          ? [
              {
                variant: "thumb" as const,
                body: captured.thumb,
                mediaType: "image/jpeg",
              },
            ]
          : []),
      ]
    : [];
}

/** Compute every contribution fulfilled by the browser capability in one lease. */
export async function computeDeviceWorkContributions(
  lease: DeviceEnrichmentLease,
  source: Blob
): Promise<DeviceWorkContribution[]> {
  if (lease.capability === "poster") return videoContributions(source);
  if (lease.capability === "pdfText") {
    const text = await extractPdfText(source);
    return text
      ? [
          {
            variant: "text",
            body: new Blob([text], { type: "text/plain" }),
            mediaType: "text/plain",
          },
        ]
      : [];
  }
  return [];
}
