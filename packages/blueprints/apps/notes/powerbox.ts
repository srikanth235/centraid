// `[[` powerbox (Notes spec §3, §5). SEVEN KINDS; LOCKER IS NOT ONE — `queries/link-targets.ts` never probes it, and `view-copy.ts` states the absence on the sheet's foot.
import type { LinkTarget } from "./types.ts";

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
  app: string;
  targets: LinkTarget[];
}

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
  // A kind the order does not name still lists after the seven: the query is the authority on what is linkable.
  const extra = [...byApp.keys()]
    .filter((app) => !KIND_ORDER.includes(app))
    .toSorted((a, b) => a.localeCompare(b))
    .map((app) => ({ app, targets: byApp.get(app)! }));
  return [...known, ...extra];
}

export interface WikiProbe {
  start: number;
  term: string;
}

export function probeAt(body: string, caret: number): WikiProbe | null {
  const head = body.slice(0, caret);
  const open = head.lastIndexOf("[[");
  if (open === -1) return null;
  const term = head.slice(open + 2);
  // A closing pair or line break ends the probe — `[[` from two paragraphs ago is not the current type-in.
  if (term.includes("]]") || term.includes("\n")) return null;
  return { start: open, term };
}

export interface PassageAnchor {
  exact: string;
  prefix: string;
  suffix: string;
  start: number;
}

/** Surrounding chars an anchor carries each side — enough to re-find after a nearby edit, not a second copy of the note. */
const CONTEXT = 32;

/** Empty selection → null (link the note as a whole; do not invent a standoff over nothing). */
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

/** Where the passage sits NOW, or null if edited away — do not pretend a lost position. */
export function resolveAnchor(
  body: string,
  anchor: { exact?: string; prefix?: string; start?: number } | null | undefined
): { start: number; end: number } | null {
  const exact = anchor?.exact;
  if (typeof exact !== "string" || exact === "") return null;
  const hinted = typeof anchor?.start === "number" ? anchor.start : 0;
  // Remembered offset, then prefix, then the text anywhere — first hit wins; each later fallback is weaker.
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
