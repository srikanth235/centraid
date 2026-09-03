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

function looksBinary(text: string): boolean {
  if (text.length === 0) return false;
  if (text.includes("\u0000")) return true;
  let replacementCount = 0;
  for (const ch of text) {
    if (ch === "�") replacementCount++;
  }
  return replacementCount / text.length > 0.01;
}

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
    if (looksBinary(text)) return undefined; // mislabeled/binary — skip like other unreadable blobs
    const body = truncated
      ? `${text}\n[truncated — showing first ${TEXT_ATTACHMENT_MAX_BYTES} of ${buf.length} bytes]`
      : text;
    return {
      type: "text",
      text: `Attachment ${label} (${att.mime}):\n\`\`\`\n${body}\n\`\`\``,
    };
  }

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
  blocks: ContentBlock[];
  skipped: string[];
}

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
