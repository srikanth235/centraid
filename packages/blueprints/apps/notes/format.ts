// Pure projections over a note. No app state, no vault IO, no JSX — every
// function here is a plain function of its arguments, so the card, the row,
// the search result, the chip and the tests can all call the same one.
//
// THE UNTITLED NOTE IS THE DEFAULT CASE (Notes spec §1's second ruling).
// Over half the corpus has no title of its own, so `promote` is the single
// answer every surface reads: the first line stands in the title slot at the
// reading rung and the preview picks up from the second. There is no separate
// shape for the titled case, and no surface may derive its own.

/** One parsed markdown-lite block. The body grammar is unchanged from the
 *  app's own `commonmark.ts` neighbourhood: `#`/`##`/`###` headings,
 *  `- `/`* `/`1. ` lists, `- [ ]`/`- [x]` checklists, everything else prose. */
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

/** Inline emphasis is STRIPPED rather than styled, so a body never becomes
 *  parsed markup: everything a note renders is a text node. */
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

/** The card's checklist tally — `14 of 22` — or null where a note has no
 *  boxes at all. Numerals are tabular wherever this lands. */
export function tallyLabel(check?: { total: number; done: number }): string | null {
  if (!check || check.total === 0) return null;
  return `${check.done} of ${check.total}`;
}

export interface Promoted {
  /** What stands in the title slot, at the reading rung. */
  heading: string;
  /** True where the heading came from the body rather than from a typed
   *  title — the card draws it in `--body` rather than `--label-on`. */
  untitled: boolean;
  /** The preview, picked up AFTER the promoted line. */
  preview: string;
}

/**
 * First-line promotion, the one implementation.
 *
 * A note is UNTITLED when it carries no title of its own, and also when its
 * title IS its first line — which is what a note created from a body alone
 * ends up with, since the vault's `create_note` will not accept an empty
 * name. Both cases read the same on screen and neither repeats the line
 * twice, because the preview starts below whatever the heading took.
 */
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
  const firstLine = firstIndex === -1 ? "" : stripInline(lines[firstIndex]).trim();
  const typed = stripInline(note.title).trim();
  const untitled = typed === "" || typed === firstLine;
  const rest = firstIndex === -1 ? [] : lines.slice(firstIndex + 1);
  return {
    heading: untitled ? firstLine : typed,
    untitled,
    preview: (untitled ? rest : lines).join("\n").replace(/^\n+/u, "").trimEnd(),
  };
}

/** One run of the body as the editor draws it: prose the member types into,
 *  or one checklist line with a real box. */
export type Segment =
  | { kind: "text"; from: number; to: number; text: string }
  | { kind: "check"; line: number; checked: boolean; text: string };

/**
 * Split a body into the runs the editor draws.
 *
 * A CHECKLIST LINE IS A CONTROL, and the rest of the body is prose. Rather
 * than a second rendered copy of the note beside the writing surface — two
 * places showing the same sentence, one of them lying whenever the other is
 * mid-keystroke — the editor draws the box lines as rows and everything
 * between them as the text the member writes into. `from`/`to` are the run's
 * character offsets in the body, so an edit and an anchor both address the
 * same string.
 */
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

/** Quick create derives a name from the first line, so a note never reaches
 *  the vault nameless and never shows that derivation to the member. */
export function deriveTitle(title: unknown, body: unknown): string {
  const typed = String(title ?? "").trim();
  if (typed) return typed;
  const firstLine = String(body ?? "")
    .split("\n")
    .find((line) => line.trim());
  return firstLine ? firstLine.trim().slice(0, 80) : "";
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const DAY_MS = 86_400_000;

/**
 * The age signal every surface prints beside a note. A FACT, NOT A
 * REPRIMAND: an old note says when it last changed and nothing more, which
 * is the whole of the year-three state (§4).
 */
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

/** How long a trashed note has left, from the purge date the vault stamped.
 *  Null where the row carries none — this app never counts down from a date
 *  it had to invent. */
export function daysLeft(purgeAt: unknown, now: number = Date.now()): number | null {
  const stamp = Date.parse(String(purgeAt ?? ""));
  if (Number.isNaN(stamp)) return null;
  return Math.max(0, Math.ceil((stamp - now) / DAY_MS));
}

/** What a card with no text to preview is holding instead (§5's placeholder
 *  rule) — the gallery never becomes a wall of broken thumbnails. */
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

/** The label a placeholder block carries. The content type is STATED — a
 *  paste dump that says what it is stops being a paste dump. */
export function placeholderLabel(kind: Exclude<Placeholder, null>): string {
  if (kind === "audio") return "audio note";
  if (kind === "screenshot") return "screenshot";
  return "link only";
}
