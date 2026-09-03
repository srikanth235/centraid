import { SEVERITY_RANK } from "./severity.mjs";

export function addDays(date, days) {
  const parsed = Date.parse(`${date}T00:00:00Z`);
  return new Date(parsed + days * 86_400_000).toISOString().slice(0, 10);
}

export function dayGap(from, to) {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Number.isFinite(a) && Number.isFinite(b)
    ? Math.round((b - a) / 86_400_000)
    : null;
}

export function buildBlockers({ rows, today }) {
  return rows
    .filter(
      (row) =>
        row.verdict === "failed" &&
        (row.severity === "S1" || row.severity === "S2")
    )
    .map((row) => ({
      severity: row.severity,
      lane: row.lane,
      case: row.firstFailingCase,
      platform: row.platform,
      firstRed: row.firstRed,
      lastGreen: row.lastGreen,
      owner: row.owner ?? null,
      ageHours: row.ageHours ?? 0,
      overSla: (row.ageHours ?? 0) > 24,
      deadline: `${addDays(today, 1)} (24 h to owned)`,
      issue: row.parked?.issue ?? null,
    }))
    .sort(
      (a, b) =>
        SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
        b.ageHours - a.ageHours
    );
}

export function buildAttention({ rows, today, sla = 24 }) {
  const queue = [];
  for (const row of rows) {
    if (row.verdict === "passed") continue;
    let state = row.verdict;
    let deadline = null;
    if (row.parked) {
      state = "parked";
      deadline = `expires ${row.parked.until}`;
    } else if (row.verdict === "failed") {
      state = "failed";
      deadline =
        (row.ageHours ?? 0) >= sla
          ? `fix or park by ${addDays(today, 1)}`
          : `owned by ${addDays(today, 1)}`;
    } else if (row.verdict === "degraded") {
      state = "degraded";
      deadline = `back in band or budget by ${addDays(today, 7)}`;
    } else if (row.verdict === "no-evidence") {
      state = "no evidence";
      deadline = `write evidence or register the absence by ${addDays(today, 1)}`;
    }
    queue.push({
      severity: row.severity,
      lane: row.lane,
      platform: row.platform,
      state,
      owner: row.owner ?? null,
      ageDays:
        row.parked && row.parkedSince ? dayGap(row.parkedSince, today) : null,
      ageHours: row.ageHours ?? 0,
      deadline,
      issue: row.parked?.issue ?? null,
      why: row.firstFailingCase ?? "",
    });
  }
  return queue.sort(
    (a, b) =>
      (b.ageDays ?? b.ageHours / 24) - (a.ageDays ?? a.ageHours / 24) ||
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
  );
}

export function buildSinceYesterday({ rows, previousEvidence, today }) {
  const newRed = [];
  const newGreen = [];
  const newlyParked = [];
  const expiring = [];
  const outOfBand = [];
  const budgetPressure = [];

  for (const row of rows) {
    const before = previousEvidence.get(row.lane)?.verdict ?? null;
    if (row.verdict === "failed" && before !== "failed") {
      newRed.push({
        lane: row.lane,
        why: `${row.firstFailingCase ?? "lane"} · ${row.severity}`,
      });
    }
    if (
      row.verdict === "passed" &&
      (before === "failed" || before === "parked")
    ) {
      newGreen.push({ lane: row.lane, why: `was ${before}` });
    }
    if (row.parked && before !== "parked") {
      newlyParked.push({
        lane: row.lane,
        why: `until ${row.parked.until} · #${row.parked.issue}`,
      });
    }
    if (row.parked) {
      const days = dayGap(today, row.parked.until);
      if (days !== null && days <= 7) {
        expiring.push({
          lane: row.lane,
          why: `expires ${row.parked.until} (${days}d) · #${row.parked.issue} · will count as red`,
        });
      }
    }
    if (row.outOfBand)
      outOfBand.push({
        lane: row.lane,
        why: row.bandWhy ?? "outside its noise band",
      });
    if (
      row.p95Ms !== null &&
      row.budgetMs > 0 &&
      row.p95Ms / row.budgetMs > 0.8
    ) {
      budgetPressure.push({
        lane: row.lane,
        why: `${Math.round(row.p95Ms / 60_000)} min of ${Math.round(row.budgetMs / 60_000)} budget`,
      });
    }
  }

  return { newRed, newGreen, newlyParked, expiring, outOfBand, budgetPressure };
}
