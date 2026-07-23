// Docs upload-side processing (issue #414 D9/D10): client SHA preflight and
// a real PDF.js text-layer contribution before the document claim. The
// lockfile-pinned display+worker builds are emitted by the main client bundle
// and cached offline; a load or parse failure still degrades to the gateway's
// cheap extractor, never a failed upload.

import { stageDerivative, stageFileBytes, type StagedBlob } from './kit.ts';
import { extractPdfTextWithPdfJs } from './pdf-text.ts';

export { extractPdfTextWithPdfJs } from './pdf-text.ts';

export async function stageDocumentFile(file: File): Promise<StagedBlob> {
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
