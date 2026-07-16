// Browser-only PDF text extraction (issue #414). Kept independent of the
// shared kit so it is testable as a pure adapter around PDF.js and remains
// useful if document upload moves into a worker later.

const MAX_TEXT_CHARS = 1_000_000;
const MAX_PDF_PAGES = 2_000;
const runtimeLoads = new Map();

function defaultAssetUrl(name) {
  // Whole-app bundling moves this module into /_bundle/<hash>.js, so
  // import.meta.url is not the app root. document.baseURI remains the
  // installed app's index URL in both bundled and per-file modes.
  return new URL(name, document.baseURI).href;
}

/** Load the generated, same-origin PDF.js display build exactly once. */
export function loadPdfJs(runtimeUrl = defaultAssetUrl('pdf.min.mjs')) {
  let load = runtimeLoads.get(runtimeUrl);
  if (!load) {
    load = import(/* @vite-ignore */ runtimeUrl).then((pdfjs) => {
      const workerUrl = new URL('pdf.worker.min.mjs', runtimeUrl).href;
      pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
      return pdfjs;
    });
    runtimeLoads.set(runtimeUrl, load);
  }
  return load;
}

export async function extractPdfTextWithPdfJs(file, pdfjs) {
  try {
    pdfjs ??= await loadPdfJs();
  } catch {
    return null;
  }
  if (!pdfjs?.getDocument || typeof file?.arrayBuffer !== 'function') return null;
  let document;
  try {
    const loading = pdfjs.getDocument({
      data: new Uint8Array(await file.arrayBuffer()),
      // Text-layer extraction never renders glyphs. Prefer installed system
      // metrics and disable generated-code font paths; no external font/CMap
      // fetch is needed for ordinary PDFs and the app remains fully offline.
      useSystemFonts: true,
      isEvalSupported: false,
    });
    document = await loading.promise;
    const pages = [];
    let chars = 0;
    for (let pageNo = 1; pageNo <= Math.min(document.numPages, MAX_PDF_PAGES); pageNo += 1) {
      const page = await document.getPage(pageNo);
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
      await document?.destroy?.();
    } catch {
      // PDF text is already captured; worker cleanup is best-effort.
    }
  }
}
