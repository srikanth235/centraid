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
  color: string;
  blurb: string;
}

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
    label: "Harness cache",
    color: "var(--c-slate)",
    blurb: "Harness scratch space — derived, safe to delete.",
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
});

const COMPONENT_ORDER = Object.keys(
  COMPONENT_PRESENTATION
) as LocalComponentId[];

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
  fraction: number;
  unreadable?: string;
}

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
  kind: FootprintScaleKind;
  againstBytes: number | null;
  fillFraction: number;
  over: boolean;
  warnFraction: number | null;
}

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
    return `${used} of your ${of} budget — over.`;
  }
  if (report.limit.status === "degraded") {
    return `${used} of your ${of} budget — past the ${limits.warnAtPercent}% mark.`;
  }
  return `${used} of your ${of} budget.`;
}
