import { DAY_MS, MONTHS, decodeDataUri } from "../_shared/format-kit.ts";

// Pure projections over a note — no app state, no vault IO, no JSX. THE
// UNTITLED NOTE IS THE DEFAULT CASE (Notes spec §1): `promote` is the single
// answer, and no surface may derive its own.

export type Block =
  | { kind: "check"; checked: boolean; text: string; line: number }
  | { kind: "h"; level: number; text: string; line: number }
  | { kind: "li"; text: string; line: number }
  | { kind: "gap"; line: number }
  | { kind: "p"; text: string; line: number };

const CHECK_RE = /^\s*[-*] \[(?<mark> |x|X)\]\s?(?<text>.*)$/u;

export function parseBlocks(body: unknown): Block[] {
  const out: Block[] = [];
  String(body ?? "")
    .split("\n")
    .forEach((line, index) => {
      const check = CHECK_RE.exec(line);
      if (check) {
        out.push({
          kind: "check",
          checked: /x/iu.test(check.groups?.mark ?? ""),
          text: check.groups?.text ?? "",
          line: index,
        });
        return;
      }
      const heading = /^(?<hashes>#{1,3})\s+(?<text>.*)$/u.exec(line);
      if (heading) {
        out.push({
          kind: "h",
          level: (heading.groups?.hashes ?? "").length,
          text: heading.groups?.text ?? "",
          line: index,
        });
        return;
      }
      const item = /^\s*(?:[-*]|\d+\.)\s+(?<text>.*)$/u.exec(line);
      if (item) {
        out.push({ kind: "li", text: item.groups?.text ?? "", line: index });
        return;
      }
      if (line.trim() === "") {
        out.push({ kind: "gap", line: index });
        return;
      }
      out.push({ kind: "p", text: line, line: index });
    });
  return out;
}

/** Emphasis is STRIPPED, never styled: a note renders only text nodes. */
export function stripInline(text: unknown): string {
  return String(text ?? "")
    .replace(/\*\*(?<bold>.+?)\*\*/gu, "$<bold>")
    .replace(/\*(?<italic>.+?)\*/gu, "$<italic>")
    .replace(/`(?<code>.+?)`/gu, "$<code>")
    .replace(/\[\[(?<label>[^\]]+)\]\]/gu, "$<label>");
}

export function checkStats(body: unknown): { total: number; done: number } {
  const boxes = parseBlocks(body).filter((block) => block.kind === "check");
  return {
    total: boxes.length,
    done: boxes.filter((block) => block.checked).length,
  };
}

export function tallyLabel(check?: {
  total: number;
  done: number;
}): string | null {
  if (!check || check.total === 0) return null;
  return `${check.done} of ${check.total}`;
}

export interface Promoted {
  heading: string;
  untitled: boolean;
  preview: string;
}

export const UNTITLED_NOTE = "Untitled note";

/** UNTITLED covers a missing title, the sentinel, AND a title equal to the
 *  first line — the shape `create_note` leaves behind. */
export function promote(note: {
  title?: unknown;
  preview?: unknown;
  body?: unknown;
}): Promoted {
  const source = String(
    (typeof note.preview === "string" && note.preview) || note.body || ""
  );
  const lines = source.split("\n");
  const firstIndex = lines.findIndex((line) => line.trim() !== "");
  const firstLine =
    firstIndex === -1 ? "" : stripInline(lines[firstIndex]).trim();
  const typed = stripInline(note.title).trim();
  const untitled =
    typed === "" || typed === firstLine || typed === UNTITLED_NOTE;
  const rest = firstIndex === -1 ? [] : lines.slice(firstIndex + 1);
  return {
    heading: untitled ? firstLine || typed : typed,
    untitled,
    preview: (untitled ? rest : lines)
      .join("\n")
      .replace(/^\n+/u, "")
      .trimEnd(),
  };
}

/** The ruled decoder (#883 B4), but empty where a list says "(external
 *  content)": a writing surface opens empty, never on a parenthetical. */
export function decodeTextContent(uri: unknown): string {
  return decodeDataUri(typeof uri === "string" ? uri : null) ?? "";
}

export type Segment =
  | { kind: "text"; from: number; to: number; text: string }
  | { kind: "check"; line: number; checked: boolean; text: string };

/** A CHECKLIST LINE IS A CONTROL, never a second rendered copy. `from`/`to`
 *  are character offsets into the body. */
export function bodySegments(body: string): Segment[] {
  const lines = body.split("\n");
  const out: Segment[] = [];
  let offset = 0;
  let runStart = 0;
  let run: string[] = [];
  const flush = (end: number): void => {
    if (run.length === 0) return;
    out.push({ kind: "text", from: runStart, to: end, text: run.join("\n") });
    run = [];
  };
  lines.forEach((line, index) => {
    const match = CHECK_RE.exec(line);
    if (match) {
      flush(Math.max(0, offset - 1));
      out.push({
        kind: "check",
        line: index,
        checked: /x/iu.test(match.groups?.mark ?? ""),
        text: match.groups?.text ?? "",
      });
      runStart = offset + line.length + 1;
    } else {
      if (run.length === 0) runStart = offset;
      run.push(line);
    }
    offset += line.length + 1;
  });
  flush(Math.max(0, offset - 1));
  return out;
}

export function deriveTitle(title: unknown, body: unknown): string {
  const typed = String(title ?? "").trim();
  if (typed) return typed;
  const firstLine = String(body ?? "")
    .split("\n")
    .find((line) => line.trim());
  return firstLine ? firstLine.trim().slice(0, 80) : "";
}

/** A FACT, NOT A REPRIMAND: an old note says only when it last changed. */
export function ageLabel(when: unknown, now: number = Date.now()): string {
  const stamp = Date.parse(String(when ?? ""));
  if (Number.isNaN(stamp)) return "";
  const days = Math.floor((now - stamp) / DAY_MS);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  const date = new Date(stamp);
  const month = `${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
  if (days < 365) return month;
  return `not changed since ${month}`;
}

/** Null where no purge date — never count down from an invented one. */
export function daysLeft(
  purgeAt: unknown,
  now: number = Date.now()
): number | null {
  const stamp = Date.parse(String(purgeAt ?? ""));
  if (Number.isNaN(stamp)) return null;
  return Math.max(0, Math.ceil((stamp - now) / DAY_MS));
}

/** The ONE observable form of "two devices changed this passage": identical
 *  `asserted_at` stamps. The conflict panel reads this, never a guess. */
export function hasConcurrentVersions(
  versions: ReadonlyArray<{ asserted_at: string }>
): boolean {
  const seen = new Set<string>();
  for (const version of versions) {
    if (seen.has(version.asserted_at)) return true;
    seen.add(version.asserted_at);
  }
  return false;
}

export type Placeholder = "screenshot" | "link-only" | "audio" | null;

export function placeholderOf(note: {
  preview?: unknown;
  body?: unknown;
  attachments?: ReadonlyArray<{ media_type?: string }> | undefined;
}): Placeholder {
  const media = (note.attachments ?? []).map((item) => item.media_type ?? "");
  if (media.some((type) => type.startsWith("audio/"))) return "audio";
  const text = String(note.preview ?? note.body ?? "").trim();
  if (media.some((type) => type.startsWith("image/")) && text === "")
    return "screenshot";
  if (text !== "" && /^https?:\/\/\S+$/u.test(text)) return "link-only";
  return null;
}

export function placeholderLabel(kind: Exclude<Placeholder, null>): string {
  if (kind === "audio") return "audio note";
  if (kind === "screenshot") return "screenshot";
  return "link only";
}
