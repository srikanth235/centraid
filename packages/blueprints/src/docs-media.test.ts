// @vitest-environment jsdom
// eslint-disable-next-line typescript-eslint/ban-ts-comment -- browser fixture intentionally uses DOM-shaped PDF.js objects; governance: allow-no-unjustified-suppressions JS fixture boundary (#414)
// @ts-nocheck -- imported blueprint app code has no declarations; governance: allow-no-unjustified-suppressions JS fixture boundary (#414)
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, test, vi } from 'vitest';

const docsPdfModuleUrl = pathToFileURL(
  path.resolve(import.meta.dirname, '../apps/docs/pdf-text.js'),
).href;
const { extractPdfTextWithPdfJs, loadPdfJs } = await import(docsPdfModuleUrl);

function realPdf(text) {
  const stream = `BT /F1 18 Tf 72 120 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let body = '%PDF-1.4\n';
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('');
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body);
}

function arrayBufferOf(bytes) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

describe('Docs device-side PDF text', () => {
  test('extracts normalized page text and tears down the PDF.js document', async () => {
    const destroy = vi.fn();
    const getPage = vi.fn(async (pageNo) => ({
      getTextContent: async () => ({
        items:
          pageNo === 1
            ? [{ str: 'First' }, { str: '  page\ntext' }]
            : [{ str: 'Second page' }, { ignored: true }],
      }),
    }));
    const getDocument = vi.fn(() => ({
      promise: Promise.resolve({ numPages: 2, getPage, destroy }),
    }));
    const file = { arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };

    await expect(extractPdfTextWithPdfJs(file, { getDocument })).resolves.toBe(
      'First page text\nSecond page',
    );
    expect(getDocument).toHaveBeenCalledWith({
      data: new Uint8Array([1, 2, 3]),
      useSystemFonts: true,
      isEvalSupported: false,
    });
    expect(getPage).toHaveBeenCalledTimes(2);
    expect(destroy).toHaveBeenCalledOnce();
  });

  test('degrades to the gateway extractor when PDF.js is absent or malformed', async () => {
    const file = { arrayBuffer: async () => new ArrayBuffer(0) };
    await expect(extractPdfTextWithPdfJs(file, undefined)).resolves.toBeNull();
    await expect(
      extractPdfTextWithPdfJs(file, {
        getDocument: () => ({ promise: Promise.reject(new Error('bad pdf')) }),
      }),
    ).resolves.toBeNull();
  });

  test('loads the generated production runtime and extracts a real PDF offline', async () => {
    // PDF.js' browser display module creates one identity DOMMatrix at import
    // time. jsdom lacks that browser API; extraction never renders, so this
    // narrow identity stand-in is sufficient for the production module path.
    if (!globalThis.DOMMatrix) {
      vi.stubGlobal(
        'DOMMatrix',
        class {
          a = 1;
          b = 0;
          c = 0;
          d = 1;
          e = 0;
          f = 0;
        },
      );
    }
    const runtimeUrl = pathToFileURL(path.resolve(import.meta.dirname, '../kit/pdf.min.mjs')).href;
    const pdfjs = await loadPdfJs(runtimeUrl);
    expect(pdfjs.version).toBe('5.7.284');
    expect(pdfjs.GlobalWorkerOptions.workerSrc).toBe(
      new URL('pdf.worker.min.mjs', runtimeUrl).href,
    );

    const bytes = realPdf('Offline PDF.js narwhal');
    await expect(
      extractPdfTextWithPdfJs({ arrayBuffer: async () => arrayBufferOf(bytes) }, pdfjs),
    ).resolves.toBe('Offline PDF.js narwhal');
  });
});
