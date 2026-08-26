/**
 * The briefing half of the nightly report (#839 Wave 5) — the attention queue,
 * grids E/F/G and the consent ledger, rendered above the detail shelf that
 * report v1 already draws. The verdict is no longer built here: #862 moved it
 * into the page's own masthead bar, beside the run identity it grades.
 *
 * Nothing here decides anything: every state, count and rank arrives already
 * computed by `report-verdict.mjs` and `report-grids.mjs`. Keeping the markup
 * in its own module is what lets `generate.mjs`'s single-pass model stay one
 * file while the briefing grows, and it means a rendering change cannot
 * accidentally change a verdict.
 *
 * All five sections speak the Night Watch register (#862): a row is a CSS grid
 * whose columns line up down the section, a verdict is a coloured WORD rather
 * than a fill, and a column with no source renders an em dash rather than a
 * plausible number.
 */

/** Shared HTML escape for every report renderer. */
export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Milliseconds as a compact human duration, or an em dash. */
function duration(value) {
  if (!Number.isFinite(value)) return "—";
  if (value >= 60_000) return `${(value / 60_000).toFixed(1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}s`;
  return `${Math.round(value)}ms`;
}

/**
 * The tone a verdict word is spoken in. Tone is the SECOND reading — the word
 * carries the meaning on its own, so a reader who sees no hue loses nothing.
 *
 * The families are the cell register's, not a second set (#864): a flaky law is
 * violet in a ledger row exactly as it is in §8, an unowned layer takes the gap
 * family, and `stale` rejoins the greys it belongs with — it used to be spoken
 * in the attention tone, which on this page now means only "the report cannot
 * vouch for its own evidence".
 */
function tone(state) {
  if (state === "passed") return "ok";
  if (state === "failed" || state === "infra-mismatch") return "red";
  if (state === "flaky") return "flaky";
  if (state === "unowned") return "gap";
  if (
    state === "pinned" ||
    state === "owner-silent" ||
    state === "evidence-unmatched"
  ) {
    return "warn";
  }
  return "grey";
}

/**
 * What tonight's evidence for a ledger row actually was, as one word.
 *
 * ONE word map for the whole page (#864). This used to be a second vocabulary —
 * `green` where a cell said `passed`, `no evidence` where a cell said `missing`
 * — on the argument that a ledger row sits beside prose and a cell carries a
 * label. That argument cost more than it bought: a reader comparing §6 to §8 had
 * to know that two words were one fact, and the legend could not gloss both. The
 * words are now the cells' words, and `no owner` is the single name for "no test
 * exists" on every grid, matrix and app-axis alike.
 */
function verdictWord(state) {
  return (
    {
      passed: "passed",
      failed: "failed",
      flaky: "flaky",
      stale: "stale",
      skipped: "n/a",
      pinned: "pinned",
      unowned: "no owner",
      missing: "missing",
      "infra-mismatch": "infra",
      "owner-silent": "silent",
      "lane-did-not-run": "no lane",
      "evidence-unmatched": "unmatched",
    }[state] ?? state
  );
}

/** A row's verdict cell: the word, in its tone. */
function stateCell(state) {
  return `<span class="state ${tone(state)}">${escapeHtml(verdictWord(state))}</span>`;
}

/**

 * One ledger row. A cell is either an HTML fragment or a `[class, fragment]`
 * pair; the roles are spelled out because these are grid divs rather than a
 * table, and a grid with no roles reads to a screen reader as one run-on line.
 * @param {(string|string[])[]} cells The row's cells, already escaped.
 * @param {{head?: boolean}} [options] `head` marks the column-header row.
 * @returns {string} HTML.
 */
function lrow(cells, { head = false } = {}) {
  const role = head ? "columnheader" : "cell";
  return `<div class="lrow${head ? " head" : ""}" role="row">${cells
    .map((cell) => {
      const [name, html] = Array.isArray(cell) ? cell : ["", cell];
      return `<span role="${role}"${name ? ` class="${name}"` : ""}>${html}</span>`;
    })
    .join("")}</div>`;
}

/** A ledger's frame, with the label the section is known by. */
function ledger(kind, label, rows) {
  return `<div class="ledger ${kind}" role="table" aria-label="${escapeHtml(label)}">${rows.join("")}</div>`;
}

/** An owner path, or the honest absence in its place. */
function ownerCell(owner, absent) {
  return owner
    ? `<span class="path">${escapeHtml(owner)}</span>`
    : `<small class="quiet">${escapeHtml(absent)}</small>`;
}

/** The chip family and word for a queue entry's kind. */
function queueChip(entry) {
  if (entry.kind === "red") return ["red", "red"];
  if (entry.kind === "pinned-finding") return ["pinned", "pinned"];
  if (entry.kind === "stale") return ["stale", "stale"];
  return entry.isNew ? ["newgrey", "new grey"] : ["stale", "grey"];
}

/**
 * The attention queue: every red, newly-grey, still-grey and stale item, each
 * carrying the file that owns it, how old its newest evidence is, and its
 * tracking-issue hook.
 * @param {object[]} queue From `buildAttentionQueue`.
 * @param {(lastAt: string|null) => string|null} ageOf Evidence age formatter.
 * @returns {string} HTML.
 */
export function renderAttentionQueue(queue, ageOf) {
  const bands = `<p class="keyline"><i>S1</i> a cell the matrix calls solid went red · <i>S2</i> any other red, or a lane that reported last night and is silent tonight · <i>S3</i> an absence or staleness that was already there · <i>S4</i> a standing finding awaiting a product decision. S1 and S2 ride into the auto-filed nightly tracking issue under the 24h SLA.</p>`;
  if (!queue.length) {
    return `<div class="queue" aria-label="Attention queue"><p class="empty">Nothing is red, newly grey, stale, or pinned. This is the only state in which the queue is empty — an empty queue with grey cells on the page would be a bug in the queue, not good news.</p></div>${bands}`;
  }
  const rows = queue
    .map((entry) => {
      const [family, word] = queueChip(entry);
      const age = ageOf(entry.lastAt);
      const tracking = entry.trackingIssue
        ? entry.trackingUrl
          ? `<a href="${escapeHtml(entry.trackingUrl)}">#${entry.trackingIssue}</a>`
          : `#${entry.trackingIssue}`
        : `<small class="quiet">auto-files under the nightly issue</small>`;
      return `<div class="qrow" role="listitem"><span class="qband"><span class="chip ${family}">${word}</span><small class="sev">${escapeHtml(entry.severity)}</small></span><span class="what">${escapeHtml(entry.title)}<small>${escapeHtml(entry.why)}${entry.isNew ? " · new tonight" : ""}</small></span><span class="own path">${escapeHtml(entry.owner ?? "no owner declared")}</span><span class="age num">${escapeHtml(age ?? "—")}</span><span class="act">${tracking}</span></div>`;
    })
    .join("");
  return `<div class="queue" role="list" aria-label="Attention queue">${rows}</div>${bands}`;
}

/**
 * Grid E — join laws and simulation laws over the join rig.
 * @param {object} grid From `buildJoinGrid`.
 * @param {(lastAt: string|null) => string|null} ageOf Evidence age formatter.
 * @returns {string} HTML.
 */
export function renderJoinGrid(grid, ageOf) {
  const rows = [
    lrow(["Law", "Claim", "Evidence", "Verdict"], { head: true }),
    ...grid.rows.map((row) => {
      const age = ageOf(row.lastAt);
      return lrow([
        `<strong>${escapeHtml(row.label)}</strong><small class="quiet">${escapeHtml(row.kind)} · ${escapeHtml(row.lane)}</small>`,
        `${escapeHtml(row.statement)}<small class="quiet path">${escapeHtml(row.owner)}</small>`,
        ["quiet num", age ? `ran ${escapeHtml(age)} ago` : "no run stamp"],
        stateCell(row.state),
      ]);
    }),
  ];
  return `<p class="budget"><b>${grid.rows.length} laws</b> from <code>tests/matrix.json#joinLaws</code>, pinned by a validator to the owning suites' own test declarations — a deleted law fails the matrix gate rather than quietly leaving this ledger · <b>${grid.counts.scripted}</b> scripted · <b>${grid.counts.simulation}</b> simulation · <b>${grid.counts.passed}</b> passed tonight</p>${ledger("joins", "Join laws and simulation", rows)}`;
}

/** One sparkline, or the empty slot that fills as nights accrue. */
function sparkline(values, renderTrend) {
  return values
    ? renderTrend(values)
    : '<span class="spark-slot" title="fills as durable nightly history accrues">no history yet</span>';
}

/**
 * Grid F — the adversary panel: mutation, fuzz, and property flows.
 *
 * Three catalogs, three ledgers, one column geometry. They are not folded into
 * the design's five summary rows because nothing computes those summaries: a
 * median mutation score and a seeded-orderings tally would each be a number
 * this repo does not measure, and the per-seed and per-target rows are what it
 * actually has.
 *
 * @param {object} panel From `buildAdversaryPanel`.
 * @param {(values: number[]) => string} renderTrend Sparkline renderer.
 * @returns {string} HTML.
 */
export function renderAdversaryPanel(panel, renderTrend) {
  const mutation = [
    lrow(["Seed", "Score", "Floor", "30-night trend", "Status"], {
      head: true,
    }),
    ...panel.mutation.map((row) =>
      lrow([
        `<strong>${escapeHtml(row.label)}</strong><small class="quiet path">${escapeHtml(row.id)}</small>`,
        [
          `num state ${tone(row.state)}`,
          row.score == null ? "—" : `${row.score.toFixed(1)}%`,
        ],
        ["quiet num", row.floor == null ? "no floor" : `${row.floor}%`],
        sparkline(row.sparkline, renderTrend),
        [
          "quiet",
          row.state === "passed"
            ? "at or above its floor"
            : row.state === "failed"
              ? "below its floor"
              : "no score tonight — the nightly Stryker lane did not report",
        ],
      ])
    ),
  ];
  const fuzz = [
    lrow(["Target", "Corpus", "Crashers", "Verdict", "Standing findings"], {
      head: true,
    }),
    ...panel.fuzz.map((row) =>
      lrow([
        `<strong>${escapeHtml(row.label)}</strong><small class="quiet path">${escapeHtml(row.entry ?? row.id)}</small>`,
        ["quiet num", `${row.seeds} seed(s)`],
        ["quiet num", String(row.crashers)],
        stateCell(row.state),
        [
          "quiet",
          row.findings.length
            ? row.findings
                .map(
                  (finding) =>
                    `${escapeHtml(finding.id)} (#${escapeHtml(String(finding.issue ?? "?"))})`
                )
                .join(" · ")
            : "no standing findings",
        ],
      ])
    ),
  ];
  const properties = [
    lrow(["Engine", "Verdict", "Mutation seed", "Property flow", "Owner"], {
      head: true,
    }),
    ...panel.properties.map((row) =>
      lrow([
        `<strong>${escapeHtml(row.label)}</strong>`,
        stateCell(row.state),
        [
          "quiet path",
          row.mutationSeed ? escapeHtml(row.mutationSeed) : "unseeded",
        ],
        ["quiet path", row.flow ? escapeHtml(row.flow) : "—"],
        ownerCell(row.owner, "no property flow owns this engine yet"),
      ])
    ),
  ];
  return `<div aria-label="Adversary panel"><p class="budget"><b>Mutation</b> attacks the tests · ${panel.counts.mutationSeeds} seed(s) · ${panel.counts.mutationBelowFloor} under floor</p>${ledger("adv", "Mutation seeds vs floor", mutation)}
<p class="budget"><b>Fuzz</b> attacks the code · ${panel.counts.fuzzTargets} target(s) · ${panel.counts.fuzzCorpusSeeds} committed corpus input(s) · ${panel.counts.fuzzCrashers} crasher(s) · ${panel.counts.pinnedFindings} standing finding(s)</p>${ledger("adv", "Fuzz targets and corpus", fuzz)}
<p class="budget"><b>Property flows</b> attack the orderings · ${panel.counts.propertyFlows} engine(s) covered · ${panel.counts.enginesWithoutProperty} without</p>${ledger("adv", "Engine property flows", properties)}</div>`;
}

/**
 * Grid G — journeys, grouped by the suite that budgets them, budget against
 * actual. The app × platform axis the design draws is not rendered here: see
 * the section's own note for what would have to be declared first.
 * @param {object} grid From `buildJourneyGrid`.
 * @returns {string} HTML.
 */
export function renderJourneyGrid(grid) {
  const suites = grid.suites
    .map((suite) => {
      const budget =
        suite.budgetMinutes == null
          ? "no aggregate budget declared"
          : `<b>budget ${suite.budgetMinutes}m</b>`;
      // A suite is only over budget once EVERY journey in it reported; the
      // null case says so rather than reading a partial sum against a whole
      // suite's ceiling.
      const actual =
        suite.actualMs == null
          ? "<b>actual —</b> · no complete run evidence"
          : `<b class="state ${suite.budgetMs != null && suite.actualMs >= suite.budgetMs ? "red" : "ok"}">actual ${escapeHtml(duration(suite.actualMs))}</b>`;
      const rows = [
        lrow(["Journey", "Owner", "Actual", "Verdict"], { head: true }),
        ...suite.rows.map((row) =>
          lrow([
            `<strong>${escapeHtml(row.label)}</strong>`,
            ownerCell(row.owner, "no owner declared"),
            ["quiet num", escapeHtml(duration(row.duration))],
            stateCell(row.state),
          ])
        ),
      ];
      return `<p class="budget"><b>${escapeHtml(suite.label)}</b> · ${budget} · ${actual}${suite.budgetDoc ? ` · <code class="path">${escapeHtml(suite.budgetDoc)}</code>` : ""}</p>${ledger("journeys", `${suite.label} journeys`, rows)}`;
    })
    .join("");
  return `<div aria-label="Journeys · budget vs actual"><p class="budget"><b>${grid.counts.journeys} journey(s)</b> from <code>tests/matrix.json#journeys</code>, whose suite membership and budget are pinned to each runner's own flow list and ceiling · <b>${grid.counts.passed}</b> passed tonight · <b>${grid.counts.unbudgeted}</b> outside any aggregate budget</p>${suites}</div>`;
}

/**
 * The consent ledger — one row per permission layer.
 * @param {object} ledgerModel From `buildConsentLedger`.
 * @returns {string} HTML.
 */
export function renderConsentLedger(ledgerModel) {
  const rows = [
    lrow(["Layer", "Enforcement point", "Adversary", "Seats", "Verdict"], {
      head: true,
    }),
    ...ledgerModel.rows.map((row) => {
      const covered = row.seatCoverage.filter((seat) => seat.covered).length;
      return lrow([
        `<strong>${escapeHtml(row.label)}</strong><small class="quiet">${escapeHtml(row.note)}</small>`,
        `<span class="path">${row.enforcement.map((file) => escapeHtml(file)).join(" · ")}</span><small class="quiet">refuses in <code>${escapeHtml(row.refusalGrammar)}</code></small>`,
        ownerCell(row.adversaryOwner, "no adversary owns this layer"),
        ["quiet num", `${covered} / ${row.seatCoverage.length}`],
        stateCell(row.state),
      ]);
    }),
  ];
  return `<p class="budget"><b>${ledgerModel.counts.layers} layer(s)</b> from <code>tests/matrix.json#consentLedger</code> · <b>${ledgerModel.counts.withoutAdversary}</b> with no adversary · <b>${ledgerModel.counts.fullSeatCoverage}</b> covering every seat</p>${ledger("consent", "Consent ledger", rows)}`;
}

/**
 * Styles the briefing adds on top of the report's own component layer
 * (`report-theme.mjs`), which sits on top of the generated design-system sheet.
 * Same rule as that layer: a declaration here names the STATE it paints and
 * takes its `--st-*` rung, and declares no colour, face or scale of its own.
 *
 * What is left is the DETAIL SHELF's vocabulary only. The briefing's own chips,
 * bands and sub-grids moved into the Night Watch register in `report-theme.mjs`
 * (#862), and rules for markup nothing emits any more are deleted rather than
 * left to rot: an unreferenced rule is how a `var()` outlives the token it
 * names without any gate noticing.
 */
export const BRIEFING_CSS = `.metric.stale{color:var(--st-absent-text)}.metric.flaky{color:var(--st-flaky-text)}.metric.skipped{color:var(--st-na-text)}.metric.infra-mismatch{color:var(--st-failed-text)}.spark-slot{display:inline-block;min-width:96px;padding:var(--sp-1) 0;color:var(--text-soft);font:var(--t-annot-label);border-bottom:1px dashed var(--line-strong)}`;
