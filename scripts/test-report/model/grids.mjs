export const PLATFORM_COLUMNS = Object.freeze([
  { id: "ios", label: "iOS", seat: "origin" },
  { id: "android", label: "Android", seat: "origin" },
  { id: "web", label: "Web", seat: "viewer" },
  { id: "desktop", label: "Desktop", seat: "custodian" },
]);

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

export function scenarioVerb(scenario) {
  const haystack = `${scenario.id ?? ""} ${scenario.label ?? ""}`.toLowerCase();
  for (const [verb, words] of Object.entries(VERB_WORDS)) {
    if (words.some((word) => haystack.includes(word))) return verb;
  }
  return "read";
}

export function buildCoverageGrid({ claims, derived, evidence }) {
  const journeys = derived.journeys ?? [];
  const passingFlows = new Map(); // flowId -> deepest rung proven tonight
  for (const suite of journeys) {
    const laneVerdict = [...evidence.values()].find((entry) =>
      (entry.cases ?? []).some((row) =>
        suite.flows.some((flow) => flow.id === row.id)
      )
    );
    for (const flow of suite.flows) {
      const observed = laneVerdict?.cases?.find((row) => row.id === flow.id);
      if (observed && observed.verdict !== "passed") continue;
      const key = `${suite.platform}:${flow.id}`;
      passingFlows.set(key, Math.max(passingFlows.get(key) ?? 0, suite.rung));
    }
  }

  const apps = (claims.appSeats?.apps ?? []).map((app) => app.id);
  const stateApps = new Map(
    (claims.appStates?.apps ?? []).map((app) => [app.id, app.states ?? {}])
  );
  const scenarioApps = new Map(
    (claims.appScenarios?.apps ?? []).map((app) => [
      app.id,
      app.scenarios ?? [],
    ])
  );
  const seatOf = new Map(
    (claims.appSeats?.apps ?? []).map((app) => [app.id, app.seats ?? {}])
  );

  const rows = apps.map((app) => {
    const cells = PLATFORM_COLUMNS.map((column) => {
      const naKey = `appSeats.${app}.${column.seat}`;
      const na = claims.naCells?.[naKey];
      if (na)
        return { platform: column.id, rung: null, na: true, note: na.restated };
      const proven = [...passingFlows.entries()]
        .filter(([key]) => key.startsWith(`${column.id}:`) && key.includes(app))
        .reduce((deepest, [, rung]) => Math.max(deepest, rung), 0);
      const seat = seatOf.get(app)?.[column.seat];
      const fallback = seat?.status === "owned" ? 2 : 0;
      return {
        platform: column.id,
        rung: Math.max(proven, fallback) || 0,
        na: false,
        note: seat?.owner ?? null,
      };
    });

    const states = Object.entries(stateApps.get(app) ?? {}).map(
      ([state, cell]) => ({
        state,
        owned: cell.status === "owned",
        owner: cell.owner ?? null,
      })
    );

    const verbs = { create: 0, read: 0, update: 0, delete: 0, share: 0 };
    for (const scenario of scenarioApps.get(app) ?? []) {
      if (scenario.status !== "owned") continue;
      verbs[scenarioVerb(scenario)] += 1;
    }

    return {
      app,
      cells,
      states,
      verbs,
      doc:
        claims.appScenarios?.apps?.find((entry) => entry.id === app)?.doc ??
        null,
    };
  });

  return {
    platforms: PLATFORM_COLUMNS,
    states: (claims.appStates?.states ?? []).map((s) => s.id),
    rows,
  };
}

export function buildPromises({ claims, evidence, laneRegistry }) {
  const qualities = claims.vocabulary?.qualities ?? [];
  const surfaces = claims.vocabulary?.surfaces ?? [];

  const naFor = (surface, quality) => {
    const absorbed = surface.absorbs ?? [];
    if (absorbed.length === 0) return null;
    const rows = absorbed.map(
      (old) => claims.naCells?.[`surface.${old}.${quality.id}`]
    );
    return rows.every(Boolean) ? rows[0] : null;
  };

  const cells = qualities.map((quality) =>
    surfaces.map((surface) => {
      const lanes = laneRegistry.filter(
        (lane) =>
          lane.qualities?.includes(quality.id) &&
          lane.surfaces?.includes(surface.id)
      );
      if (lanes.length === 0) {
        const na = naFor(surface, quality);
        return na
          ? { state: "n/a", lanes: [], reason: na.restated }
          : {
              state: "no-evidence",
              lanes: [],
              reason: "no lane declares this promise on this surface",
            };
      }
      const verdicts = lanes.map(
        (lane) => evidence.get(lane.id)?.verdict ?? "no-evidence"
      );
      const state = verdicts.includes("failed")
        ? "failed"
        : verdicts.some((word) => word === "passed")
          ? "passed"
          : verdicts.includes("parked")
            ? "parked"
            : "no-evidence";
      return { state, lanes: lanes.map((lane) => lane.id), reason: null };
    })
  );

  const counts = {
    passed: 0,
    failed: 0,
    parked: 0,
    "no-evidence": 0,
    "n/a": 0,
  };
  for (const row of cells) for (const cell of row) counts[cell.state] += 1;

  return { qualities, surfaces, cells, counts };
}
