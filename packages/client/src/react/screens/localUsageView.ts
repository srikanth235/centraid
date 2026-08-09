/*
 * The Storage page's presentation derivation (issue #544) — every decision
 * about what the footprint READS AS, kept pure and framework-free so the
 * numbers can be asserted in a unit test instead of a rendered DOM.
 *
 * The gateway reports per-vault components and gateway-level components
 * separately (`serve/local-usage.ts`), because that is the shape it can
 * measure honestly. The owner does not think in that split — they think
 * "what is using my disk", and only THEN "which vault". So this rolls the two
 * into one ordered legend, and keeps the per-vault rows available underneath.
 *
 * Colour is assigned per component id, not per rank: a component keeps its
 * hue as the numbers move, so the bar does not reshuffle its palette between
 * two polls. Hues come from the icon palette (`--c-*`), which is the one
 * ramp in this codebase already designed to be told apart at a glance.
 */

import { formatBytes } from "../../format.js";
import type {
  LocalComponentId,
  LocalComponentUsageDTO,
  LocalUsageReportDTO,
  StorageLimitsDTO,
} from "../../gateway-client-local-storage.js";

export { formatBytes } from "../../format.js";

export interface ComponentPresentation {
  label: string;
  /** A CSS colour token — the segment's hue and its legend chip. */
  color: string;
  /** One line of plain language: what this actually is. */
  blurb: string;
}

/** Fixed per-component presentation. Order of the keys is the tiebreak order
 *  used when two components report the same byte count. */
export const COMPONENT_PRESENTATION: Readonly<
  Record<LocalComponentId, ComponentPresentation>
> = Object.freeze({
  attachments: {
    label: "Attachments",
    color: "var(--c-indigo)",
    blurb:
      "Files, photos, and the previews and archive segments derived from them.",
  },
  ledger: {
    label: "Ledger",
    color: "var(--c-teal)",
    blurb:
      "Conversations, runs, and the audit trail — the file the ledger limit governs.",
  },
  "vault-db": {
    label: "Vault database",
    color: "var(--c-violet)",
    blurb: "The ontology itself: every entity, link, and setting.",
  },
  code: {
    label: "App code",
    color: "var(--c-forest)",
    blurb: "The code store behind your apps — every version you have built.",
  },
  apps: {
    label: "App data",
    color: "var(--c-ochre)",
    blurb: "Per-app working directories.",
  },
  backup: {
    label: "Backup staging",
    color: "var(--c-amber)",
    blurb: "Snapshot keyring, engine state, and bytes waiting to go offsite.",
  },
  cache: {
    label: "Runner cache",
    color: "var(--c-slate)",
    blurb: "Coding-agent scratch space. Derived — safe to delete at any time.",
  },
  logs: {
    label: "Logs",
    color: "var(--c-rose)",
    blurb: "Rotated gateway logs.",
  },
  templates: {
    label: "Templates",
    color: "var(--c-slate)",
    blurb: "Cached app templates pulled from the remote manifest.",
  },
  storage: {
    label: "Gateway state",
    color: "var(--c-slate)",
    blurb: "Storage-connection records and the recovery-kit flag.",
  },
  // The P4 storage line (#726 D4): what hosting other people's data costs
  // THIS disk, named rather than folded into a total that reads as if it
  // were all the owner's own.
  borrowed: {
    label: "Held for others",
    color: "var(--c-rose)",
    blurb:
      "Rows and files other people have lent access to through this machine — not yours, not backed up, but on your disk.",
  },
});

const COMPONENT_ORDER = Object.keys(
  COMPONENT_PRESENTATION
) as LocalComponentId[];

/**
 * Presentation for a component id, INCLUDING one this build does not
 * recognize. `LocalComponentId` is a checked union in this file's own type
 * system, but the wire gives no such guarantee at runtime: a newer gateway
 * can report a component id shipped after this client was built, and
 * `readJson`'s cast does not validate against the union. Indexing
 * `COMPONENT_PRESENTATION` directly with such an id reads `undefined` and
 * throws on the next `.label`/`.color` access — the exact crash issue #726's
 * audit found on `"borrowed"` before this id existed here. Falling back to
 * the raw id as its own label keeps the real byte count on screen (never
 * dropped, never a thrown card) without inventing a name for something this
 * build cannot describe.
 */
export function presentationFor(component: string): ComponentPresentation {
  return (
    COMPONENT_PRESENTATION[component as LocalComponentId] ?? {
      label: component,
      color: "var(--c-slate)",
      blurb: "A newer component this app version does not yet describe.",
    }
  );
}

export interface FootprintSlice {
  component: LocalComponentId;
  label: string;
  color: string;
  blurb: string;
  bytes: number;
  /** Share of the total footprint in [0, 1]; 0 when the total is 0. */
  fraction: number;
  /** Any read failure encountered under this component, verbatim. */
  unreadable?: string;
}

/** Roll per-vault and gateway-level components into ONE ordered legend,
 *  largest first. Zero-byte components are dropped — a legend row that always
 *  reads "0 B" is noise, and the per-vault detail still lists them. */
export function footprintSlices(report: LocalUsageReportDTO): FootprintSlice[] {
  const totals = new Map<
    LocalComponentId,
    { bytes: number; unreadable?: string }
  >();
  const add = (entry: LocalComponentUsageDTO): void => {
    const prior = totals.get(entry.component);
    totals.set(entry.component, {
      bytes: (prior?.bytes ?? 0) + entry.bytes,
      ...((prior?.unreadable ?? entry.unreadable)
        ? { unreadable: prior?.unreadable ?? entry.unreadable }
        : {}),
    });
  };
  for (const entry of report.components) add(entry);
  for (const vault of report.vaults)
    for (const entry of vault.components) add(entry);

  const total = report.totalBytes;
  return [...totals.entries()]
    .filter(([, value]) => value.bytes > 0)
    .map(([component, value]) => {
      const presentation = presentationFor(component);
      return {
        component,
        label: presentation.label,
        color: presentation.color,
        blurb: presentation.blurb,
        bytes: value.bytes,
        fraction: total > 0 ? value.bytes / total : 0,
        ...(value.unreadable ? { unreadable: value.unreadable } : {}),
      };
    })
    .sort(
      (a, b) =>
        b.bytes - a.bytes ||
        COMPONENT_ORDER.indexOf(a.component) -
          COMPONENT_ORDER.indexOf(b.component)
    );
}

export type FootprintScaleKind = "budget" | "disk" | "none";

export interface FootprintScale {
  /** What the rail is drawn against. */
  kind: FootprintScaleKind;
  /** Denominator in bytes; `null` when there is nothing to scale against. */
  againstBytes: number | null;
  /** Fill fraction, clamped to [0, 1] so an over-budget bar stays in its box. */
  fillFraction: number;
  /** `true` once used bytes exceed `againstBytes` — the rail shows overflow. */
  over: boolean;
  /** Where the warn threshold sits along the rail, in [0, 1]; `null` off-budget. */
  warnFraction: number | null;
}

/**
 * What the occupancy rail measures against, in priority order:
 *
 *   1. the owner's budget, when they set one — that is the number they care
 *      about, and the only one they chose;
 *   2. otherwise the physical disk, which at least gives the figure a sense
 *      of scale;
 *   3. otherwise nothing — a bare total, no bar. Inventing a denominator
 *      ("assume 100 GB") would make the fill fraction a fiction.
 */
export function footprintScale(report: LocalUsageReportDTO): FootprintScale {
  const budget = report.limits.totalLimitBytes;
  if (budget !== null && budget > 0) {
    const raw = report.totalBytes / budget;
    return {
      kind: "budget",
      againstBytes: budget,
      fillFraction: Math.min(1, raw),
      over: raw > 1,
      warnFraction: Math.min(1, report.limits.warnAtPercent / 100),
    };
  }
  // Disk total, not free space: "3 GB of 500 GB" is a stable statement, while
  // "3 GB of 142 GB free" moves whenever anything else on the machine writes.
  const diskTotal = report.disk?.totalBytes ?? 0;
  if (diskTotal > 0) {
    return {
      kind: "disk",
      againstBytes: diskTotal,
      fillFraction: Math.min(1, report.totalBytes / diskTotal),
      over: false,
      warnFraction: null,
    };
  }
  return {
    kind: "none",
    againstBytes: null,
    fillFraction: 0,
    over: false,
    warnFraction: null,
  };
}

/** Parses "12", "12 GB", "500mb" into bytes. `null` for anything unparseable
 *  — the limit inputs refuse rather than guess at a unit. */
export function parseBytes(
  input: string,
  defaultUnit: "MB" | "GB" = "GB"
): number | null {
  const match =
    /^\s*(?<amount>[0-9]+(?:\.[0-9]+)?)\s*(?<unit>b|kb|mb|gb|tb)?\s*$/iu.exec(
      input
    );
  if (!match) return null;
  const value = Number(match.groups?.amount);
  if (!Number.isFinite(value) || value <= 0) return null;
  const unit = (match.groups?.unit ?? defaultUnit).toUpperCase();
  const scale: Record<string, number> = {
    B: 1,
    KB: 1024,
    MB: 1024 ** 2,
    GB: 1024 ** 3,
    TB: 1024 ** 4,
  };
  return Math.round(value * (scale[unit] ?? 1));
}

/** One sentence naming the state of the budget. Deliberately says what is NOT
 *  happening when over-budget: nothing is blocked, and a user staring at a red
 *  bar deserves to know that before they start deleting things in a panic. */
export function budgetSummary(
  report: LocalUsageReportDTO,
  limits: StorageLimitsDTO
): string {
  if (limits.totalLimitBytes === null) {
    const free = report.disk
      ? ` ${formatBytes(report.disk.freeBytes)} free on this disk.`
      : "";
    return `No budget set — Centraid will use whatever the disk allows.${free}`;
  }
  const used = formatBytes(report.totalBytes);
  const of = formatBytes(limits.totalLimitBytes);
  if (report.limit.status === "error") {
    return `${used} of your ${of} budget — over. Nothing is being blocked; this is a warning so you can decide what to clear.`;
  }
  if (report.limit.status === "degraded") {
    return `${used} of your ${of} budget — past the ${limits.warnAtPercent}% mark.`;
  }
  return `${used} of your ${of} budget.`;
}
