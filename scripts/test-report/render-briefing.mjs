/**
 * The briefing half of the nightly report (#839 Wave 5) — the verdict strip,
 * the attention queue, grids E/F/G and the consent ledger, rendered above the
 * detail shelf that report v1 already draws.
 *
 * Nothing here decides anything: every state, count and rank arrives already
 * computed by `report-verdict.mjs` and `report-grids.mjs`. Keeping the markup
 * in its own module is what lets `generate.mjs`'s single-pass model stay one
 * file while the briefing grows, and it means a rendering change cannot
 * accidentally change a verdict.
 */

/** Shared HTML escape for every report renderer. */
export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Glyph for an evidence-derived state; grey glyphs never read as absence. */
function glyph(state) {
  if (state === "passed") return "●";
  if (state === "failed" || state === "infra-mismatch") return "▲";
  if (state === "flaky") return "◐";
  if (state === "skipped") return "–";
  if (state === "pinned") return "◈";
  return "○";
}

/** Milliseconds as a compact human duration, or an em dash. */
function duration(value) {
  if (!Number.isFinite(value)) return "—";
  if (value >= 60_000) return `${(value / 60_000).toFixed(1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}s`;
  return `${Math.round(value)}ms`;
}

/** A signed delta, where zero reads as "flat" rather than as nothing. */
function signed(value) {
  if (!Number.isFinite(value)) return "—";
  return value > 0 ? `+${value}` : value < 0 ? String(value) : "±0";
}

/**
 * The verdict strip: one computed level, the reasons behind it, and the deltas
 * against last night's durable history point.
 * @param {object} verdict From `computeVerdict`.
 * @param {object} delta From `verdictDelta`.
 * @param {object} queueCounts Severity-band counts for the queue.
 * @returns {string} HTML.
 */
export function renderVerdictStrip(verdict, delta, queueCounts) {
  const deltaChips = Object.entries(delta.deltas ?? {})
    .map(
      ([key, value]) =>
        `<span class="chip delta-${value > 0 ? "worse" : value < 0 ? "better" : "flat"}">${escapeHtml(key)} ${escapeHtml(signed(value))}</span>`
    )
    .join("");
  const priorNote = delta.priorLabel
    ? `vs <strong>${escapeHtml(delta.priorLabel)}</strong> · ${escapeHtml(delta.direction)}`
    : "no prior nightly in the durable history — nothing to compare against yet";
  const bands = ["S1", "S2", "S3", "S4"]
    .map(
      (band) =>
        `<span class="chip band-${band}">${band} <b>${queueCounts?.[band] ?? 0}</b></span>`
    )
    .join("");
  return `<section class="verdict verdict-${escapeHtml(verdict.level)}" aria-label="Nightly verdict">
<div class="verdict-main"><span class="eyebrow">Verdict</span><strong class="verdict-level">${escapeHtml(verdict.label)}</strong><p class="lede">${escapeHtml(verdict.reasons.join(" · "))}</p></div>
<div class="verdict-side"><div class="chips">${deltaChips}</div><p class="muted">${priorNote}</p><div class="chips">${bands}</div></div>
</section>`;
}

/**
 * The attention queue: every red, newly-grey, still-grey and stale item, each
 * carrying the file that owns it and its tracking-issue hook.
 * @param {object[]} queue From `buildAttentionQueue`.
 * @returns {string} HTML.
 */
export function renderAttentionQueue(queue) {
  if (!queue.length) {
    return `<section class="card wide"><h2>Attention queue</h2><p class="empty">Nothing is red, newly grey, stale, or pinned. This is the only state in which the queue is empty — an empty queue with grey cells on the page would be a bug in the queue, not good news.</p></section>`;
  }
  const rows = queue
    .map(
      (entry) =>
        `<tr class="queue-row ${escapeHtml(entry.severity)}"><td><span class="chip band-${escapeHtml(entry.severity)}">${escapeHtml(entry.severity)}</span></td><td><strong>${escapeHtml(entry.title)}</strong>${entry.isNew ? '<span class="chip chip-new">new tonight</span>' : ""}${entry.pinned ? '<span class="chip chip-pinned">pinned</span>' : ""}<br><small>${escapeHtml(entry.why)}</small></td><td>${escapeHtml(entry.state)}</td><td><code class="path">${escapeHtml(entry.owner ?? "no owner declared")}</code></td><td>${
          entry.trackingIssue
            ? entry.trackingUrl
              ? `<a href="${escapeHtml(entry.trackingUrl)}">#${entry.trackingIssue}</a>`
              : `#${entry.trackingIssue}`
            : '<small class="muted">auto-files under the nightly issue</small>'
        }</td></tr>`
    )
    .join("");
  return `<section class="card wide"><h2>Attention queue</h2><p class="muted axis-note">Ranked by severity derived from the matrix's own claim for each cell against tonight's observed state: <strong>S1</strong> a cell the matrix calls solid went red · <strong>S2</strong> any other red, or a lane that reported last night and is silent tonight · <strong>S3</strong> an absence or staleness that was already there · <strong>S4</strong> a standing finding awaiting a product decision. S1 and S2 entries ride into the auto-filed nightly tracking issue under the 24h SLA.</p><div class="matrix-scroll"><table class="data"><thead><tr><th>Sev</th><th>Item</th><th>State</th><th>Owner</th><th>Tracking</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
}

/**
 * Grid E — join laws and simulation laws over the join rig.
 * @param {object} grid From `buildJoinGrid`.
 * @returns {string} HTML.
 */
export function renderJoinGrid(grid) {
  const rows = grid.rows
    .map(
      (row) =>
        `<tr><td class="metric ${escapeHtml(row.state)}">${glyph(row.state)}</td><td><strong>${escapeHtml(row.label)}</strong><br><small>${escapeHtml(row.statement)}</small></td><td>${escapeHtml(row.kind)}</td><td>${escapeHtml(row.lane)}</td><td><code class="path">${escapeHtml(row.owner)}</code></td></tr>`
    )
    .join("");
  return `<section class="card wide"><h2>Join laws and simulation</h2><p class="muted axis-note">Every row derives from <code>tests/matrix.json#joinLaws</code>, and a validator pins that list to the owning suites' own test declarations — a deleted join law fails the matrix gate rather than quietly leaving this grid. ${grid.counts.scripted} scripted · ${grid.counts.simulation} simulation · ${grid.counts.passed} green tonight.</p><div class="matrix-scroll"><table class="data"><thead><tr><th></th><th>Law</th><th>Kind</th><th>Lane</th><th>Owner</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
}

/** One sparkline, or the empty slot that fills as nights accrue. */
function sparkline(values, renderTrend) {
  return values
    ? renderTrend(values)
    : '<span class="spark-slot" title="fills as durable nightly history accrues">no history yet</span>';
}

/**
 * Grid F — the adversary panel: mutation, fuzz, and property flows.
 * @param {object} panel From `buildAdversaryPanel`.
 * @param {(values: number[]) => string} renderTrend Sparkline renderer.
 * @returns {string} HTML.
 */
export function renderAdversaryPanel(panel, renderTrend) {
  const mutation = panel.mutation
    .map(
      (row) =>
        `<tr><td class="metric ${escapeHtml(row.state)}">${glyph(row.state)}</td><td>${escapeHtml(row.label)}<br><code class="path">${escapeHtml(row.id)}</code></td><td class="metric ${escapeHtml(row.state)}">${row.score ?? "—"}% <small>/ ${row.floor ?? "—"}%</small></td><td>${sparkline(row.sparkline, renderTrend)}</td></tr>`
    )
    .join("");
  const fuzz = panel.fuzz
    .map(
      (row) =>
        `<tr><td class="metric ${escapeHtml(row.state)}">${glyph(row.state)}</td><td>${escapeHtml(row.label)}<br><code class="path">${escapeHtml(row.entry ?? row.id)}</code></td><td>${row.seeds} seed(s) · ${row.crashers} crasher(s)</td><td>${
          row.findings.length
            ? row.findings
                .map(
                  (finding) =>
                    `<span class="chip chip-pinned">${escapeHtml(finding.id)} (#${escapeHtml(String(finding.issue ?? "?"))})</span>`
                )
                .join("")
            : '<small class="muted">no standing findings</small>'
        }</td></tr>`
    )
    .join("");
  const properties = panel.properties
    .map(
      (row) =>
        `<tr><td class="metric ${escapeHtml(row.state)}">${glyph(row.state)}</td><td>${escapeHtml(row.label)}</td><td>${
          row.flow
            ? `<code class="path">${escapeHtml(row.owner ?? row.flow)}</code>`
            : '<small class="muted">no property flow owns this engine yet</small>'
        }</td><td>${row.mutationSeed ? `<code class="path">${escapeHtml(row.mutationSeed)}</code>` : '<small class="muted">unseeded</small>'}</td></tr>`
    )
    .join("");
  return `<section class="card wide"><h2>Adversary panel</h2><p class="muted axis-note">The three ways this repo attacks itself, on one surface: <strong>mutation</strong> attacks the tests, <strong>fuzz</strong> attacks the code, <strong>property flows</strong> attack the orderings. ${panel.counts.mutationSeeds} mutation seed(s), ${panel.counts.mutationBelowFloor} under floor · ${panel.counts.fuzzTargets} fuzz target(s), ${panel.counts.fuzzCorpusSeeds} committed corpus input(s), ${panel.counts.pinnedFindings} standing finding(s) · ${panel.counts.propertyFlows} engine(s) with a property flow, ${panel.counts.enginesWithoutProperty} without. Sparklines draw from the durable nightly history and stay empty until at least two nights exist — an invented trend line would be the one lie a trust panel cannot afford.</p>
<div class="adversary-grid">
<div><h3>Mutation seeds vs floor</h3><div class="matrix-scroll"><table class="data"><thead><tr><th></th><th>Seed</th><th>Score</th><th>30-night trend</th></tr></thead><tbody>${mutation}</tbody></table></div></div>
<div><h3>Fuzz targets and corpus</h3><div class="matrix-scroll"><table class="data"><thead><tr><th></th><th>Target</th><th>Corpus</th><th>Standing findings</th></tr></thead><tbody>${fuzz}</tbody></table></div></div>
<div><h3>Engine property flows</h3><div class="matrix-scroll"><table class="data"><thead><tr><th></th><th>Engine</th><th>Property owner</th><th>Mutation seed</th></tr></thead><tbody>${properties}</tbody></table></div></div>
</div></section>`;
}

/**
 * Grid G — journeys, grouped by budgeting suite, budget against actual.
 * @param {object} grid From `buildJourneyGrid`.
 * @returns {string} HTML.
 */
export function renderJourneyGrid(grid) {
  const suites = grid.suites
    .map((suite) => {
      const rows = suite.rows
        .map(
          (row) =>
            `<tr><td class="metric ${escapeHtml(row.state)}">${glyph(row.state)}</td><td>${escapeHtml(row.label)}<br><code class="path">${escapeHtml(row.owner)}</code></td><td>${escapeHtml(duration(row.duration))}</td></tr>`
        )
        .join("");
      const budget =
        suite.budgetMinutes == null
          ? '<span class="chip delta-worse">no aggregate budget declared</span>'
          : `<span class="chip">budget ${suite.budgetMinutes}m</span>`;
      const actual =
        suite.actualMs == null
          ? '<span class="chip">actual — · no complete run evidence</span>'
          : `<span class="chip delta-${suite.budgetMs != null && suite.actualMs >= suite.budgetMs ? "worse" : "better"}">actual ${escapeHtml(duration(suite.actualMs))}</span>`;
      return `<div><h3>${escapeHtml(suite.label)}</h3><p class="chips">${budget}${actual}${suite.budgetDoc ? `<span class="chip"><code class="path">${escapeHtml(suite.budgetDoc)}</code></span>` : ""}</p><div class="matrix-scroll"><table class="data"><thead><tr><th></th><th>Journey</th><th>Actual</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
    })
    .join("");
  return `<section class="card wide"><h2>Journeys · budget vs actual</h2><p class="muted axis-note">Rows derive from <code>tests/matrix.json#journeys</code>, whose suite membership and budget are pinned to each runner's own <code>FLOWS</code> list and <code>BUDGET_MS</code> ceiling, and whose union is pinned to every flow file on disk. ${grid.counts.journeys} journey(s), ${grid.counts.passed} green tonight, ${grid.counts.unbudgeted} outside any aggregate budget.</p><div class="adversary-grid">${suites}</div></section>`;
}

/**
 * The consent ledger — one row per permission layer.
 * @param {object} ledger From `buildConsentLedger`.
 * @returns {string} HTML.
 */
export function renderConsentLedger(ledger) {
  const seatHeaders = ledger.seats
    .map((seat) => `<th scope="col">${escapeHtml(seat.label)}</th>`)
    .join("");
  const rows = ledger.rows
    .map(
      (row) =>
        `<tr><td class="metric ${escapeHtml(row.state)}">${glyph(row.state)}</td><td><strong>${escapeHtml(row.label)}</strong><br><small>${escapeHtml(row.note)}</small></td><td>${row.enforcement.map((file) => `<code class="path">${escapeHtml(file)}</code>`).join("<br>")}</td><td><code class="path">${escapeHtml(row.refusalGrammar)}</code></td><td>${row.adversaryOwner ? `<code class="path">${escapeHtml(row.adversaryOwner)}</code>` : '<small class="muted">no adversary owns this layer</small>'}</td>${row.seatCoverage
          .map(
            (seat) =>
              `<td class="metric ${seat.covered ? "passed" : "missing"}">${seat.covered ? "●" : "○"}</td>`
          )
          .join("")}</tr>`
    )
    .join("");
  return `<section class="card wide"><h2>Consent ledger</h2><p class="muted axis-note">One row per permission layer, from <code>tests/matrix.json#consentLedger</code>: where consent is enforced, the words it refuses in, the adversary that attacks it, and which seats it covers. ${ledger.counts.layers} layer(s) · ${ledger.counts.withoutAdversary} with no adversary · ${ledger.counts.fullSeatCoverage} covering all three seats.</p><div class="matrix-scroll"><table class="data"><thead><tr><th></th><th>Layer</th><th>Enforcement point</th><th>Refusal grammar</th><th>Adversary</th>${seatHeaders}</tr></thead><tbody>${rows}</tbody></table></div></section>`;
}

/**
 * Styles the briefing adds on top of the report's own component layer
 * (`report-theme.mjs`), which sits on top of the generated design-system sheet.
 * Same rule as that layer: a declaration here names the STATE it paints and
 * takes its `--st-*` rung, and declares no colour, face or scale of its own.
 */
export const BRIEFING_CSS = `.verdict{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,360px);gap:var(--sp-5);align-items:center;padding:var(--sp-5);margin-bottom:var(--sp-3);border:1px solid var(--line);border-radius:var(--r-lg);background:var(--bg-elev);border-left:5px solid var(--st-absent)}.verdict-shippable{border-left-color:var(--st-solid)}.verdict-degraded{border-left-color:var(--st-degraded)}.verdict-red{border-left-color:var(--st-failed)}.verdict-no-evidence{border-left-color:var(--st-absent)}.verdict-level{display:block;font-family:var(--font-sans);font-weight:600;font-size:var(--t-chapter-size);letter-spacing:var(--t-display-tracking);line-height:1.05;margin:var(--sp-1) 0 var(--sp-2)}.verdict-shippable .verdict-level{color:var(--st-solid-text)}.verdict-degraded .verdict-level{color:var(--st-degraded-text)}.verdict-red .verdict-level{color:var(--st-failed-text)}.verdict-no-evidence .verdict-level{color:var(--st-absent-text)}.chips{display:flex;gap:var(--sp-1);flex-wrap:wrap;margin:0 0 var(--sp-2)}.chip{display:inline-flex;align-items:center;gap:var(--sp-1);padding:3px var(--sp-2);border:1px solid var(--line-strong);border-radius:var(--r-pill);font:var(--t-control);color:var(--text-soft);margin-right:var(--sp-1)}.chip b{color:var(--text);font-variant-numeric:var(--t-mono-numeric)}.delta-worse{border-color:var(--st-failed-text);color:var(--st-failed-text)}.delta-better{border-color:var(--st-solid-text);color:var(--st-solid-text)}.chip-new{border-color:var(--st-degraded-text);color:var(--st-degraded-text)}.chip-pinned{border-color:var(--st-pinned);color:var(--st-pinned)}.band-S1{border-color:var(--st-s1);color:var(--st-s1)}.band-S2{border-color:var(--st-s2);color:var(--st-s2)}.band-S3{border-color:var(--st-s3);color:var(--st-s3)}.band-S4{border-color:var(--st-s4);color:var(--st-s4)}.queue-row td{vertical-align:top}.metric.pinned{color:var(--st-pinned)}.metric.unowned,.metric.stale{color:var(--st-absent-text)}.metric.flaky{color:var(--st-flaky-text)}.metric.skipped{color:var(--st-na-text)}.metric.infra-mismatch{color:var(--st-failed-text)}.metric.owner-silent,.metric.lane-did-not-run,.metric.evidence-unmatched{color:var(--st-silent-text)}.spark-slot{display:inline-block;min-width:120px;padding:var(--sp-1) 0;color:var(--text-soft);font:var(--t-annot-label);border-bottom:1px dashed var(--line-strong)}.adversary-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:var(--sp-4)}.adversary-grid h3{font:var(--t-annot-label-on);margin:0 0 var(--sp-2);color:var(--text-soft)}@media(max-width:900px){.verdict{grid-template-columns:1fr}}`;
