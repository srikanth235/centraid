/**
 * §8 adversaries and §9 trends (#915 Wave 3).
 *
 * §8 is the three falsifiers the author did not write: mutation seeds against
 * their floors, every fuzz target, and the engine registry with the property
 * flow that owns each engine or the honest "no owner".
 *
 * §9 draws a series only once it has fourteen candidates behind it, with the
 * trailing-30 interquartile band and an emphasised endpoint. "No trend yet" is
 * gone: a series with too few points is a number in §10, not an empty chart.
 */

import { escapeHtml, pill, section, table } from "./util.mjs";

/** The minimum candidates a series needs before it earns a chart. */
export const TREND_MINIMUM_POINTS = 14;

/** §8. */
export function renderAdversaries(model) {
  const { seeds, mutation, fuzzTargets, fuzz, engines } = model.adversaries;
  const scoreBySeed = new Map(mutation.map((row) => [row.id, row]));
  const mutationRows = seeds
    .map((seed) => {
      const observed = scoreBySeed.get(seed.id);
      const score = observed?.score;
      const floor = observed?.floor;
      const low =
        Number.isFinite(score) && Number.isFinite(floor) && score < floor;
      return `<tr><td class="mono">${escapeHtml(seed.id)}</td><td>${
        Number.isFinite(score)
          ? `<span class="bar${low ? " low" : ""}" style="width:${Math.round(score * 0.9)}px"></span><span class="mono">${score.toFixed(1)}</span>`
          : `<span class="small">no score tonight</span>`
      }</td><td class="num">${Number.isFinite(floor) ? floor : "—"}</td><td class="num">${observed?.survived ?? "—"}</td></tr>`;
    })
    .join("");

  const fuzzByTarget = new Map(fuzz.map((row) => [row.id, row]));
  const fuzzRows = fuzzTargets
    .map((target) => {
      const observed = fuzzByTarget.get(target.id) ?? {};
      return `<tr><td class="mono">${escapeHtml(target.id)}</td><td class="num">${observed.execs ?? "—"}</td><td class="num">${observed.corpus ?? "—"}</td><td>${observed.newFindings ?? 0}</td><td>${escapeHtml(observed.known ?? "0")}</td></tr>`;
    })
    .join("");

  const engineRows = engines
    .map((engine) => {
      const owned = Boolean(engine.propertyFlow);
      return `<tr><td class="mono">${escapeHtml(engine.id)}</td><td class="small">${escapeHtml((engine.source ?? []).join(", "))}</td><td class="mono small">${escapeHtml(engine.propertyFlow ?? "—")}</td><td>${pill(owned ? "passed" : "no-evidence")}</td><td>${owned ? "" : pill("failed", "no owner")}</td></tr>`;
    })
    .join("");

  const body = `<div class="adv">
  <div class="card"><h4>Mutation <span class="sum">${seeds.length} seeds</span></h4>
    ${table(["Seed", "Score", '<span class="num">Floor</span>', '<span class="num">Survived</span>'], mutationRows)}
    <p class="small">Floors are up-only; a package below its floor appears in §1 as a blocker.</p></div>
  <div class="card"><h4>Fuzz <span class="sum">${fuzzTargets.length} targets</span></h4>
    ${table(["Target", '<span class="num">Execs</span>', '<span class="num">Corpus</span>', "New", "Known"], fuzzRows)}
    <p class="small">A known finding is keyed by class in <span class="mono">known-findings.json</span>; anything new fails the lane.</p></div>
  <div class="card wide"><h4>Property flows over engines <span class="sum">${engines.length} engines · ${engines.filter((engine) => engine.propertyFlow).length} owned</span></h4>
    ${table(["Engine", "Source", "Property flow", "Tonight", "Gap"], engineRows)}</div>
</div>`;

  return section(
    "adversaries",
    "Author-blind falsifiers",
    "Adversaries",
    "mutation, fuzz, and property flows the author did not write",
    "Tests written by the same agent that wrote the code confirm rather than falsify. These three lanes are derived from seeds, corpora, and engine schemas instead. Floors are up-only; a package below its floor appears above as a blocker.",
    body
  );
}

/** The trailing interquartile band of a series. */
export function band(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    q1: sorted[Math.floor(sorted.length * 0.25)],
    q3: sorted[Math.floor(sorted.length * 0.75)],
  };
}

/** One trend card, drawn as inline SVG so the archive needs no script. */
function chart(trend) {
  const data = trend.points;
  const width = 300;
  const height = 70;
  const pad = 4;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = max - min || 1;
  const x = (index) =>
    pad + (index * (width - 2 * pad)) / Math.max(1, data.length - 1);
  const y = (value) =>
    height - pad - ((value - min) / span) * (height - 2 * pad);
  const { q1, q3 } = band(data.slice(-30));
  const last = data.at(-1);
  const out = last > q3 || last < q1;
  const tone = out
    ? trend.lowerIsBetter
      ? last > q3
        ? "out-bad"
        : "out-ok"
      : last < q1
        ? "out-bad"
        : "out-ok"
    : "";
  const path = data
    .map(
      (value, index) =>
        `${index ? "L" : "M"}${x(index).toFixed(1)},${y(value).toFixed(1)}`
    )
    .join(" ");
  const format = (value) =>
    Math.abs(value) < 10 ? value.toFixed(2) : Math.round(value);
  return `<div class="card trend">
  <div class="t"><span class="name">${escapeHtml(trend.name)}</span><span class="last ${tone}">${format(last)} ${escapeHtml(trend.unit)}${out ? " · out of band" : ""}</span></div>
  <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="${escapeHtml(trend.name)}, ${data.length} candidates">
    <rect class="band" x="${pad}" y="${y(q3).toFixed(1)}" width="${width - 2 * pad}" height="${Math.max(0, y(q1) - y(q3)).toFixed(1)}"/>
    <line class="quart" x1="${pad}" x2="${width - pad}" y1="${y(q1).toFixed(1)}" y2="${y(q1).toFixed(1)}"/>
    <line class="quart" x1="${pad}" x2="${width - pad}" y1="${y(q3).toFixed(1)}" y2="${y(q3).toFixed(1)}"/>
    <path class="line" d="${path}"/>
    <circle class="end ${tone}" cx="${x(data.length - 1).toFixed(1)}" cy="${y(last).toFixed(1)}" r="3.5"/>
  </svg>
  <div class="foot"><span>${data.length} candidates · band ${format(q1)}–${format(q3)}</span><span>${trend.budget ? `budget ${format(trend.budget)} ${escapeHtml(trend.unit)}` : "gauge · no budget"}</span></div>
</div>`;
}

/** §9. */
export function renderTrends(model) {
  const drawable = model.trends.filter(
    (trend) => (trend.points ?? []).length >= TREND_MINIMUM_POINTS
  );
  const body =
    drawable.length === 0
      ? `<p class="small">No series has reached ${TREND_MINIMUM_POINTS} candidates yet; each one's latest number is in the evidence appendix below.</p>`
      : `<div class="trends">${drawable.map(chart).join("")}</div>`;
  return section(
    "trends",
    `Only series with ${TREND_MINIMUM_POINTS} or more points`,
    "Trends",
    "with their noise band, endpoint emphasised",
    `A series earns a chart at ${TREND_MINIMUM_POINTS} candidates. Until then it is a number in the evidence appendix. The band is the trailing 30-night interquartile range; a point outside it is what feeds "since yesterday". A card reading "gauge · no budget" is a measured number with no ceiling behind it — a series still waiting for the ledger to say what it should cost, not a gate someone dropped.`,
    body
  );
}
