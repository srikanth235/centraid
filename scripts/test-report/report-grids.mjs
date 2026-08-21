/**
 * Grid E (join laws + simulation), grid F (the adversary panel) and grid G
 * (journeys with budget vs actual), plus the consent ledger's rows
 * (#839 Wave 5, gaps G13/G15/G16).
 *
 * The governing rule for all four, and the reason none of them takes a list of
 * lanes as an argument: **every row is derived**. Grid E derives from
 * `matrix.joinLaws`, grid G from `matrix.journeys`, both locked to the suites
 * and runners they name by `validate-report-registries.mjs`. Grid F derives
 * from the mutation seed catalog, the fuzz corpus on disk, the fuzz findings
 * register, and `matrix.engineRegistry`. The consent ledger derives from
 * `matrix.consentLedger`. A lane that dies loses its evidence, not its row —
 * it renders grey, which is gap G15's entire point.
 *
 * Pure over plain data; the caller does the I/O and passes the results in.
 */

/**
 * Look one evidence result up by owner path.
 * @typedef {(owner: string) => ({status: string, duration?: number, lastAt?: string|null} | undefined)} EvidenceLookup
 */

/** Evidence state for an owner, honest about the difference between kinds. */
function stateFor(owner, lookup) {
  const result = owner ? lookup(owner) : undefined;
  return {
    state: result?.status ?? "missing",
    duration: Number.isFinite(result?.duration) ? result.duration : null,
    lastAt: result?.lastAt ?? null,
  };
}

/**
 * Grid E — every join law and every simulation law, with tonight's evidence.
 *
 * Rows come from `matrix.joinLaws` and nowhere else. The `kind` split is the
 * grid's two halves: scripted laws assert a named outcome, simulation laws
 * assert that seeded interleavings converge. Both render a state; neither can
 * disappear, because the validator pins the row list to the owning suites'
 * own test declarations.
 *
 * @param {object} matrix Parsed test matrix.
 * @param {EvidenceLookup} lookup Evidence by owner path.
 * @returns {{rows: object[], counts: object}} Grid E.
 */
export function buildJoinGrid(matrix, lookup) {
  const rows = (matrix.joinLaws ?? []).map((law) => ({
    id: law.id,
    label: law.label,
    kind: law.kind,
    lane: law.lane,
    owner: law.owner,
    statement: law.statement,
    seats: [...(law.seats ?? [])],
    flow: law.flow ?? null,
    ...stateFor(law.owner, lookup),
  }));
  return {
    rows,
    counts: {
      scripted: rows.filter((row) => row.kind === "scripted").length,
      simulation: rows.filter((row) => row.kind === "simulation").length,
      passed: rows.filter((row) => row.state === "passed").length,
      failed: rows.filter((row) => row.state === "failed").length,
    },
  };
}

/**
 * Grid G — every mobile journey, grouped by the suite that budgets it.
 *
 * `budgetMinutes` is the suite's aggregate ceiling as its runner enforces it;
 * `actualMs` is what the lane measured tonight, or null. A suite with no
 * runner has no aggregate budget and says so — that is a real, visible gap in
 * the roster, not a formatting choice, and hiding it behind a blank cell is
 * exactly the archive behaviour v2 replaces.
 *
 * @param {object} matrix Parsed test matrix.
 * @param {EvidenceLookup} lookup Evidence by owner path.
 * @returns {{suites: object[], counts: object}} Grid G.
 */
export function buildJourneyGrid(matrix, lookup) {
  const suites = (matrix.journeys?.suites ?? []).map((suite) => {
    const rows = (suite.flows ?? []).map((entry) => ({
      id: entry.id,
      label: entry.label,
      owner: entry.owner,
      flow: entry.flow ?? null,
      ...stateFor(entry.owner, lookup),
    }));
    const measured = rows
      .map((row) => row.duration)
      .filter((value) => Number.isFinite(value));
    return {
      id: suite.id,
      label: suite.label,
      runner: suite.runner ?? null,
      budgetDoc: suite.budgetDoc ?? null,
      budgetMinutes: suite.budgetMinutes ?? null,
      budgetMs:
        suite.budgetMinutes == null ? null : suite.budgetMinutes * 60_000,
      // Aggregate actual is only meaningful when EVERY journey in the suite
      // reported; a partial sum read against the whole suite's ceiling would
      // flatter a run in which half the lane never started.
      actualMs:
        measured.length && measured.length === rows.length
          ? measured.reduce((sum, value) => sum + value, 0)
          : null,
      rows,
    };
  });
  const allRows = suites.flatMap((suite) => suite.rows);
  return {
    suites,
    counts: {
      journeys: allRows.length,
      passed: allRows.filter((row) => row.state === "passed").length,
      missing: allRows.filter((row) => row.state === "missing").length,
      unbudgeted: suites
        .filter((suite) => suite.budgetMinutes == null)
        .reduce((sum, suite) => sum + suite.rows.length, 0),
    },
  };
}

/**
 * Grid F — the adversary panel: the three ways this repo attacks itself, on
 * one surface instead of scattered across six sections.
 *
 * - **mutation** attacks the tests (seed catalog × `tests/mutation-floors.json`)
 * - **fuzz** attacks the code (corpus on disk × the findings register)
 * - **properties** attack the orderings (`matrix.engineRegistry#propertyFlow`)
 *
 * Sparklines: `historySeries` supplies whatever the durable history actually
 * holds for a key. A row with fewer than two points gets `sparkline: null` and
 * the renderer draws an empty slot that fills as nights accrue. Fabricating a
 * flat line from one point would be inventing history, which is the one thing
 * a trust-worthiness panel may never do.
 *
 * @param {object} input The three adversary catalogs plus tonight's evidence.
 * @param {object[]} input.mutationSeeds The `scripts/mutation/seeds.mjs` catalog.
 * @param {object} input.mutationFloors Parsed `tests/mutation-floors.json`.
 * @param {object[]} input.mutationRows Report mutation rows (`scope`/`score`).
 * @param {object[]} input.fuzzTargets `{id, title, entry}` per fuzz target.
 * @param {object} input.fuzzCorpus `{[targetId]: {seeds, crashers}}` counts.
 * @param {object|null} input.knownFindings Parsed fuzz findings register.
 * @param {object[]} input.engineRegistry `matrix.engineRegistry`.
 * @param {object[]} input.flows `matrix.flows`.
 * @param {EvidenceLookup} input.lookup Evidence by owner path.
 * @param {(key: string) => number[]} input.historySeries Durable series reader.
 * @returns {object} Grid F.
 */
export function buildAdversaryPanel({
  mutationSeeds = [],
  mutationFloors = {},
  mutationRows = [],
  fuzzTargets = [],
  fuzzCorpus = {},
  knownFindings = null,
  engineRegistry = [],
  flows = [],
  lookup,
  historySeries = () => [],
}) {
  const scoreByScope = new Map(
    mutationRows.map((row) => [row.scope, row.score])
  );
  // A finding class is keyed by the invariant, not by the target — `wal-keys`
  // raises `wal.closer-roundtrip-rejected` — so the target is read off the
  // committed crasher's own path (`.../crashers/<target>/<class>.json`), which
  // is the file the replay suite pins. Falling back to a class-name prefix
  // keeps a finding visible if its crasher path is ever reshaped.
  const findingsByTarget = new Map();
  const targetIds = fuzzTargets.map((target) => target.id);
  for (const [id, finding] of Object.entries(knownFindings?.classes ?? {})) {
    const target =
      targetIds.find((candidate) =>
        String(finding.found ?? "").includes(`/${candidate}/`)
      ) ?? targetIds.find((candidate) => id.startsWith(`${candidate}.`));
    if (!target) continue;
    if (!findingsByTarget.has(target)) findingsByTarget.set(target, []);
    findingsByTarget.get(target).push({ id, ...finding });
  }
  const series = (key) => {
    const values = (historySeries(key) ?? []).filter((value) =>
      Number.isFinite(value)
    );
    return values.length >= 2 ? values : null;
  };

  const mutation = mutationSeeds.map((seed) => {
    const score = scoreByScope.get(seed.id) ?? null;
    const floor = Number.isFinite(mutationFloors[seed.id])
      ? mutationFloors[seed.id]
      : null;
    return {
      id: seed.id,
      label: seed.label,
      floor,
      score: Number.isFinite(score) ? score : null,
      state:
        !Number.isFinite(score) || floor == null
          ? "missing"
          : score >= floor
            ? "passed"
            : "failed",
      sparkline: series(`mutation:${seed.id}`),
    };
  });

  const fuzz = fuzzTargets.map((target) => {
    const findings = findingsByTarget.get(target.id) ?? [];
    const corpus = fuzzCorpus[target.id] ?? { seeds: 0, crashers: 0 };
    return {
      id: target.id,
      label: target.title ?? target.id,
      entry: target.entry ?? null,
      seeds: corpus.seeds ?? 0,
      crashers: corpus.crashers ?? 0,
      findings: findings.map((finding) => ({
        id: finding.id,
        issue: finding.issue ?? null,
        status: finding.status ?? "open",
      })),
      // A pinned finding is not a red lane — the register exists so a known,
      // reproduced divergence is REPORTED without failing the night. It is
      // amber: something true and unresolved, not something newly broken.
      state: findings.length ? "pinned" : corpus.seeds ? "passed" : "missing",
    };
  });

  const flowsById = new Map(flows.map((flow) => [flow.id, flow]));
  const properties = engineRegistry.map((engine) => {
    const flow = engine.propertyFlow
      ? flowsById.get(engine.propertyFlow)
      : undefined;
    return {
      id: engine.id,
      label: engine.label,
      flow: engine.propertyFlow ?? null,
      owner: flow?.owner ?? null,
      mutationSeed: engine.mutationSeed ?? null,
      // No property flow is a genuine hole in the adversary stack, and the
      // panel names it rather than skipping the engine's row.
      ...(engine.propertyFlow
        ? stateFor(flow?.owner, lookup)
        : { state: "unowned", duration: null, lastAt: null }),
    };
  });

  return {
    mutation,
    fuzz,
    properties,
    counts: {
      mutationSeeds: mutation.length,
      mutationBelowFloor: mutation.filter((row) => row.state === "failed")
        .length,
      fuzzTargets: fuzz.length,
      fuzzCorpusSeeds: fuzz.reduce((sum, row) => sum + row.seeds, 0),
      fuzzCrashers: fuzz.reduce((sum, row) => sum + row.crashers, 0),
      pinnedFindings: fuzz.reduce((sum, row) => sum + row.findings.length, 0),
      propertyFlows: properties.filter((row) => row.flow).length,
      enginesWithoutProperty: properties.filter((row) => !row.flow).length,
    },
  };
}

/**
 * The consent ledger — one row per permission layer, as `matrix.consentLedger`
 * declares it, with tonight's state for the adversary that attacks it.
 *
 * Gap G16 is "eight permission layers, no single view": the enforcement points
 * exist and each has a suite, but nobody could see the stack at once, so
 * nobody could see which layer's adversary was silent. This is that view.
 *
 * @param {object} matrix Parsed test matrix.
 * @param {EvidenceLookup} lookup Evidence by owner path.
 * @returns {{rows: object[], seats: object[], counts: object}} The ledger.
 */
export function buildConsentLedger(matrix, lookup) {
  const seats = matrix.seats ?? [];
  const rows = (matrix.consentLedger ?? []).map((layer) => {
    const covered = new Set(layer.seats);
    return {
      id: layer.id,
      label: layer.label,
      enforcement: [...(layer.enforcement ?? [])],
      refusalGrammar: layer.refusalGrammar,
      adversaryOwner: layer.adversary?.owner ?? null,
      adversaryFlow: layer.adversary?.flow ?? null,
      note: layer.note,
      seatCoverage: seats.map((seat) => ({
        id: seat.id,
        label: seat.label,
        covered: covered.has(seat.id),
      })),
      ...(layer.adversary?.owner
        ? stateFor(layer.adversary.owner, lookup)
        : { state: "unowned", duration: null, lastAt: null }),
    };
  });
  return {
    rows,
    seats,
    counts: {
      layers: rows.length,
      withoutAdversary: rows.filter((row) => !row.adversaryOwner).length,
      fullSeatCoverage: rows.filter((row) =>
        row.seatCoverage.every((seat) => seat.covered)
      ).length,
    },
  };
}
