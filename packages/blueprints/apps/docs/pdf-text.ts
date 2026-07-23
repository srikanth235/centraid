// Browser-only PDF text extraction (issue #414). PDF.js is a normal client
// dependency: Vite emits its display chunk and worker asset with the inline
// Docs app instead of relying on same-origin files in the shared kit.

import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';

const MAX_TEXT_CHARS = 1_000_000;
const MAX_PDF_PAGES = 2_000;

// Minimal structural types for the PDF.js display build's surface this adapter
// touches — the vendored module ships no declarations, so these name only what
// is read here (getDocument, the loading task, page text content, teardown).
interface PdfPageTextItem {
  str?: unknown;
}
interface PdfPageTextContent {
  items?: PdfPageTextItem[];
}
interface PdfPage {
  getTextContent(): Promise<PdfPageTextContent>;
}
interface PdfDocument {
  numPages: number;
  getPage(pageNo: number): Promise<PdfPage>;
  destroy?: () => Promise<void> | void;
}
interface PdfLoadingTask {
  promise: Promise<PdfDocument>;
}
interface PdfJsModule {
  GlobalWorkerOptions: { workerSrc: string };
  getDocument(params: {
    data: Uint8Array;
    useSystemFonts?: boolean;
    isEvalSupported?: boolean;
  }): PdfLoadingTask;
  version?: string;
}
interface PdfFileLike {
  arrayBuffer(): Promise<ArrayBuffer>;
}

let runtimeLoad: Promise<PdfJsModule> | undefined;

function resolveWorkerUrl(url: string): string {
  const processLike = Reflect.get(globalThis, 'process') as
    | { versions?: { node?: unknown } }
    | undefined;
  if (processLike?.versions?.node && url.startsWith('/@fs/')) {
    return new URL(`file://${url.slice(4)}`).href;
  }
  return url;
}

function ensurePdfJsCompatibility(): void {
  const promise = Promise as PromiseConstructor & {
    try?: <T>(fn: (...args: unknown[]) => T, ...args: unknown[]) => Promise<Awaited<T>>;
  };
  if (!promise.try) {
    Object.defineProperty(promise, 'try', {
      configurable: true,
      writable: true,
      value<T>(
        this: PromiseConstructor,
        fn: (...args: unknown[]) => T,
        ...args: unknown[]
      ): Promise<Awaited<T>> {
        return new this((resolve) => resolve(fn(...args) as Awaited<T> | PromiseLike<Awaited<T>>));
      },
    });
  }
}

/** Load the client-bundled PDF.js display build exactly once. */
export function loadPdfJs(): Promise<PdfJsModule> {
  ensurePdfJsCompatibility();

  if (!runtimeLoad) {
    runtimeLoad = import('pdfjs-dist/legacy/build/pdf.mjs').then((module) => {
      const pdfjs = module as unknown as PdfJsModule;
      pdfjs.GlobalWorkerOptions.workerSrc = resolveWorkerUrl(pdfWorkerUrl);
      return pdfjs;
    });
  }
  return runtimeLoad;
}

export async function extractPdfTextWithPdfJs(
  file: PdfFileLike,
  pdfjs?: PdfJsModule,
): Promise<string | null> {
  try {
    pdfjs ??= await loadPdfJs();
  } catch {
    return null;
  }
  if (!pdfjs?.getDocument || typeof file?.arrayBuffer !== 'function') return null;
  let doc: PdfDocument | undefined;
  try {
    const loading = pdfjs.getDocument({
      data: new Uint8Array(await file.arrayBuffer()),
      // Text-layer extraction never renders glyphs. Prefer installed system
      // metrics and disable generated-code font paths; no external font/CMap
      // fetch is needed for ordinary PDFs and the app remains fully offline.
      useSystemFonts: true,
      isEvalSupported: false,
    });
    doc = await loading.promise;
    const pages: string[] = [];
    let chars = 0;
    for (let pageNo = 1; pageNo <= Math.min(doc.numPages, MAX_PDF_PAGES); pageNo += 1) {
      const page = await doc.getPage(pageNo);
      const content = await page.getTextContent();
      const text = (content.items ?? [])
        .map((item) => (typeof item?.str === 'string' ? item.str : ''))
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
    const joined = pages.join('\n').trim();
    return joined || null;
  } catch {
    return null;
  } finally {
    try {
      await doc?.destroy?.();
    } catch {
      // PDF text is already captured; worker cleanup is best-effort.
    }
  }
}
