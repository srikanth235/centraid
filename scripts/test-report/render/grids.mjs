import { escapeHtml, section } from "./util.mjs";

const STATE_LETTERS = Object.freeze({
  dayone: "d",
  pending: "p",
  offline: "o",
  stale: "s",
  conflict: "c",
  parked: "k",
  denied: "n",
});

export function renderCoverage(model) {
  const { platforms, rows } = model.coverage;
  const header = `<div class="h">app</div>${platforms.map((column) => `<div class="h">${escapeHtml(column.label)}</div>`).join("")}`;

  const rungBody = rows
    .map((row) => {
      const cells = row.cells
        .map((cell) => {
          if (cell.na) {
            return `<div class="cell na"><span class="rung">n/a</span><span class="small">${escapeHtml(cell.note ?? "")}</span></div>`;
          }
          const state = cell.rung === 0 ? "failed" : "passed";
          const label = cell.rung === 0 ? "gap" : `rung ${cell.rung}`;
          return `<div class="cell ${state}"><span class="rung">${label}</span>${cell.note ? `<span class="ln">${escapeHtml(cell.note)}</span>` : ""}</div>`;
        })
        .join("");
      return `<div class="app">${escapeHtml(row.app)}</div>${cells}`;
    })
    .join("");

  const stateBody = rows
    .map((row) => {
      const owned = row.states.filter((state) => state.owned).length;
      const boxes = row.states
        .map(
          (state) =>
            `<span class="st-box${state.owned ? " on" : ""}" title="${escapeHtml(state.state)}">${escapeHtml(STATE_LETTERS[state.state] ?? state.state.slice(0, 1))}</span>`
        )
        .join("");
      return `<div class="app">${escapeHtml(row.app)}</div><div class="cell passed" style="grid-column:2 / -1"><span class="rung">${owned} / ${row.states.length}</span><span class="states">${boxes}</span></div>`;
    })
    .join("");

  const verbBody = rows
    .map((row) => {
      const chips = ["create", "read", "update", "delete", "share"]
        .map(
          (verb) =>
            `<span class="verb${row.verbs[verb] === 0 ? " zero" : ""}"><b>${verb[0].toUpperCase()}</b> ${row.verbs[verb]}</span>`
        )
        .join("");
      return `<div class="app">${escapeHtml(row.app)}</div><div class="cell passed" style="grid-column:2 / -1"><span class="verbs">${chips}</span></div>`;
    })
    .join("");

  const foot = `<div class="foot">rung 2 = the Linux integration suite and screen tests · rung 3 = a device journey on every candidate · rung 4 = the depth journey tonight · <b>gap</b> = a seat with no passing journey at any rung · n/a cells carry their reason in the claims file. Letters: d day one · p pending · o offline · s stale · c conflict · k parked · n denied.</div>`;

  const body = `<div class="chips" role="group" aria-label="Grid mode">
  <button type="button" class="chip" id="modeRung" data-mode="rung" aria-pressed="true">rung proven</button>
  <button type="button" class="chip" id="modeStates" data-mode="states" aria-pressed="false">designed states (d p o s c k n)</button>
  <button type="button" class="chip" id="modeVerbs" data-mode="verbs" aria-pressed="false">scenarios by verb (create · read · update · delete · share)</button>
</div>
<div class="pgrid" id="pgrid-rung" data-grid="rung">${header}${rungBody}${foot}</div>
<div class="pgrid" id="pgrid-states" data-grid="states" hidden>${header}${stateBody}${foot}</div>
<div class="pgrid" id="pgrid-verbs" data-grid="verbs" hidden>${header}${verbBody}${foot}</div>`;

  return section(
    "product",
    "What the product is proven to do",
    "Coverage",
    "app × platform, highest rung that proved it",
    "Derived from the roster and the Linux integration suite, never typed by hand. A cell shows the deepest rung with a passing journey tonight; toggle to see the designed states the app owns, or the verbs its scenarios cover.",
    body
  );
}

export function renderPromises(model) {
  const { qualities, surfaces, cells, counts } = model.promises;
  const header = `<div class="h"></div>${surfaces.map((surface) => `<div class="h">${escapeHtml(surface.label)}</div>`).join("")}`;
  const body = qualities
    .map((quality, row) => {
      const line = cells[row]
        .map((cell) => {
          const word =
            cell.state === "no-evidence" ? "no evidence" : cell.state;
          const title = `${quality.label}: ${word}${cell.lanes.length > 0 ? ` · ${cell.lanes.join(", ")}` : cell.reason ? ` · ${cell.reason}` : ""}`;
          const cls = cell.state === "n/a" ? "na" : cell.state;
          return `<div class="cell ${cls}" title="${escapeHtml(title)}"><span class="st">${escapeHtml(word)}</span>${
            cell.lanes.length > 0
              ? `<span class="ln">${escapeHtml(cell.lanes[0])}</span>`
              : ""
          }</div>`;
        })
        .join("");
      return `<div class="qn">${escapeHtml(quality.label)}</div>${line}`;
    })
    .join("");
  const foot = `<div class="foot">${counts.passed} passed · <b>${counts.failed} failed</b> · ${counts.parked} parked · <b>${counts["no-evidence"]} no evidence</b> · ${counts["n/a"]} n/a with a reason in the claims file</div>`;

  return section(
    "promises",
    "Which promise has evidence on which surface",
    "Promises × surfaces",
    "the infrastructure grid, derived from lane tags",
    "Every lane declares the qualities it falsifies and the surfaces it runs against; this grid is the join of those declarations with tonight's verdicts. Four states plus n/a. Hover a cell for the lanes behind it. A cell with no lane is no evidence, never blank — absence stays visible.",
    `<div class="heatwrap"><div class="heat" id="heat">${header}${body}${foot}</div></div>`
  );
}
