// Docs upload-side processing (issue #414 D9/D10): client SHA preflight and
// a real PDF.js text-layer contribution before the document claim. The
// lockfile-pinned display+worker builds are generated into the shared kit and
// served same-origin/offline; a load or parse failure still degrades to the
// gateway's cheap extractor, never a failed upload.

import { stageDerivative, stageFileBytes } from './kit.js';
import { extractPdfTextWithPdfJs } from './pdf-text.js';

export { extractPdfTextWithPdfJs } from './pdf-text.js';

export async function stageDocumentFile(file) {
  const staged = await stageFileBytes(file, '', { hash: true });
  const mediaType = String(file.type || staged.mediaType || '').toLowerCase();
  if (
    mediaType === 'application/pdf' ||
    String(file.name ?? '')
      .toLowerCase()
      .endsWith('.pdf')
  ) {
    const text = await extractPdfTextWithPdfJs(file);
    if (text) {
      try {
        await stageDerivative(
          staged.sha256,
          'text',
          new Blob([text], { type: 'text/plain' }),
          'text/plain',
        );
      } catch {
        // The gateway backstop still owns eventual extraction.
      }
    }
  }
  return staged;
}
