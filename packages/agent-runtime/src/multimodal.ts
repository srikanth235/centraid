/*
 * Multimodal content-block construction for the chat adapters (issue #190).
 *
 * A chat turn can carry attachments (images, PDFs) that landed in the per-app
 * blob CAS before the turn. The route resolves each to an on-disk `path`; here
 * we read the bytes and shape them into the content blocks each backend wants:
 *
 *   - Claude SDK — Anthropic content blocks: `{type:'image', source:{type:
 *     'base64', media_type, data}}` and `{type:'document', ...}` for PDFs.
 *   - codex app-server — `{type:'localImage', path}` input items (codex reads
 *     the file itself; PDFs aren't a supported input there and are dropped).
 *
 * The text always leads; unsupported MIME types are silently dropped so the
 * turn degrades to text-only rather than failing. The shaping (`blockFor`) is
 * pure given pre-read base64 so it is unit-testable without touching disk.
 */

import { readFileSync } from 'node:fs';
import type { TurnAttachment } from '@centraid/app-engine';

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | {
      type: 'document';
      source: { type: 'base64'; media_type: string; data: string };
      title?: string;
    };

const IMAGE_MIME = /^image\/(png|jpe?g|gif|webp)$/i;

/** Shape one attachment (pre-read as base64) into an Anthropic content block. */
export function blockFor(att: {
  mime: string;
  dataBase64: string;
  filename?: string;
}): ContentBlock | undefined {
  const mime = att.mime.toLowerCase();
  if (IMAGE_MIME.test(mime)) {
    return { type: 'image', source: { type: 'base64', media_type: mime, data: att.dataBase64 } };
  }
  if (mime === 'application/pdf') {
    return {
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: att.dataBase64 },
      ...(att.filename !== undefined ? { title: att.filename } : {}),
    };
  }
  return undefined;
}

/** Build the Anthropic user-message content array: text first, then attachments. */
export function buildUserContent(
  text: string,
  attachments: readonly TurnAttachment[],
): ContentBlock[] {
  const blocks: ContentBlock[] = [{ type: 'text', text }];
  for (const a of attachments) {
    let dataBase64: string;
    try {
      dataBase64 = readFileSync(a.path).toString('base64');
    } catch {
      continue; // a missing blob degrades the turn to text-only, never throws
    }
    const block = blockFor({
      mime: a.mime,
      dataBase64,
      ...(a.filename !== undefined ? { filename: a.filename } : {}),
    });
    if (block) blocks.push(block);
  }
  return blocks;
}

/** codex app-server input items for the attachments — local images only. */
export function codexImageItems(
  attachments: readonly TurnAttachment[],
): { type: 'localImage'; path: string }[] {
  return attachments
    .filter((a) => IMAGE_MIME.test(a.mime))
    .map((a) => ({ type: 'localImage', path: a.path }));
}
