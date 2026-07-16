// eslint-disable-next-line typescript-eslint/triple-slash-reference -- consumer tsconfigs follow this source without including sibling declarations; governance: allow-no-unjustified-suppressions Vite asset type boundary (#414)
/// <reference path="./vite-assets.d.ts" />

// Browser compute adapters for the idle-device queue (issue #414 D11/D13).
// The shell owns scheduling/eligibility; this file owns bounded PDF.js text
// extraction and hardware-decoded video poster generation.

// eslint-disable-next-line import/default -- Vite's ?url loader synthesizes the default URL export; governance: allow-no-unjustified-suppressions upstream module has no source-level default (#414)
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { DeviceEnrichmentLease } from './gateway-client-devices.js';

const MAX_TEXT_CHARS = 1_000_000;
const MAX_PDF_PAGES = 2_000;
const POSTER_EDGE = 2_048;
const THUMB_EDGE = 256;
const MEDIA_TIMEOUT_MS = 20_000;

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
    const loading = pdfjs.getDocument({
      data: new Uint8Array(await readBlobBytes(source)),
      useSystemFonts: true,
    });
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

function waitForMedia(media: HTMLMediaElement, event: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(
      () => finish(new Error(`media ${event} timed out`)),
      MEDIA_TIMEOUT_MS,
    );
    const finish = (error?: Error): void => {
      window.clearTimeout(timer);
      media.removeEventListener(event, onReady);
      media.removeEventListener('error', onError);
      if (error) reject(error);
      else resolve();
    };
    const onReady = (): void => finish();
    const onError = (): void => finish(new Error('media decode failed'));
    media.addEventListener(event, onReady, { once: true });
    media.addEventListener('error', onError, { once: true });
  });
}

function scaledCanvas(video: HTMLVideoElement, maxEdge: number): HTMLCanvasElement {
  const scale = Math.min(1, maxEdge / Math.max(video.videoWidth, video.videoHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
  canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('canvas unavailable');
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function jpeg(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.84));
}

async function videoContributions(source: Blob): Promise<DeviceWorkContribution[]> {
  if (!URL.createObjectURL) return [];
  const video = document.createElement('video');
  const url = URL.createObjectURL(source);
  video.muted = true;
  video.playsInline = true;
  video.preload = 'metadata';
  try {
    video.src = url;
    video.load();
    await waitForMedia(video, 'loadedmetadata');
    if (!(video.videoWidth > 0 && video.videoHeight > 0)) return [];
    const seekTo =
      Number.isFinite(video.duration) && video.duration > 0 ? Math.min(1, video.duration / 2) : 0;
    if (seekTo > 0.01) {
      video.currentTime = seekTo;
      await waitForMedia(video, 'seeked');
    } else if (video.readyState < 2) {
      await waitForMedia(video, 'loadeddata');
    }
    const [poster, thumb] = await Promise.all([
      jpeg(scaledCanvas(video, POSTER_EDGE)),
      jpeg(scaledCanvas(video, THUMB_EDGE)),
    ]);
    return [
      ...(poster ? [{ variant: 'poster' as const, body: poster, mediaType: 'image/jpeg' }] : []),
      ...(thumb ? [{ variant: 'thumb' as const, body: thumb, mediaType: 'image/jpeg' }] : []),
    ];
  } catch {
    return [];
  } finally {
    video.pause();
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
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
