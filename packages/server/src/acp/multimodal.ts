/*
 * Multimodal content-block construction for harness turns (issue #190).
 *
 * A conversation turn can carry attachments (images, PDFs, text/code files)
 * that landed in the per-app blob CAS before the turn. The route resolves
 * each to an on-disk `path`; here we read the bytes and shape them into ACP
 * `ContentBlock`s for `session/prompt` (issue #479).
 *
 * There is one target shape now, not two: the retired Anthropic-block and
 * codex-`localImage` mappings died with their bespoke backends. Field names
 * below are the ACP schema's, verified against
 * `@agentclientprotocol/sdk`'s generated types — `ImageContent { data,
 * mimeType }` (NOT Anthropic's nested `source.media_type`) and
 * `EmbeddedResource { resource: { uri, mimeType, blob } }`.
 *
 * What we may send is gated on what the harness advertised in `initialize`:
 * text is baseline and always allowed, images need
 * `promptCapabilities.image`, audio needs `.audio`, and any other binary
 * (PDFs, archives) rides an embedded resource, which needs
 * `.embeddedContext`. Both first-party adapters advertise
 * `{ image: true, embeddedContext: true }`, so images AND PDFs reach codex
 * and claude-code again.
 *
 * Anything the harness genuinely can't accept is reported by name in
 * `skipped` so the turn can say what it dropped instead of silently losing
 * it. Textual attachments (source, config, notes) are inlined as a
 * delimited text block so the model actually sees their contents. The
 * shaping (`acpBlockFor`) is pure given pre-read base64, so it is
 * unit-testable without touching disk.
 */

import { readFileSync } from "node:fs";

import type {
  ContentBlock,
  PromptCapabilities,
} from "@agentclientprotocol/sdk";

import type { TurnAttachment } from "@centraid/server/engine";

export type {
  ContentBlock,
  PromptCapabilities,
} from "@agentclientprotocol/sdk";

const IMAGE_MIME = /^image\/(?:png|jpe?g|gif|webp)$/iu;
const AUDIO_MIME = /^audio\//iu;
const TEXT_MIME = /^text\//iu;
const TEXT_MIME_EXACT = new Set([
  "application/json",
  "application/xml",
  "application/javascript",
  "application/x-yaml",
  "application/yaml",
]);
const GENERIC_MIME = new Set(["application/octet-stream", ""]);
const TEXT_EXTENSIONS = new Set([
  "md",
  "txt",
  "csv",
  "tsv",
  "json",
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "py",
  "yaml",
  "yml",
  "toml",
  "log",
  "sh",
  "bash",
  "zsh",
  "rb",
  "go",
  "rs",
  "java",
  "kt",
  "c",
  "cc",
  "cpp",
  "h",
  "hpp",
  "css",
  "scss",
  "html",
  "htm",
  "xml",
  "ini",
  "conf",
  "sql",
  "env",
  "gitignore",
  "dockerfile",
  "graphql",
]);

/** ~256KB of decoded text per attachment; beyond this we truncate with a marker. */
export const TEXT_ATTACHMENT_MAX_BYTES = 256 * 1024;

function extensionOf(filename: string | undefined): string {
  if (!filename || !filename.includes(".")) return "";
  return filename.slice(filename.lastIndexOf(".") + 1).toLowerCase();
}

function isTextualAttachment(
  mime: string,
  filename: string | undefined
): boolean {
  if (TEXT_MIME.test(mime) || TEXT_MIME_EXACT.has(mime)) return true;
  if (GENERIC_MIME.has(mime)) return TEXT_EXTENSIONS.has(extensionOf(filename));
  return false;
}

/** Crude binary heuristic: heavy replacement-char ratio or embedded NULs. */
function looksBinary(text: string): boolean {
  if (text.length === 0) return false;
  if (text.includes("\u0000")) return true;
  let replacementCount = 0;
  for (const ch of text) {
    if (ch === "�") replacementCount++;
  }
  return replacementCount / text.length > 0.01;
}

/**
 * Shape one attachment (pre-read as base64) into an ACP content block, or
 * `undefined` when the harness can't accept it (caller reports it as skipped).
 *
 * Text is baseline ACP and never gated. Everything else is gated on what the
 * harness advertised, because sending an un-advertised block type is a protocol
 * violation, not a graceful degradation.
 */
export function acpBlockFor(
  att: { mime: string; dataBase64: string; filename?: string; path?: string },
  caps: PromptCapabilities
): ContentBlock | undefined {
  const mime = att.mime.toLowerCase();
  if (IMAGE_MIME.test(mime)) {
    return caps.image
      ? { type: "image", data: att.dataBase64, mimeType: mime }
      : undefined;
  }
  if (AUDIO_MIME.test(mime)) {
    return caps.audio
      ? { type: "audio", data: att.dataBase64, mimeType: mime }
      : undefined;
  }

  const buf = Buffer.from(att.dataBase64, "base64");
  const label = att.filename === undefined ? "attachment" : `"${att.filename}"`;
  if (isTextualAttachment(mime, att.filename)) {
    const truncated = buf.length > TEXT_ATTACHMENT_MAX_BYTES;
    const text = (
      truncated ? buf.subarray(0, TEXT_ATTACHMENT_MAX_BYTES) : buf
    ).toString("utf8");
    if (looksBinary(text)) return undefined; // mislabeled/binary content — skip like other unreadable blobs
    const body = truncated
      ? `${text}\n[truncated — showing first ${TEXT_ATTACHMENT_MAX_BYTES} of ${buf.length} bytes]`
      : text;
    return {
      type: "text",
      text: `Attachment ${label} (${att.mime}):\n\`\`\`\n${body}\n\`\`\``,
    };
  }

  // PDFs, archives, anything else binary: an embedded resource is the only
  // ACP block that can carry arbitrary bytes, and it needs `embeddedContext`.
  if (!caps.embeddedContext) return undefined;
  return {
    type: "resource",
    resource: {
      uri: att.path
        ? `file://${att.path}`
        : `attachment:${att.filename ?? "file"}`,
      mimeType: att.mime,
      blob: att.dataBase64,
    },
  };
}

export interface AcpAttachmentBlocks {
  /** Blocks to append after the message text, in attachment order. */
  blocks: ContentBlock[];
  /** Display names of attachments the harness can't accept (or we can't read). */
  skipped: string[];
}

/**
 * Read the attachments off disk and map them to ACP prompt content blocks.
 *
 * Never throws: an unreadable blob is reported as skipped rather than failing
 * the turn, which is the same "degrade loudly, not silently" contract the
 * capability gate uses.
 */
export function acpAttachmentBlocks(
  attachments: readonly TurnAttachment[],
  caps: PromptCapabilities
): AcpAttachmentBlocks {
  const blocks: ContentBlock[] = [];
  const skipped: string[] = [];
  for (const a of attachments) {
    const name = a.filename ?? a.mime;
    let dataBase64: string;
    try {
      dataBase64 = readFileSync(a.path).toString("base64");
    } catch {
      skipped.push(name);
      continue;
    }
    const block = acpBlockFor(
      {
        mime: a.mime,
        dataBase64,
        path: a.path,
        ...(a.filename === undefined ? {} : { filename: a.filename }),
      },
      caps
    );
    if (block) blocks.push(block);
    else skipped.push(name);
  }
  return { blocks, skipped };
}
