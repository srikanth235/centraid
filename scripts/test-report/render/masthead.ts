/**
 * §0 — masthead, verdict lamp, and the sticky rail (#915 Wave 3).
 *
 * The first screen has to answer "can we ship the candidate?" without
 * scrolling: the night and the candidate it ran on, how old the evidence is,
 * how much of the 90-minute budget it spent, the lamp, one sentence of why,
 * the delta against last night, and the single change that would flip it.
 */

import { dict, finite, items, text, type ReportModel } from "../record.ts";
import { escapeHtml } from "./util.ts";

/** `2h 14m`, or `unknown` when nothing dated the evidence. */
export function ageWords(ms: unknown) {
  if (!finite(ms)) return "unknown";
  const minutes = Math.round(ms / 60_000);
  return minutes >= 60
    ? `${Math.floor(minutes / 60)}h ${minutes % 60}m`
    : `${minutes}m`;
}

/** The masthead's meta line. */
function meta(model: ReportModel) {
  const candidate = dict(model.candidate);
  const sha = text(candidate.sha);
  const promotedAt = text(candidate.promotedAt);
  const run = dict(model.run);
  const linksBag = dict(model.links);
  const bits = [
    `<span><span class="k">night</span> <span class="v">${escapeHtml(model.night)}</span></span>`,
    sha
      ? `<span><span class="k">candidate</span> <span class="v mono">${escapeHtml(sha.slice(0, 9))}</span>${
          promotedAt
            ? ` <span class="k">promoted</span> <span class="v">${escapeHtml(promotedAt.slice(11, 16))} UTC</span>`
            : ""
        }</span>`
      : `<span><span class="k">candidate</span> <span class="v">none — ran on the tip of main</span></span>`,
    `<span><span class="k">evidence</span> <span class="v">${escapeHtml(ageWords(model.evidenceAgeMs))} old</span></span>`,
    `<span><span class="k">ran</span> <span class="v">${model.minutesUsed} min of ${model.budgetMinutes}</span></span>`,
  ];
  const links = [
    run.url ? `<a href="${escapeHtml(run.url)}">actions run</a>` : null,
    linksBag.previous
      ? `<a href="${escapeHtml(linksBag.previous)}">previous night</a>`
      : null,
    linksBag.permalink
      ? `<a href="${escapeHtml(linksBag.permalink)}">permalink to this run</a>`
      : null,
  ].filter(Boolean);
  if (links.length > 0) bits.push(`<span>${links.join(" · ")}</span>`);
  return bits.join("");
}

/** The masthead and the verdict lamp. */
export function renderMasthead(model: ReportModel) {
  const lamp = dict(model.verdict);
  const verdict = text(lamp.verdict);
  const why = lamp.why;
  const flip = lamp.flip;
  const counts = dict(model.counts);
  const laneTotal = model.lanes.length;
  const delta = dict(model.delta);
  return `<header class="mast">
  <div class="brand">Night <b>Watch</b></div>
  <div class="mastmeta">${meta(model)}</div>
</header>
<div class="verdict ${verdict.toLowerCase()}" id="verdict" role="status">
  <div class="lamp" aria-hidden="true"></div>
  <div>
    <div class="eyebrow">Can we ship the candidate?</div>
    <p class="vword">${escapeHtml(verdict)}</p>
    <p class="vwhy">${escapeHtml(why)}</p>
    <div class="vdelta">
      <span>yesterday <b>${escapeHtml(delta.previousVerdict ?? "unrecorded")}</b>${
        delta.previousCandidate
          ? ` on <span class="mono">${escapeHtml(text(delta.previousCandidate).slice(0, 9))}</span>`
          : ""
      }</span>
      <span>new red <b>${delta.newRed}</b></span>
      <span>new green <b>${delta.newGreen}</b></span>
      <span>parked <b>${counts.parked ?? 0}</b>${Number(delta.expiring) > 0 ? ` · ${delta.expiring} expiring within 7d` : ""}</span>
      <span>lanes <b>${laneTotal}</b> · passed <b>${counts.passed ?? 0}</b> · failed <b>${counts.failed ?? 0}</b> · degraded <b>${counts.degraded ?? 0}</b> · parked <b>${counts.parked ?? 0}</b> · no evidence <b>${counts["no-evidence"] ?? 0}</b></span>
      ${flip ? `<span>to flip: ${escapeHtml(flip)}</span>` : ""}
    </div>
  </div>
</div>`;
}

/** The sticky rail: section index, the state legend, and the keys. */
export function renderRail(model: ReportModel) {
  const entries = [
    [
      "ship",
      "Can we ship?",
      `${model.blockers.length} blocker${model.blockers.length === 1 ? "" : "s"}`,
    ],
    [
      "changed",
      "What changed",
      String(
        items(model.since.newRed).length + items(model.since.newGreen).length
      ),
    ],
    ["owes", "Who owes what", String(model.attention.length)],
    ["lanes", "Lane health", String(model.lanes.length)],
    [
      "journeys",
      "Journeys",
      String(
        model.journeys.reduce(
          (total, suite) => total + items(suite.flows).length,
          0
        )
      ),
    ],
    [
      "product",
      "Product coverage",
      `${items(model.coverage.rows).length} × ${items(model.coverage.platforms).length}`,
    ],
    [
      "promises",
      "Promises × surfaces",
      `${items(model.promises.qualities).length} × ${items(model.promises.surfaces).length}`,
    ],
    ["adversaries", "Adversaries", "3"],
    ["trends", "Trends", String(model.trends.length)],
    ["evidence", "Evidence", "6"],
    ["read", "How to read this", ""],
  ];
  return `<aside class="rail">
  <nav aria-label="Sections"><ol>${entries
    .map(
      ([id, label, count]) =>
        `<li><a href="#${id}">${escapeHtml(label)}${count ? `<span class="cnt">${escapeHtml(count)}</span>` : ""}</a></li>`
    )
    .join("")}</ol></nav>
  <div class="box">
    <h3>States</h3>
    <div class="legend">
      <span class="dot d-ok"></span><span>passed</span>
      <span class="dot d-bad"></span><span>failed — new, owned, aging</span>
      <span class="dot d-park"></span><span>parked — known, expiring, not counted</span>
      <span class="dot"></span><span>no evidence — lane did not report</span>
      <span class="dot d-attn"></span><span>degraded — over budget or outside band</span>
    </div>
  </div>
  <div class="box">
    <h3>Keys</h3>
    <div class="legend"><kbd>/</kbd><span>filter lanes</span><kbd>e</kbd><span>expand all rows</span><kbd>?</kbd><span>this list</span></div>
  </div>
</aside>`;
}
