/**
 * §4 lane health board and §5 journeys (#915 Wave 3).
 *
 * §4 is the page the promotion and demotion rules read from, so every number
 * the rules use is on it: pass rate on candidates with the demote flag, p95
 * against the rung budget, the last green SHA, and the 30-run history. The
 * filters, the name search and the `/` `e` `?` keys are the only script on the
 * page, and it is inert without JavaScript — every row is already in the HTML.
 */

import {
  budgetBar,
  escapeHtml,
  ms,
  pill,
  section,
  sev,
  sha,
  sparkline,
  table,
} from "./util.mjs";

/** §4. */
export function renderLaneBoard(model) {
  const rows = model.lanes
    .map((row, index) => {
      const attention = row.verdict !== "passed";
      const detailId = `lane-detail-${index}`;
      const cases =
        row.cases.length === 0
          ? `<div class="c"><span>no cases reported</span><span>—</span></div>`
          : row.cases
              .map(
                (entry) =>
                  `<div class="c"><span>${escapeHtml(entry.id)}</span><span>${escapeHtml(entry.verdict)}${
                    Number.isFinite(entry.durationMs)
                      ? ` · ${Math.round(entry.durationMs / 1000)}s`
                      : ""
                  }${entry.attempts > 1 ? ` · ${entry.attempts} attempts` : ""}</span></div>`
              )
              .join("");
      return `<tr class="lanerow" tabindex="0" role="button" aria-expanded="false" aria-controls="${detailId}" data-rung="${row.rung}" data-plat="${escapeHtml(row.platform)}" data-attention="${attention}" data-name="${escapeHtml(row.lane)}">
  <td class="mono">${row.rung}</td>
  <td><span class="lane">${escapeHtml(row.lane)}</span> ${sev(row.severity)}</td>
  <td class="plat">${escapeHtml(row.platform)}</td>
  <td>${pill(row.verdict)}${Number.isFinite(row.durationMs) && row.verdict !== "parked" ? `<span class="desc">${ms(row.durationMs)}</span>` : ""}</td>
  <td>${sparkline(row.history, row.lane)}</td>
  <td class="rate${row.demote ? " low" : ""}">${row.passRate === null ? "—" : `${row.passRate}%`}${row.demote ? " ↓ demote" : ""}</td>
  <td>${budgetBar(row.p95Ms, row.budgetMs)}${row.overBudget ? `<span class="desc">over budget — cut to ${ms(row.budgetMs)}</span>` : ""}</td>
  <td>${sha(row.lastGreen)}</td>
  <td>${pill(row.status === "parked" ? "parked" : row.status === "advisory" ? "no-evidence" : "degraded", row.status)}</td>
</tr>
<tr class="detail" id="${detailId}" hidden><td colspan="9"><div class="cases">${cases}</div></td></tr>`;
    })
    .join("");

  const chips = `<div class="chips" id="laneFilters" role="group" aria-label="Filter lanes">
  <button type="button" class="chip" data-f="rung:all" aria-pressed="true">all rungs</button>
  <button type="button" class="chip" data-f="rung:2" aria-pressed="false">2 · merge</button>
  <button type="button" class="chip" data-f="rung:3" aria-pressed="false">3 · candidate</button>
  <button type="button" class="chip" data-f="rung:4" aria-pressed="false">4 · nightly</button>
  <button type="button" class="chip" data-f="rung:5" aria-pressed="false">5 · weekly</button>
  <span class="gapchip"></span>
  ${["ios", "android", "web", "desktop", "gateway"]
    .map(
      (platform) =>
        `<button type="button" class="chip" data-f="plat:${platform}" aria-pressed="false">${platform}</button>`
    )
    .join("\n  ")}
  <span class="gapchip"></span>
  <button type="button" class="chip" data-f="only:attention" aria-pressed="false">needs attention</button>
  <input id="laneSearch" class="chip" type="search" placeholder="/ filter by name" aria-label="Filter lanes by name">
</div>`;

  return section(
    "lanes",
    "Every lane, every rung",
    "Lane health",
    "the page the promotion and demotion rules read from",
    "A rung-2 lane below 99 % on candidates is demoted. Three consecutive reds park a lane. A p95 above budget reds the lane itself. Click a lane for tonight's cases.",
    chips +
      table(
        [
          "Rung",
          "Lane",
          "Platform",
          "Tonight",
          "30 runs on candidates",
          "Pass",
          "p95 vs budget",
          "Last green",
          "Status",
        ],
        rows,
        "laneTable"
      )
  );
}

/** §5 — every committed flow, grouped by the suite whose budget bounds it. */
export function renderJourneys(model) {
  const rows = model.journeys
    .map((suite) => {
      const observedP95 = suite.flows.reduce(
        (total, flow) => total + (flow.budgetMs ?? 0),
        0
      );
      const slack =
        suite.budgetMs > 0 &&
        observedP95 > 0 &&
        suite.budgetMs > 1.5 * observedP95;
      const head = `<tr class="suite"><td colspan="7"><b>${escapeHtml(suite.id)}</b> · rung ${suite.rung} · ${suite.flows.length} flows<span class="sb">${
        suite.parked
          ? pill("parked", suite.parked)
          : `budget ${ms(suite.budgetMs)}${slack ? ` · <span class="pill degraded">budget &gt; 1.5× p95 · lower to ${ms(Math.ceil(observedP95 * 1.5))}</span>` : ""}`
      }</span></td></tr>`;
      const body = suite.flows
        .map((flow) => {
          const observed = model.caseResults?.get(flow.id) ?? null;
          const verdict =
            observed?.verdict ?? (suite.parked ? "parked" : "no-evidence");
          return `<tr>
  <td><span class="lane">${escapeHtml(flow.id)}</span></td>
  <td class="plat">${escapeHtml(suite.platform)}</td>
  <td class="mono">${suite.rung}</td>
  <td>${pill(verdict === "skipped" ? "no-evidence" : verdict)}</td>
  <td>${flow.budgetMs ? budgetBar(observed?.durationMs ?? null, flow.budgetMs) : `<span class="small">no flow budget</span>`}</td>
  <td class="mono">${observed?.attempts ?? "—"}</td>
  <td class="small">${escapeHtml(flow.claim)}</td>
</tr>`;
        })
        .join("");
      return head + body;
    })
    .join("");

  const alarm = model.alarm
    ? `<div class="alarm"><span class="bell"></span><span><b>Alarm sounded</b> on ${escapeHtml(model.alarm.last)} · ${escapeHtml(model.alarm.what)} · next: ${escapeHtml(model.alarm.next)}</span></div>`
    : `<div class="alarm"><span class="bell"></span><span><b>Alarm</b> — no sounding recorded yet in the durable history.</span></div>`;

  return section(
    "journeys",
    "Device and browser flows, budgeted",
    "Journeys",
    "every committed flow, its suite budget, and what it cost tonight",
    "Grouped by suite because the budget is per suite and tighten-only. A flow is listed once at its home rung; the roster is the single source, so a flow with no row here does not exist. Budgets that sit more than 1.5× above the observed p95 are flagged with the number to lower to.",
    alarm +
      table(
        [
          "Flow",
          "Platform",
          "Rung",
          "Tonight",
          "Cost vs flow budget",
          "Attempts",
          "Claim",
        ],
        rows,
        "journeyTable"
      )
  );
}
