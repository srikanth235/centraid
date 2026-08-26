/**
 * Per-app scenario ledger (#864 Wave 7, M17).
 *
 * Rows come from `tests/matrix.json#appScenarios` and nowhere else. Each
 * scenario names exactly one cheapest falsifying layer (U / C / E) and a
 * declaration: owned, gap, product-bug, held, or skip. These cells are
 * DECLARATIONS, not tonight's evidence — an owned row is never green, a gap
 * is the same plum "no owner" as §2/§3/§8, and a product-bug is its own
 * indigo family so a known defect cannot be mistaken for a missing test.
 *
 * The grid is total: every bundled app has a block, every scenario paints
 * three layer columns, and the two columns that are not the cheapest layer
 * are n/a. Nothing here may render as the absence greys (missing / stale /
 * no lane / named) — that is the zero-grey contract this ledger extends.
 */

export const SCENARIO_LAYERS = [
  { id: "unit", label: "U" },
  { id: "component", label: "C" },
  { id: "journey", label: "E" },
];

const LAYER_IDS = new Set(SCENARIO_LAYERS.map((layer) => layer.id));

/** Map a ledger status onto the axis cell register. */
function declarationOf(scenario, trackingIssue) {
  const issue = scenario.trackingIssue ?? trackingIssue;
  if (scenario.status === "owned") {
    return {
      state: "declared",
      detail: scenario.owner,
      badge: scenario.layer,
    };
  }
  if (scenario.status === "product-bug") {
    return {
      state: "bug",
      detail: scenario.note ?? `product bug — tracked by #${issue ?? "?"}`,
      badge: `#${issue ?? "?"}`,
    };
  }
  if (scenario.status === "held" || scenario.status === "skip") {
    return {
      state: "skipped",
      detail: `${scenario.reason ?? "held or excluded"} (${scenario.citation ?? ""})`,
      badge: scenario.citation,
    };
  }
  return {
    state: "unowned",
    detail: `no owner yet — tracked by #${issue ?? "?"}`,
    badge: `#${issue ?? "?"}`,
  };
}

/**
 * Build the per-app scenario grids from the matrix block.
 * @param {object} manifest Parsed test matrix.
 * @returns {{layers: object[], apps: object[], trackingIssue: string|undefined}} Per-app grids ready to render.
 */
export function buildAppScenarioGrid(manifest) {
  const trackingIssue = manifest.appScenarios?.trackingIssue;
  const layers = SCENARIO_LAYERS;
  return {
    layers,
    trackingIssue,
    apps: (manifest.appScenarios?.apps ?? []).map((app) => ({
      id: app.id,
      doc: app.doc,
      rows: (app.scenarios ?? []).map((scenario) => {
        const declared = declarationOf(scenario, trackingIssue);
        return {
          id: scenario.id,
          label: scenario.label,
          layer: scenario.layer,
          status: scenario.status,
          state: declared.state,
          detail: declared.detail,
          badge: declared.badge,
          cells: layers.map((column) => {
            if (column.id !== scenario.layer) {
              return {
                column: column.id,
                state: "skipped",
                detail: "not the cheapest falsifying layer",
              };
            }
            if (!LAYER_IDS.has(scenario.layer)) {
              return {
                column: column.id,
                state: "unowned",
                detail: `unknown layer ${scenario.layer}`,
              };
            }
            return {
              column: column.id,
              state: declared.state,
              detail: declared.detail,
              badge: declared.badge,
            };
          }),
        };
      }),
    })),
  };
}

/**
 * Count declaration cells by meaning. One count per scenario (the cheapest
 * layer), never per U/C/E column — n/a columns are structural, not skipped
 * product work.
 * @param {{apps: object[]}} grid Built scenario grid.
 * @returns {{owned: number, gap: number, bug: number, skipped: number}} Declaration counts by meaning.
 */
export function countScenarioCells(grid) {
  const counts = { owned: 0, gap: 0, bug: 0, skipped: 0 };
  for (const app of grid.apps ?? []) {
    for (const row of app.rows ?? []) {
      if (row.state === "declared") counts.owned += 1;
      else if (row.state === "bug") counts.bug += 1;
      else if (row.state === "skipped") counts.skipped += 1;
      else counts.gap += 1;
    }
  }
  return counts;
}

/**
 * True when every painted scenario cell is a declaration state — never an
 * absence grey. The nightly zero-grey contract this ledger extends.
 * @param {{apps: object[]}} grid Built scenario grid.
 * @returns {boolean} True when every painted cell is a declaration state.
 */
export function scenarioGridIsZeroGrey(grid) {
  const allowed = new Set(["declared", "unowned", "bug", "skipped"]);
  for (const app of grid.apps ?? []) {
    for (const row of app.rows ?? []) {
      for (const cell of row.cells ?? []) {
        if (!allowed.has(cell.state)) return false;
      }
    }
  }
  return true;
}

/**
 * Render one heat table per app.
 * @param {object} grid Built scenario grid.
 * @param {{ escapeHtml: (s: string) => string, axisWord: (s: string) => string }} helpers HTML helpers from the generator.
 * @returns {string} One heat table per app.
 */
export function renderAppScenarioGrids(grid, { escapeHtml, axisWord }) {
  const headers = (grid.layers ?? SCENARIO_LAYERS)
    .map((layer) => `<th scope="col">${escapeHtml(layer.label)}</th>`)
    .join("");
  return (grid.apps ?? [])
    .map((app) => {
      const rows = (app.rows ?? [])
        .map((row) => {
          const cells = (row.cells ?? [])
            .map((cell) => {
              const badge = cell.badge
                ? `<small>${escapeHtml(cell.badge)}</small>`
                : "";
              return `<td><button class="cell axis-${escapeHtml(cell.state)}" title="${escapeHtml(cell.detail ?? "")}" data-axis="${escapeHtml(`scenario · ${app.id} · ${row.id} · ${cell.column}`)}" data-axis-title="${escapeHtml(row.label)}" data-axis-detail="${escapeHtml(cell.detail ?? "")}" aria-label="${escapeHtml(`${app.id}, ${row.label}, ${cell.column}: ${axisWord(cell.state)} — ${cell.detail ?? ""}`)}">${axisWord(cell.state)}${badge}</button></td>`;
            })
            .join("");
          return `<tr><th scope="row">${escapeHtml(row.label)}</th>${cells}</tr>`;
        })
        .join("");
      return `<h3 class="scenario-app">${escapeHtml(app.id)}</h3><div class="gridwrap"><table class="heat"><thead><tr><th scope="col">Scenario</th>${headers}</tr></thead><tbody>${rows}</tbody></table></div>`;
    })
    .join("");
}
