import { bags, dict, items } from "../record.ts";
import type { Loose } from "../record.ts";

/**
 * The two grids (#915 Wave 3, §6 coverage and §7 promises × surfaces).
 *
 * Neither is typed by hand any more. §6 is the deepest rung with a passing
 * journey per app × platform, plus the designed states each app owns and the
 * verbs its scenarios cover. §7 is the join of every lane's declared
 * `tags.qualities × tags.surfaces` with tonight's verdicts — so a promise has
 * evidence on a surface exactly when some lane says it does and then reports.
 *
 * Absence stays visible: a cell with no lane is `no evidence`, never blank,
 * unless the claims file declares it n/a with a reason.
 */

/** The four platform columns of §6, and the seat each one is proven through. */
export const PLATFORM_COLUMNS = Object.freeze([
  { id: "ios", label: "iOS", seat: "origin" },
  { id: "android", label: "Android", seat: "origin" },
  { id: "web", label: "Web", seat: "viewer" },
  { id: "desktop", label: "Desktop", seat: "custodian" },
]);

/**
 * The verb a scenario exercises, read off its id and label.
 *
 * The scenario register carries a layer and a status but no verb, and typing
 * one per scenario would be exactly the hand-maintained axis #915 exists to
 * remove. The words below are the vocabulary the register already uses; a
 * scenario matching none of them counts under `read`, which is the verb every
 * journey performs on the way to any other.
 */
export const VERB_WORDS = Object.freeze({
  create: [
    "create",
    "new",
    "add",
    "capture",
    "import",
    "seed",
    "compose",
    "invite",
  ],
  update: [
    "update",
    "edit",
    "rename",
    "move",
    "reorder",
    "resolve",
    "merge",
    "promote",
    "toggle",
  ],
  delete: ["delete", "remove", "purge", "evict", "revoke", "clear"],
  share: ["share", "sharing", "grant", "publish", "export", "reach", "receipt"],
});

/** Which verb a scenario counts under. */
export function scenarioVerb(scenario: Loose) {
  const haystack = `${scenario.id ?? ""} ${scenario.label ?? ""}`.toLowerCase();
  for (const [verb, words] of Object.entries(VERB_WORDS)) {
    if (words.some((word) => haystack.includes(word))) return verb;
  }
  return "read";
}

/**
 * §6 — app × platform, three modes.
 * @param {{claims: Loose, derived: Loose, evidence: Map<string, Loose>}} input the claims file, the derived views and tonight's evidence
 */
export function buildCoverageGrid({
  claims,
  derived,
  evidence,
}: {
  claims: unknown;
  derived: unknown;
  evidence: Map<string, unknown>;
}) {
  const claimDoc = dict(claims);
  const journeys = bags(dict(derived).journeys);
  const passingFlows = new Map<string, number>();
  for (const suite of journeys) {
    const flows = bags(suite.flows);
    const laneVerdict = [...evidence.values()].find((entry) =>
      bags(dict(entry).cases).some((row) =>
        flows.some((flow) => flow.id === row.id)
      )
    );
    for (const flow of flows) {
      const observed = bags(dict(laneVerdict).cases).find(
        (row) => row.id === flow.id
      );
      if (observed && observed.verdict !== "passed") continue;
      const key = `${suite.platform}:${flow.id}`;
      passingFlows.set(
        key,
        Math.max(passingFlows.get(key) ?? 0, Number(suite.rung ?? 0))
      );
    }
  }

  const seatApps = bags(dict(claimDoc.appSeats).apps);
  const apps = seatApps.map((app) => app.id);
  const stateApps = new Map(
    bags(dict(claimDoc.appStates).apps).map((app) => [app.id, dict(app.states)])
  );
  const scenarioApps = new Map(
    bags(dict(claimDoc.appScenarios).apps).map((app) => [
      app.id,
      bags(app.scenarios),
    ])
  );
  const seatOf = new Map(seatApps.map((app) => [app.id, dict(app.seats)]));
  const naCells = dict(claimDoc.naCells);

  const rows = apps.map((app) => {
    const cells = PLATFORM_COLUMNS.map((column) => {
      const naKey = `appSeats.${app}.${column.seat}`;
      const na = dict(naCells[naKey]);
      if (naCells[naKey])
        return { platform: column.id, rung: null, na: true, note: na.restated };
      const proven = [...passingFlows.entries()]
        .filter(
          ([key]) =>
            key.startsWith(`${column.id}:`) && key.includes(String(app))
        )
        .reduce((deepest, [, rung]) => Math.max(deepest, rung), 0);
      const seat = dict(seatOf.get(app)?.[column.seat]);
      const fallback = seat.status === "owned" ? 2 : 0;
      return {
        platform: column.id,
        rung: Math.max(proven, fallback) || 0,
        na: false,
        note: seat.owner ?? null,
      };
    });

    const states = Object.entries(stateApps.get(app) ?? {}).map(
      ([state, cell]) => {
        const row = dict(cell);
        return {
          state,
          owned: row.status === "owned",
          owner: row.owner ?? null,
        };
      }
    );

    const verbs: Record<string, number> = {
      create: 0,
      read: 0,
      update: 0,
      delete: 0,
      share: 0,
    };
    for (const scenario of scenarioApps.get(app) ?? []) {
      if (scenario.status !== "owned") continue;
      const verb = scenarioVerb(scenario);
      verbs[verb] = (verbs[verb] ?? 0) + 1;
    }

    return {
      app,
      cells,
      states,
      verbs,
      doc:
        bags(dict(claimDoc.appScenarios).apps).find((entry) => entry.id === app)
          ?.doc ?? null,
    };
  });

  return {
    platforms: PLATFORM_COLUMNS,
    states: bags(dict(claimDoc.appStates).states).map((s) => s.id),
    rows,
  };
}

/**
 * §7 — 11 qualities × 10 surfaces, as the join of lane tags with verdicts.
 * @param {{claims: Loose, evidence: Map<string, Loose>, laneRegistry: Loose[]}} input the claims file, the derived views and tonight's evidence
 */
export function buildPromises({
  claims,
  evidence,
  laneRegistry,
}: {
  claims: unknown;
  evidence: Map<string, unknown>;
  laneRegistry: unknown[];
}) {
  const claimDoc = dict(claims);
  const vocabulary = dict(claimDoc.vocabulary);
  const qualities = bags(vocabulary.qualities);
  const surfaces = bags(vocabulary.surfaces);
  const naCells = dict(claimDoc.naCells);
  const lanes = bags(laneRegistry);

  // The n/a register is still keyed by the fifteen matrix surfaces; each new
  // surface absorbs several of them, so a cell is n/a only when EVERY absorbed
  // surface declared it n/a and no lane claims it.
  const naFor = (surface: Loose, quality: Loose) => {
    const absorbed = items(surface.absorbs);
    if (absorbed.length === 0) return null;
    const rows = absorbed.map((old) => naCells[`surface.${old}.${quality.id}`]);
    return rows.every(Boolean) ? dict(rows[0]) : null;
  };

  const cells = qualities.map((quality) =>
    surfaces.map((surface) => {
      const matching = lanes.filter(
        (lane) =>
          items(lane.qualities).includes(quality.id) &&
          items(lane.surfaces).includes(surface.id)
      );
      if (matching.length === 0) {
        const na = naFor(surface, quality);
        return na
          ? { state: "n/a", lanes: [], reason: na.restated }
          : {
              state: "no-evidence",
              lanes: [],
              reason: "no lane declares this promise on this surface",
            };
      }
      const verdicts = matching.map(
        (lane) => dict(evidence.get(String(lane.id))).verdict ?? "no-evidence"
      );
      const state = verdicts.includes("failed")
        ? "failed"
        : verdicts.some((word) => word === "passed")
          ? "passed"
          : verdicts.includes("parked")
            ? "parked"
            : "no-evidence";
      return { state, lanes: matching.map((lane) => lane.id), reason: null };
    })
  );

  const counts: Record<string, number> = {
    passed: 0,
    failed: 0,
    parked: 0,
    "no-evidence": 0,
    "n/a": 0,
  };
  for (const row of cells)
    for (const cell of row) counts[cell.state] = (counts[cell.state] ?? 0) + 1;

  return { qualities, surfaces, cells, counts };
}
