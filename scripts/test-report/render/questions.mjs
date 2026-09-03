import {
  escapeHtml,
  issueLink,
  pill,
  section,
  sev,
  sha,
  table,
} from "./util.mjs";

export function renderBlockers(model) {
  const rows =
    model.blockers.length === 0
      ? `<tr><td colspan="8" class="small">No S1 or S2 red tonight. Anything lower sits in the attention queue below.</td></tr>`
      : model.blockers
          .map(
            (row) => `<tr>
  <td>${sev(row.severity)}</td>
  <td><span class="lane">${escapeHtml(row.lane)}${row.case ? ` · ${escapeHtml(row.case)}` : ""}</span></td>
  <td class="plat">${escapeHtml(row.platform)}</td>
  <td>${sha(row.firstRed)}</td>
  <td>${sha(row.lastGreen)}</td>
  <td class="owner${row.owner ? "" : " none"}">${row.owner ? escapeHtml(row.owner) : "unowned — claim"}</td>
  <td class="age ${row.overSla ? "over" : "ok"}">${row.ageHours}h / 24h</td>
  <td>${row.issue ? issueLink(row.issue, model.repoUrl) : escapeHtml(row.deadline)}</td>
</tr>`
          )
          .join("");
  return section(
    "ship",
    "Question one",
    "Blockers",
    "what is holding the candidate",
    "Only S1 and S2 appear here. Every row names the candidate it first failed on and the last candidate it passed on, so bisection has bounds before anyone opens a log.",
    table(
      [
        "Sev",
        "Lane · case",
        "Platform",
        "First red",
        "Last green",
        "Owner",
        "Age",
        "Issue",
      ],
      rows
    )
  );
}

function column(title, tone, entries, empty) {
  const items =
    entries.length === 0
      ? `<li class="empty">${escapeHtml(empty)}</li>`
      : entries
          .map(
            (entry) =>
              `<li><span class="lane">${escapeHtml(entry.lane)}</span><span class="why">${escapeHtml(entry.why)}</span></li>`
          )
          .join("");
  return `<div class="card col ${tone}"><h4>${escapeHtml(title)} <span class="n">${entries.length}</span></h4><ul>${items}</ul></div>`;
}

export function renderSinceYesterday(model) {
  const since = model.since;
  const body = `<div class="changes">
${column("New red", "red", since.newRed, "nothing went red")}
${column("New green", "green", since.newGreen, "nothing recovered")}
${column("Newly parked", "parkedcol", since.newlyParked, "nothing parked tonight")}
${column("Park expiring", "expiring", since.expiring, "no park expires within 7 days")}
${column("Outside noise band", "", since.outOfBand, "every series is inside its band")}
${column("Budget pressure", "", since.budgetPressure, "no lane is over 80 % of its budget")}
</div>`;
  const from = model.delta.previousCandidate
    ? `${model.delta.previousCandidate.slice(0, 9)} → `
    : "";
  const to = model.candidate?.sha
    ? model.candidate.sha.slice(0, 9)
    : "this run";
  return section(
    "changed",
    "Question two",
    "Since yesterday",
    `candidate ${from}${to}`,
    "Computed candidate-to-candidate, so every entry is a code change, not weather. Perf and scale deltas show only when they leave their 30-night noise band.",
    body
  );
}

export function renderAttention(model) {
  const rows =
    model.attention.length === 0
      ? `<tr><td colspan="8" class="small">Nothing is owed: every registered lane passed and wrote evidence.</td></tr>`
      : model.attention
          .map(
            (row) => `<tr>
  <td>${sev(row.severity)}</td>
  <td><span class="lane">${escapeHtml(row.lane)}</span>${row.why ? `<span class="desc">${escapeHtml(row.why)}</span>` : ""}</td>
  <td class="plat">${escapeHtml(row.platform)}</td>
  <td>${pill(row.state === "no evidence" ? "no-evidence" : row.state)}</td>
  <td class="owner${row.owner ? "" : " none"}">${row.owner ? escapeHtml(row.owner) : "unowned — claim"}</td>
  <td class="age ${row.ageHours > 24 ? "over" : "ok"}">${row.ageDays === null ? `${row.ageHours}h` : `${row.ageDays}d`}</td>
  <td class="mono">${escapeHtml(row.deadline ?? "—")}</td>
  <td>${issueLink(row.issue, model.repoUrl)}</td>
</tr>`
          )
          .join("");
  return section(
    "owes",
    "Question three",
    "Attention queue",
    "who owes what, oldest first",
    "One row per lane, never per cell. Age counts against a 24-hour SLA to owned, not to fixed. Parks and blocked-external entries carry their expiry or revisit trigger. iOS and Android are separate lanes, so they are always separate rows.",
    table(
      [
        "Sev",
        "Lane",
        "Platform",
        "State",
        "Owner",
        "Age",
        "Deadline",
        "Thread",
      ],
      rows
    )
  );
}
