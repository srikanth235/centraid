// The `[[` powerbox: what it searches, in what order it groups, and how a
// selected passage becomes an anchor (Notes spec §3, §5).
//
// SEVEN KINDS, AND LOCKER IS NOT ONE OF THEM. The exclusion is enforced by
// the query (`queries/link-targets.ts` never probes the locker), and stated
// on the sheet's foot (`view-copy.ts`), so the absence is a sentence the
// member reads rather than a hole they notice.
import type { LinkTarget } from "./types.ts";

/**
 * The kind column, in the order the sheet lists it. It is the order of the
 * spec's own sentence — notes, people, events, tasks, expenses, photos,
 * documents — because a ranked list across seven apps still has to be
 * scannable by the app a member is thinking of.
 */
export const KIND_ORDER: readonly string[] = [
  "Notes",
  "People",
  "Agenda",
  "Tasks",
  "Tally",
  "Photos",
  "Docs",
];

export interface TargetGroup {
  /** The kind column's word — the app the far end lives in. */
  app: string;
  targets: LinkTarget[];
}

/**
 * Group the powerbox's answers by kind, in `KIND_ORDER`, dropping the kinds
 * that answered nothing. A kind whose scope was denied simply does not
 * appear: the query isolates each probe, so one closed door empties one
 * column rather than the sheet.
 */
export function groupTargets(targets: readonly LinkTarget[]): TargetGroup[] {
  const byApp = new Map<string, LinkTarget[]>();
  for (const target of targets) {
    const app = target.app || "Notes";
    if (!byApp.has(app)) byApp.set(app, []);
    byApp.get(app)!.push(target);
  }
  const known = KIND_ORDER.filter((app) => byApp.has(app)).map((app) => ({
    app,
    targets: byApp.get(app)!,
  }));
  // A kind the order does not name still lists, after the seven: the query
  // is the authority on what is linkable, and swallowing a row because this
  // table had not heard of it would be the UI overruling it.
  const extra = [...byApp.keys()]
    .filter((app) => !KIND_ORDER.includes(app))
    .toSorted((a, b) => a.localeCompare(b))
    .map((app) => ({ app, targets: byApp.get(app)! }));
  return [...known, ...extra];
}

/** The `[[` sigil the editor watches for, and the term typed after it. */
export interface WikiProbe {
  /** Where the `[[` starts, so the pick can replace from there. */
  start: number;
  term: string;
}

/**
 * Is the caret inside an unclosed `[[`? Returns the sigil's offset and the
 * term typed since — the whole of what opens the powerbox while writing.
 */
export function probeAt(body: string, caret: number): WikiProbe | null {
  const head = body.slice(0, caret);
  const open = head.lastIndexOf("[[");
  if (open === -1) return null;
  const term = head.slice(open + 2);
  // A closing pair, or a line break, ends the probe: `[[` from two
  // paragraphs ago is not what the member is typing into now.
  if (term.includes("]]") || term.includes("\n")) return null;
  return { start: open, term };
}

export interface PassageAnchor {
  exact: string;
  prefix: string;
  suffix: string;
  start: number;
}

/** How much of the surrounding text an anchor carries on each side. Enough
 *  to re-find the passage after an edit nearby, short enough that the anchor
 *  is not a second copy of the note. */
const CONTEXT = 32;

/**
 * The passage a link anchors to, from the editor's own selection. An empty
 * selection returns null and the link is made to the note as a whole — a
 * standoff anchor over nothing would be a claim the member never made.
 */
export function anchorFrom(
  body: string,
  selectionStart: number,
  selectionEnd: number
): PassageAnchor | null {
  const from = Math.min(selectionStart, selectionEnd);
  const to = Math.max(selectionStart, selectionEnd);
  const exact = body.slice(from, to);
  if (exact.trim() === "") return null;
  return {
    exact,
    prefix: body.slice(Math.max(0, from - CONTEXT), from),
    suffix: body.slice(to, to + CONTEXT),
    start: from,
  };
}

/**
 * Where an anchored passage sits in the body NOW, or null when the passage
 * was edited away. The degraded case is a designed state: the link still
 * points at the note, and the chip says so rather than pretending to a
 * position it lost.
 */
export function resolveAnchor(
  body: string,
  anchor: { exact?: string; prefix?: string; start?: number } | null | undefined
): { start: number; end: number } | null {
  const exact = anchor?.exact;
  if (typeof exact !== "string" || exact === "") return null;
  const hinted = typeof anchor?.start === "number" ? anchor.start : 0;
  // The remembered offset first, then the prefix, then the text anywhere:
  // each fallback is weaker evidence about the same passage, and the first
  // one that holds is the one the reader is shown.
  if (body.slice(hinted, hinted + exact.length) === exact)
    return { start: hinted, end: hinted + exact.length };
  const prefix = anchor?.prefix;
  if (typeof prefix === "string" && prefix !== "") {
    const withPrefix = body.indexOf(prefix + exact);
    if (withPrefix !== -1)
      return {
        start: withPrefix + prefix.length,
        end: withPrefix + prefix.length + exact.length,
      };
  }
  const loose = body.indexOf(exact);
  return loose === -1 ? null : { start: loose, end: loose + exact.length };
}
