import type { PageCapture } from './types.js';

export function anchoredCaptureText(capture: PageCapture): string {
  const quote = capture.selection?.trim()
    ? `\n\n> ${capture.selection.trim().replaceAll('\n', '\n> ')}`
    : '';
  return `[${capture.title || capture.url}](${capture.url})${quote}`;
}

/** Keep the verbatim source URL in screenshot provenance, including its path. */
export function documentCaptureTitle(capture: PageCapture): string {
  return `${capture.title || 'Web capture'} — ${capture.url}`;
}
