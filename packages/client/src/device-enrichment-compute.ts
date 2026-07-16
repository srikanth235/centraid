// eslint-disable-next-line typescript-eslint/triple-slash-reference -- consumer tsconfigs follow this source without including sibling declarations; governance: allow-no-unjustified-suppressions Vite asset type boundary (#414)
/// <reference path="./vite-assets.d.ts" />

// Browser compute adapters for the idle-device queue (issue #414 D11/D13).
// The shell owns scheduling/eligibility; this file owns bounded PDF.js text
// extraction and hardware-decoded video poster generation.

// eslint-disable-next-line import/default -- Vite's ?url loader synthesizes the default URL export; governance: allow-no-unjustified-suppressions upstream module has no source-level default (#414)
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { DeviceEnrichmentLease } from './gateway-client-devices.js';
import { captureVideoFrames } from './video-frame.js';

const MAX_TEXT_CHARS = 1_000_000;
const MAX_PDF_PAGES = 2_000;

export interface DeviceWorkContribution {
  variant: 'poster' | 'thumb' | 'text' | 'transcript';
  body: Blob;
  mediaType: string;
}

let pdfRuntime: Promise<typeof import('pdfjs-dist/legacy/build/pdf.mjs')> | undefined;

function readBlobBytes(source: Blob): Promise<ArrayBuffer> {
  const native = source as Blob & { arrayBuffer?: () => Promise<ArrayBuffer> };
  if (typeof native.arrayBuffer === 'function') return native.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve(reader.result as ArrayBuffer), { once: true });
    reader.addEventListener('error', () => reject(reader.error ?? new Error('blob read failed')), {
      once: true,
    });
    // eslint-disable-next-line unicorn/prefer-blob-reading-methods -- older WebViews/jsdom lack Blob.arrayBuffer(); governance: allow-no-unjustified-suppressions runtime compatibility fallback (#414)
    reader.readAsArrayBuffer(source);
  });
}

async function loadPdfJs(): Promise<typeof import('pdfjs-dist/legacy/build/pdf.mjs')> {
  pdfRuntime ??= import('pdfjs-dist/legacy/build/pdf.mjs').then((pdfjs) => {
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
    pdfDocument = await loading.promise;
    const pages: string[] = [];
    let chars = 0;
    for (let pageNo = 1; pageNo <= Math.min(pdfDocument.numPages, MAX_PDF_PAGES); pageNo += 1) {
      const page = await pdfDocument.getPage(pageNo);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) => ('str' in item && typeof item.str === 'string' ? item.str : ''))
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (!text) continue;
      const remaining = MAX_TEXT_CHARS - chars;
      if (remaining <= 0) break;
      pages.push(text.slice(0, remaining));
      chars += Math.min(text.length, remaining) + 1;
    }
    return pages.join('\n').trim() || null;
  } catch {
    return null;
  } finally {
    try {
      await pdfDocument?.destroy();
    } catch {
      // A captured text layer remains valid when worker cleanup fails.
    }
  }
}

async function videoContributions(source: Blob): Promise<DeviceWorkContribution[]> {
  const captured = await captureVideoFrames(source);
  return captured
    ? [
        ...(captured.poster
          ? [{ variant: 'poster' as const, body: captured.poster, mediaType: 'image/jpeg' }]
          : []),
        ...(captured.thumb
          ? [{ variant: 'thumb' as const, body: captured.thumb, mediaType: 'image/jpeg' }]
          : []),
      ]
    : [];
}

async function transcriptContributions(source: Blob): Promise<DeviceWorkContribution[]> {
  const transcribe = window.CentraidApi.transcribeMedia;
  if (!transcribe || (!source.type.startsWith('audio/') && !source.type.startsWith('video/'))) {
    return [];
  }
  try {
    const text = (await transcribe({ bytes: await readBlobBytes(source), mediaType: source.type }))
      .trim()
      .slice(0, MAX_TEXT_CHARS);
    return text
      ? [
          {
            variant: 'transcript',
            body: new Blob([text], { type: 'text/plain' }),
            mediaType: 'text/plain',
          },
        ]
      : [];
  } catch {
    return [];
  }
}

/** Compute every contribution fulfilled by the browser capability in one lease. */
export async function computeDeviceWorkContributions(
  lease: DeviceEnrichmentLease,
  source: Blob,
): Promise<DeviceWorkContribution[]> {
  if (lease.capability === 'poster') return videoContributions(source);
  if (lease.capability === 'transcript') return transcriptContributions(source);
  if (lease.capability === 'pdfText') {
    const text = await extractPdfText(source);
    return text
      ? [
          {
            variant: 'text',
            body: new Blob([text], { type: 'text/plain' }),
            mediaType: 'text/plain',
          },
        ]
      : [];
  }
  return [];
}
