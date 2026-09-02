/**
 * §10 evidence (collapsed) and §11 how to read this (#915 Wave 3).
 *
 * §10 is the old detail shelf plus the Consent and Joins tabs: everything here
 * is a ratchet or a registry, and it changes the verdict only when a floor is
 * breached — at which point the breach appears in §1 as a blocker.
 *
 * §11 is the page's own contract: every state, every severity, every column,
 * the mapping from the old report's tabs, and the `evidence.json` shape a lane
 * has to write.
 */

import {
  details,
  escapeHtml,
  issueLink,
  pill,
  section,
  table,
} from "./util.mjs";

/** The old report's tabs, and where each one now lives. */
export const TAB_MAP = Object.freeze([
  ["Attention", "§1 Blockers + §3 Attention queue"],
  ["Product", "§6 Coverage, rung-proven mode"],
  ["States", "§6 Coverage, designed-states mode"],
  ["Scenarios", "§6 Coverage, verb mode"],
  ["Consent", "§10 Evidence → Consent ledger"],
  ["Joins", "§10 Evidence → Join laws"],
  ["Journeys", "§5 Journeys"],
  ["Adversaries", "§8 Adversaries"],
  ["Infrastructure", "§7 Promises × surfaces"],
  ["Detail shelf", "§10 Evidence"],
]);

/** §10. */
export function renderEvidence(model) {
  const panels = model.evidencePanels;

  const floors = table(
    [
      "Scope",
      '<span class="num">Lines</span>',
      '<span class="num">Floor</span>',
      '<span class="num">Headroom</span>',
      "Ratchet candidate",
    ],
    (panels.coverageFloors ?? [])
      .map(
        (row) =>
          `<tr><td class="mono">${escapeHtml(row.scope)}</td><td class="num">${row.lines ?? "—"}</td><td class="num">${row.floor ?? "—"}</td><td class="num">${row.headroom ?? "—"}</td><td>${
            row.ratchetCandidate ? pill("degraded", row.ratchetCandidate) : ""
          }</td></tr>`
      )
      .join("") ||
      `<tr><td colspan="5" class="small">No coverage summary was published with this run.</td></tr>`
  );

  const consent = table(
    ["Layer", "Enforced at", "Adversary", "Seats", "Tonight"],
    (panels.consentLedger ?? [])
      .map(
        (layer) =>
          `<tr><td>${escapeHtml(layer.label)}</td><td class="mono">${escapeHtml((layer.enforcement ?? []).join(", "))}</td><td class="small">${escapeHtml(layer.adversary?.owner ?? "—")}</td><td>${(layer.seats ?? []).length} / 3</td><td>${pill(
            model.consentVerdicts?.[layer.id] ?? "no-evidence"
          )}</td></tr>`
      )
      .join("")
  );

  const joins = table(
    ["Law", "Kind", "Seats", '<span class="num">Cases</span>', "Tonight"],
    (panels.joinLaws ?? [])
      .map(
        (law) =>
          `<tr><td class="mono">${escapeHtml(law.id)}</td><td>${escapeHtml(law.kind)}</td><td>${(law.seats ?? []).length}</td><td class="num">${law.cases ?? "—"}</td><td>${pill(
            model.joinVerdicts?.[law.id] ?? "no-evidence"
          )}</td></tr>`
      )
      .join("")
  );

  const inventory = panels.inventory ?? {};
  const parks = table(
    ["Lane", "Parked", "Expires", "Issue", "Reason"],
    (panels.parks ?? [])
      .map(
        (park) =>
          `<tr><td class="mono">${escapeHtml(park.lane)}</td><td class="mono">${escapeHtml(park.since ?? "—")}</td><td class="mono">${escapeHtml(park.until)}</td><td>${issueLink(park.issue, model.repoUrl)}</td><td class="small">${escapeHtml(park.why ?? "")}</td></tr>`
      )
      .join("") ||
      `<tr><td colspan="5" class="small">No lane is parked tonight.</td></tr>`
  );

  const observations = (panels.fieldObservations ?? [])
    .map(
      (entry) =>
        `<li><b>${escapeHtml(entry.title ?? entry.text ?? "")}</b>${entry.detail ? ` ${escapeHtml(entry.detail)}` : ""}<span class="age">${
          Number.isFinite(entry.ageDays)
            ? `${entry.ageDays}d${entry.ageDays > 60 ? " · rung-5 red" : ""}`
            : ""
        }</span></li>`
    )
    .join("");

  const body = [
    details(
      "Coverage floors",
      `${(panels.coverageFloors ?? []).length} scopes · ${(panels.ratchetCandidates ?? []).length} sustained-headroom ratchet candidates`,
      floors
    ),
    details(
      "Consent ledger",
      `${(panels.consentLedger ?? []).length} layers`,
      `<p class="small">One row per place a permission is enforced. "Seats" is how many of the three seats the adversary was run against; anything under 3 / 3 is a claim only partly earned.</p>${consent}`
    ),
    details("Join laws", `${(panels.joinLaws ?? []).length} laws`, joins),
    details(
      "Inventory",
      `skips ${inventory.skips ?? "—"} · env-red ${inventory.envRed ?? "—"} · sleeps ${inventory.sleeps ?? "—"} · quarantined tests ${inventory.quarantine ?? "—"}`,
      `<p class="small">Every entry has an open issue and an expiry. Down-only.</p>`
    ),
    details("Parks", `${(panels.parks ?? []).length} lanes`, parks),
    details(
      "Field observations",
      `from QUALITY.md · ${(panels.fieldObservations ?? []).length} open`,
      `<p class="small">Things a lane noticed that no gate owns yet. Each entry ages until it becomes a law, a budget, or a closed issue; an observation older than 60 days is a rung-5 red.</p><ul class="obs">${observations || `<li class="small">No open field observations.</li>`}</ul>`
    ),
  ].join("\n");

  return section(
    "evidence",
    "For citation, not for reading",
    "Evidence",
    "the floors, adversaries, and ledgers behind the verdict",
    "Everything here is a ratchet or a registry. It changes the verdict only when a floor is breached, and a breach appears above as a blocker.",
    body
  );
}

/** §11. */
export function renderHowToRead(model) {
  const severity = model.severity ?? {};
  const gloss = [
    [
      "candidate",
      "A main SHA that passed the full rung-3 ladder. Tonight ran on it, not on the tip of main.",
    ],
    [
      "HOLD / DEGRADED / SHIPPABLE",
      "HOLD: an S1 or S2 red, more than 3 parks, or a park older than 30 days. DEGRADED: S3/S4 reds or an out-of-band series. SHIPPABLE: everything else. Parked and no-evidence lanes never count as red.",
    ],
    [
      "S1 – S4",
      Object.entries(severity)
        .map(([key, text]) => `${key} ${text}`)
        .join(" · "),
    ],
    [
      "parked",
      "Red for 3 consecutive candidates, given an expiry (≤ 14 d) and a rolling issue. Not counted in the verdict. Expiry makes it red again.",
    ],
    [
      "no evidence",
      "The lane did not write evidence.json for this candidate. A lane that claims cells and writes nothing renders no evidence in every cell it claims.",
    ],
    [
      "n/a",
      "A cell the claims file declares cannot arise, with the reason and the date it was last re-read.",
    ],
    [
      "age",
      "Hours since the first red on a candidate. The SLA is to owned, 24 h. Fixed or parked is a separate deadline shown in the queue.",
    ],
    [
      "first red / last green",
      "Candidate SHAs. The regression is in last-green..first-red.",
    ],
    [
      "noise band",
      "Trailing 30-night interquartile range of a series. Leaving it is a change; moving inside it is weather.",
    ],
    [
      "rung",
      "0 commit · 1 push · 2 merge · 3 candidate · 4 nightly · 5 weekly. A check belongs on a rung only if it sharpens that rung's question.",
    ],
    [
      "lane",
      "One GitHub job id. Matrix legs are <job> (<leg>). Lane identity is the job id, never a display name.",
    ],
    [
      "claim",
      "A row in tests/claims.json: what the product promises, who owns the proof, its severity, and the day it was last demonstrated red.",
    ],
  ];

  const map = table(
    ["Tab in the old report", "Where it lives now"],
    TAB_MAP.map(
      ([tab, home]) =>
        `<tr><td>${escapeHtml(tab)}</td><td>${escapeHtml(home)}</td></tr>`
    ).join("")
  );

  const contract = `{
  "schema": 1, "lane": "mobile-e2e-ios", "rung": 4, "platform": "ios",
  "candidate": "0a3258e3a", "startedAt": "…", "finishedAt": "…",
  "verdict": "failed",                  // passed | failed | parked | no-evidence
  "budgetMs": 3600000, "durationMs": 2498000,
  "cases": [{ "id": "locker-gate", "verdict": "failed", "durationMs": 184000, "attempts": 3 }],
  "parked": null,                       // { "until": "YYYY-MM-DD", "issue": 870 }
  "tags": { "qualities": ["journey"], "surfaces": ["mobile-native"] }
}`;

  const errors =
    model.validationErrors.length > 0
      ? `<div class="errors"><b>${model.validationErrors.length} validation error${model.validationErrors.length === 1 ? "" : "s"}</b><ul>${model.validationErrors
          .map((error) => `<li>${escapeHtml(error)}</li>`)
          .join("")}</ul></div>`
      : "";

  return `<section id="read">
  <div class="eyebrow">Reference</div>
  <h2>How to read this page</h2>
  <dl class="gloss">${gloss
    .map(
      ([term, meaning]) =>
        `<div><dt>${escapeHtml(term)}</dt><dd>${escapeHtml(meaning)}</dd></div>`
    )
    .join("")}</dl>
  <h3 style="margin-top:28px">Where the old report's tabs went</h3>
  ${map}
  <h3 style="margin-top:28px">Data contract</h3>
  <p class="small">Every lane on every rung writes one file; this page is a pure function of a directory of them plus the claims file.</p>
  <pre>${escapeHtml(contract)}</pre>
  ${errors}
</section>`;
}
