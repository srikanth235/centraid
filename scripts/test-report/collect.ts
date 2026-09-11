/**
 * Everything the report reads off disk (#915 Wave 3).
 *
 * `read-model.mjs` is pure and `render/` is pure; this module is the only
 * place that touches the filesystem, so the whole page can be driven from a
 * fixture root by handing `buildModel` the same shapes with none of the I/O.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { dict, entries, isRecord } from "./record.ts";

/** Read JSON at `file`, or `fallback` when it is absent or unreadable. */
export function readJsonAt(file: string, fallback: unknown = null): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch {
    return fallback;
  }
}

/** The durable history points, oldest first, capped at `limit`. */
export function readHistory(dir: string, limit: number = 30) {
  let names;
  try {
    names = readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .sort();
  } catch {
    return [];
  }
  return names
    .map((name) => readJsonAt(path.join(dir, name)))
    .filter(Boolean)
    .slice(-limit);
}

/**
 * Coverage rows against their floors, with the sustained-headroom candidates.
 * `floorsFile` is the merged floors ledger; the globs are its `coverage`
 * section (#915 Wave 4).
 */
export function readCoverageFloors({
  summaryFile,
  floorsFile,
  history = [],
}: {
  summaryFile?: string;
  floorsFile?: string;
  history?: unknown[];
} = {}) {
  const summary = dict(readJsonAt(String(summaryFile ?? ""), null));
  const floors = dict(dict(readJsonAt(String(floorsFile ?? ""), {})).coverage);
  const rows: Record<string, unknown>[] = [];
  const candidates: Record<string, unknown>[] = [];
  for (const [scope, floor] of Object.entries(floors)) {
    if (scope.startsWith("_") || scope === "approvedDeviation") continue;
    if (!isRecord(floor)) continue;
    const lines = Number(
      dict(dict(summary[scope]).lines).pct ??
        dict(dict(summary.total).lines).pct ??
        Number.NaN
    );
    const target = Number(floor.lines ?? floor.statements ?? Number.NaN);
    const headroom =
      Number.isFinite(lines) && Number.isFinite(target)
        ? Number((lines - target).toFixed(1))
        : null;
    // A ratchet candidate is headroom that has SURVIVED: the same scope has
    // been above its floor on every night in the durable history we hold.
    const sustained =
      headroom !== null &&
      headroom >= 5 &&
      history.length >= 14 &&
      history.every((point) => {
        const series = dict(dict(point).floorSeries);
        const held = series[scope] ?? target;
        return Number(held) >= target;
      });
    if (sustained) candidates.push({ scope, raiseTo: Math.floor(lines - 3) });
    rows.push({
      scope,
      lines: Number.isFinite(lines) ? Number(lines.toFixed(1)) : null,
      floor: Number.isFinite(target) ? target : null,
      headroom,
      ratchetCandidate: sustained
        ? `sustained ${history.length} nights → raise to ${Math.floor(lines - 3)}`
        : null,
    });
  }
  return {
    rows: rows.sort((a, b) => String(a.scope).localeCompare(String(b.scope))),
    candidates,
  };
}

/** Mutation scores joined with their floors. */
export function readMutation({
  scoresFile,
  floorsFile,
}: {
  scoresFile?: string;
  floorsFile?: string;
} = {}) {
  const scores = dict(readJsonAt(String(scoresFile ?? ""), null));
  const floors = dict(dict(readJsonAt(String(floorsFile ?? ""), {})).mutation);
  const rows: Record<string, unknown>[] = [];
  for (const [id, raw] of entries(scores.seeds ?? scores)) {
    if (id.startsWith("_")) continue;
    const entry = dict(raw);
    const score = Number(entry.score ?? entry.mutationScore ?? raw);
    if (!Number.isFinite(score)) continue;
    const floorEntry = dict(floors[id]);
    rows.push({
      id,
      score,
      floor: Number(floorEntry.score ?? floors[id] ?? Number.NaN),
      survived: Number(entry.survived ?? Number.NaN),
    });
  }
  return rows;
}

/** Fuzz results, if the lane published any. */
export function readFuzz(file: string) {
  const parsed = dict(readJsonAt(file, null));
  if (Object.keys(parsed).length === 0) return [];
  return entries(parsed.targets ?? parsed).map(([id, raw]) => {
    const entry = dict(raw);
    return {
      id,
      execs: entry.execs ?? null,
      corpus: entry.corpus ?? null,
      newFindings: entry.new ?? 0,
      known: String(entry.known ?? 0),
    };
  });
}

/** `QUALITY.md`'s `## Open` section, one entry per bullet, with an age. */
export function readFieldObservations(file: string, today: string) {
  let source;
  try {
    source = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const section = source.split(/^## Open\s*$/mu)[1]?.split(/^## /mu)[0] ?? "";
  return section
    .split(/\n(?=- )/u)
    .map((entry) => entry.replace(/\s+/gu, " ").trim())
    .filter((entry) => entry.startsWith("- "))
    .map((entry) => {
      const text = entry.slice(2);
      const title =
        /\*\*(?<title>[^*]+)\*\*/u.exec(text)?.groups?.title ??
        text.slice(0, 120);
      const seen =
        /\((?<date>\d{4}-\d{2}-\d{2})\)/u.exec(text)?.groups?.date ?? null;
      const ageDays = seen
        ? Math.round((Date.parse(today) - Date.parse(seen)) / 86_400_000)
        : null;
      return { title, detail: null, ageDays };
    });
}

/** The down-only inventories, as counts for the evidence appendix. */
export function readInventory(root: string) {
  // The four ledgers of #915 Wave 4: skips, env-red and sleeps are sections of
  // tests/inventory.json; the flaky-test entries are tests/quarantine.json.
  const inventory = dict(
    readJsonAt(path.join(root, "tests/inventory.json"), {})
  );
  const quarantine = dict(
    readJsonAt(path.join(root, "tests/quarantine.json"), { entries: [] })
  );
  const count = (value: unknown) =>
    Object.keys(dict(dict(value).sites)).filter((key) => !key.startsWith("_"))
      .length;
  return {
    skips: count(inventory.skips),
    envRed: count(inventory.envRed),
    sleeps: count(inventory.sleeps),
    quarantine: Array.isArray(quarantine.entries)
      ? quarantine.entries.length
      : 0,
  };
}

/**
 * Trend series from the durable history's `laneSeries`, one per measurement.
 * A series is handed to the renderer whole; §9 decides whether it has enough
 * points to earn a chart.
 */
export function readTrends(history: unknown[]) {
  const series = new Map<
    string,
    {
      name: string;
      unit: unknown;
      points: number[];
      budget: unknown;
      lowerIsBetter: boolean;
    }
  >();
  for (const point of history) {
    for (const [name, raw] of entries(dict(point).laneSeries)) {
      const value = dict(raw);
      const numeric = Number(value.value ?? raw);
      if (!Number.isFinite(numeric)) continue;
      const current = series.get(name);
      if (!current) {
        series.set(name, {
          name,
          unit: value.unit ?? "",
          points: [numeric],
          budget: value.budget ?? null,
          lowerIsBetter: value.lowerIsBetter !== false,
        });
      } else {
        current.points.push(numeric);
      }
    }
  }
  return [...series.values()];
}
