import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export function readJsonAt(file, fallback = null) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

export function readHistory(dir, limit = 30) {
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

export function readCoverageFloors({ summaryFile, floorsFile, history }) {
  const summary = readJsonAt(summaryFile, null);
  const floors = readJsonAt(floorsFile, {}).coverage ?? {};
  const rows = [];
  const candidates = [];
  for (const [scope, floor] of Object.entries(floors)) {
    if (scope.startsWith("_") || scope === "approvedDeviation") continue;
    if (!floor || typeof floor !== "object") continue;
    const lines = Number(
      summary?.[scope]?.lines?.pct ?? summary?.total?.lines?.pct ?? Number.NaN
    );
    const target = Number(floor.lines ?? floor.statements ?? Number.NaN);
    const headroom =
      Number.isFinite(lines) && Number.isFinite(target)
        ? Number((lines - target).toFixed(1))
        : null;
    const sustained =
      headroom !== null &&
      headroom >= 5 &&
      history.length >= 14 &&
      history.every(
        (point) => (point.floorSeries?.[scope] ?? target) >= target
      );
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
    rows: rows.sort((a, b) => a.scope.localeCompare(b.scope)),
    candidates,
  };
}

export function readMutation({ scoresFile, floorsFile }) {
  const scores = readJsonAt(scoresFile, null);
  const floors = readJsonAt(floorsFile, {}).mutation ?? {};
  const rows = [];
  for (const [id, entry] of Object.entries(scores?.seeds ?? scores ?? {})) {
    if (id.startsWith("_")) continue;
    const score = Number(entry?.score ?? entry?.mutationScore ?? entry);
    if (!Number.isFinite(score)) continue;
    rows.push({
      id,
      score,
      floor: Number(floors?.[id]?.score ?? floors?.[id] ?? Number.NaN),
      survived: Number(entry?.survived ?? Number.NaN),
    });
  }
  return rows;
}

export function readFuzz(file) {
  const parsed = readJsonAt(file, null);
  if (!parsed) return [];
  return Object.entries(parsed.targets ?? parsed).map(([id, entry]) => ({
    id,
    execs: entry?.execs ?? null,
    corpus: entry?.corpus ?? null,
    newFindings: entry?.new ?? 0,
    known: String(entry?.known ?? 0),
  }));
}

export function readFieldObservations(file, today) {
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

export function readInventory(root) {
  const inventory = readJsonAt(path.join(root, "tests/inventory.json"), {});
  const quarantine = readJsonAt(path.join(root, "tests/quarantine.json"), {
    entries: [],
  });
  const count = (value) =>
    Object.keys(value?.sites ?? {}).filter((key) => !key.startsWith("_"))
      .length;
  return {
    skips: count(inventory.skips),
    envRed: count(inventory.envRed),
    sleeps: count(inventory.sleeps),
    quarantine: (quarantine.entries ?? []).length,
  };
}

export function readTrends(history) {
  const series = new Map();
  for (const point of history) {
    for (const [name, value] of Object.entries(point.laneSeries ?? {})) {
      const numeric = Number(value?.value ?? value);
      if (!Number.isFinite(numeric)) continue;
      if (!series.has(name))
        series.set(name, {
          name,
          unit: value?.unit ?? "",
          points: [],
          budget: value?.budget ?? null,
          lowerIsBetter: value?.lowerIsBetter !== false,
        });
      series.get(name).points.push(numeric);
    }
  }
  return [...series.values()];
}
