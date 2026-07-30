// Markdown directory adapter (issue #630): one file becomes one staged note.
// The tiny front matter vocabulary is intentionally not general YAML; export
// emits JSON string values and import accepts only those known scalar keys.

import { sha256Hex } from "../ids.js";

export interface MarkdownNote {
  externalId: string;
  title: string;
  body: string;
  path: string;
}

function safeRelativePath(input: string): string {
  const normalized = input.replaceAll("\\", "/").replace(/^\/+/u, "");
  if (
    normalized.length === 0 ||
    normalized.includes("\0") ||
    normalized.split("/").includes("..")
  ) {
    throw new Error(`unsafe Markdown path: ${input}`);
  }
  return normalized;
}

function titleFromPath(path: string): string {
  const name = path.split("/").at(-1) ?? "Untitled";
  return (
    name.replace(/\.md$/iu, "").replaceAll(/[-_]+/gu, " ").trim() || "Untitled"
  );
}

function decodeScalar(raw: string): string {
  const value = raw.trim();
  if (value.startsWith('"')) {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "string")
      throw new Error("front matter value is not text");
    return parsed;
  }
  return value;
}

export function parseMarkdownNote(input: {
  path: string;
  text: string;
}): MarkdownNote {
  const path = safeRelativePath(input.path);
  let body = input.text.startsWith("\uFEFF") ? input.text.slice(1) : input.text;
  const meta: Record<string, string> = {};
  if (body.startsWith("---\n")) {
    const end = body.indexOf("\n---\n", 4);
    if (end < 0) throw new Error(`unterminated Markdown front matter: ${path}`);
    for (const line of body.slice(4, end).split("\n")) {
      const colon = line.indexOf(":");
      if (colon <= 0) continue;
      const key = line.slice(0, colon).trim().toLowerCase();
      if (["centraid-id", "title"].includes(key))
        meta[key] = decodeScalar(line.slice(colon + 1));
    }
    body = body.slice(end + 5);
  }
  const heading = /^#\s+(?<heading>.+)$/mu.exec(body)?.groups?.heading?.trim();
  const title = meta["title"]?.trim() || heading || titleFromPath(path);
  const externalId =
    meta["centraid-id"]?.trim() || `markdown:${sha256Hex(path).slice(0, 32)}`;
  return { externalId, title, body, path };
}

export function serializeMarkdownNote(input: {
  noteId: string;
  title: string;
  body: string;
}): string {
  return [
    "---",
    `centraid-id: ${JSON.stringify(input.noteId)}`,
    `title: ${JSON.stringify(input.title)}`,
    "---",
    input.body,
  ].join("\n");
}
