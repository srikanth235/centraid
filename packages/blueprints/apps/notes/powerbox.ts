import { LINK_TARGET_KINDS, linkTargetAppLabel } from "./link-targets-table.ts";
import type { LinkTarget } from "./types.ts";

export const KIND_ORDER: readonly string[] = LINK_TARGET_KINDS.map((kind) =>
  linkTargetAppLabel(kind.appId)
);

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
  const extra = [...byApp.keys()]
    .filter((app) => !KIND_ORDER.includes(app))
    .sort((a, b) => a.localeCompare(b))
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
  if (term.includes("]]") || term.includes("\n")) return null;
  return { start: open, term };
}

export interface PassageAnchor {
  exact: string;
  prefix: string;
  suffix: string;
  start: number;
}

const CONTEXT = 32;

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

export function resolveAnchor(
  body: string,
  anchor: { exact?: string; prefix?: string; start?: number } | null | undefined
): { start: number; end: number } | null {
  const exact = anchor?.exact;
  if (typeof exact !== "string" || exact === "") return null;
  const hinted = typeof anchor?.start === "number" ? anchor.start : 0;
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
