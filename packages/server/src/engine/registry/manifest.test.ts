import { describe, expect, it } from "vitest";

import {
  APP_MANIFEST_FILE,
  CANONICAL_DESIGNED_STATES,
  MANIFEST_VERSION,
  ManifestError,
  compileSchema,
  findAction,
  findQuery,
  parseManifest,
  validateManifest,
} from "./manifest.js";

const baseManifest = () => ({
  manifestVersion: MANIFEST_VERSION,
  id: "todos",
  name: "Todos",
  version: "0.1.0",
  description: "tests",
  // Loosely typed: these tests deliberately mutate/push partial and malformed
  // actions/queries and feed the result to validateManifest(raw: unknown), so
  // the fixture must not pin the arrays to the first element's narrow shape.
  actions: [
    {
      name: "add",
      confirmation: "none",
      input: {
        type: "object",
        properties: { text: { type: "string", minLength: 1 } },
        required: ["text"],
        additionalProperties: false,
      },
    },
  ] as Array<Record<string, unknown>>,
  queries: [
    {
      name: "list",
      input: { type: "object", properties: {}, additionalProperties: false },
    },
  ] as Array<Record<string, unknown>>,
});

/**
 * Runs `fn` and hands back whatever it threw — `undefined` when it returned
 * normally. Keeps the "it threw X with code Y" assertions unconditional: a
 * silent no-throw leaves `err` undefined and fails `toBeInstanceOf`.
 */
function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("manifest constants", () => {
  it("exposes file name and version", () => {
    expect(APP_MANIFEST_FILE).toBe("app.json");
    expect(MANIFEST_VERSION).toBe(1);
  });
});

describe(validateManifest, () => {
  it("accepts a well-formed manifest", () => {
    const m = validateManifest(baseManifest());
    expect(m.id).toBe("todos");
    expect(m.actions).toHaveLength(1);
    expect(m.queries).toHaveLength(1);
  });

  it("accepts and preserves a row-filtered, field-masked vault scope", () => {
    const m = {
      ...baseManifest(),
      vault: {
        purpose: "dpv:ServiceProvision",
        why: "Read one domain's revision history.",
        scopes: [
          {
            schema: "core",
            table: "entity_revision",
            verbs: "read",
            rowFilter: [
              {
                column: "entity_type",
                op: "eq",
                value: "people.person",
              },
            ],
            fieldMask: ["revision_id", "entity_id", "snapshot_json"],
          },
        ],
      },
    };
    const out = validateManifest(m);
    expect(out.vault?.scopes[0]).toMatchObject({
      rowFilter: [
        {
          column: "entity_type",
          op: "eq",
          value: "people.person",
        },
      ],
      fieldMask: ["revision_id", "entity_id", "snapshot_json"],
    });
  });

  it("rejects unknown filtered-scope fields", () => {
    const m = {
      ...baseManifest(),
      vault: {
        purpose: "dpv:ServiceProvision",
        why: "Malformed filter.",
        scopes: [
          {
            schema: "core",
            verbs: "read",
            rowFilter: [
              { column: "entity_type", op: "eq", value: "x", rawSql: "1=1" },
            ],
          },
        ],
      },
    };
    expect(() => validateManifest(m)).toThrow(ManifestError);
  });

  it("rejects non-object input", () => {
    expect(() => validateManifest(null)).toThrow(ManifestError);
    expect(() => validateManifest("hi")).toThrow(ManifestError);
    expect(() => validateManifest([])).toThrow(ManifestError);
  });

  it("rejects missing manifestVersion with a clear code", () => {
    const m = baseManifest() as Record<string, unknown>;
    delete m.manifestVersion;
    const err = thrownBy(() => validateManifest(m));
    expect(err).toBeInstanceOf(ManifestError);
    expect((err as ManifestError).code).toBe("unsupported_manifest_version");
  });

  it("rejects an unsupported manifestVersion", () => {
    const m = baseManifest();
    (m as Record<string, unknown>).manifestVersion = 99;
    const err = thrownBy(() => validateManifest(m));
    expect(err).toBeInstanceOf(ManifestError);
    expect((err as ManifestError).code).toBe("unsupported_manifest_version");
  });

  it("rejects missing required top-level fields", () => {
    const m = baseManifest() as Record<string, unknown>;
    delete m.id;
    const err = thrownBy(() => validateManifest(m));
    expect(err).toBeInstanceOf(ManifestError);
    expect((err as ManifestError).code).toBe("invalid_manifest");
  });

  it("rejects an action with invalid confirmation", () => {
    const m = baseManifest();
    (m.actions[0] as { confirmation: string }).confirmation = "sometimes";
    expect(() => validateManifest(m)).toThrow(ManifestError);
  });

  it("rejects duplicate action names", () => {
    const m = baseManifest();
    m.actions.push({ ...m.actions[0]! });
    const err = thrownBy(() => validateManifest(m));
    expect(err).toBeInstanceOf(ManifestError);
    expect((err as ManifestError).code).toBe("duplicate_handler");
  });

  it('rejects an action whose name starts with the reserved "_" prefix', () => {
    const m = baseManifest();
    m.actions.push({
      name: "_sql",
      confirmation: "none" as const,
      input: { type: "object" },
    });
    const err = thrownBy(() => validateManifest(m));
    expect(err).toBeInstanceOf(ManifestError);
    expect((err as ManifestError).code).toBe("reserved_handler_name");
  });

  it('rejects a query whose name starts with the reserved "_" prefix', () => {
    const m = baseManifest();
    m.queries.push({
      name: "_sql",
      input: { type: "object" },
    });
    const err = thrownBy(() => validateManifest(m));
    expect(err).toBeInstanceOf(ManifestError);
    expect((err as ManifestError).code).toBe("reserved_handler_name");
  });

  it("allows the same name in actions and queries", () => {
    const m = baseManifest();
    m.queries.push({
      name: "add",
      input: { type: "object", properties: {}, additionalProperties: false },
    });
    const out = validateManifest(m);
    expect(out.queries).toHaveLength(2);
  });

  it("treats the ext band as optional", () => {
    const m = baseManifest();
    const out = validateManifest(m);
    expect(out.ext).toBeUndefined();
  });

  it("omits kind when absent and carries an automation kind through", () => {
    // No `kind` → a normal UI app; the field is simply absent.
    expect(validateManifest(baseManifest()).kind).toBeUndefined();
    // `kind: 'automation'` marks a UI-less automation app (replaces the
    // legacy `auto.` id prefix) and round-trips through validation.
    const auto = { ...baseManifest(), kind: "automation" };
    expect(validateManifest(auto).kind).toBe("automation");
  });

  it("rejects an unknown kind value", () => {
    const m = { ...baseManifest(), kind: "widget" };
    expect(() => validateManifest(m)).toThrow(ManifestError);
  });

  it("treats the seats block as optional", () => {
    const m = baseManifest();
    const out = validateManifest(m);
    expect(out.seats).toBeUndefined();
  });

  it("round-trips a well-formed seats block (docs/blueprint-seats.md)", () => {
    const m = {
      ...baseManifest(),
      seats: {
        byteBearing: true,
        originActs: ["autofill"],
        disabledOn: ["viewer"],
        northStar: "1password",
      },
    };
    const out = validateManifest(m);
    expect(out.seats).toStrictEqual({
      byteBearing: true,
      originActs: ["autofill"],
      disabledOn: ["viewer"],
      northStar: "1password",
    });
  });

  it("rejects a seats block missing a required field", () => {
    const m = {
      ...baseManifest(),
      seats: { byteBearing: true, originActs: [], disabledOn: [] },
    };
    expect(() => validateManifest(m)).toThrow(ManifestError);
  });

  // The designed-state partition (issue #839 G7). The block is optional so the
  // UI-less automation manifests keep validating; when it IS present it must be
  // a CLOSED partition, because a forgotten state would otherwise read as a
  // deliberate non-goal.
  it("treats the states block as optional", () => {
    const out = validateManifest(baseManifest());
    expect(out.states).toBeUndefined();
  });

  it("round-trips a complete designed/excluded partition", () => {
    const m = {
      ...baseManifest(),
      states: {
        designed: ["dayone", "pending", "offline", "stale", "parked", "denied"],
        excluded: [
          {
            state: "conflict",
            reason: "single-writer surface; no second writer can revise a row",
            citation: "docs/blueprint-seats.md#engine-contracts",
          },
        ],
      },
    };
    const out = validateManifest(m);
    expect(out.states).toStrictEqual({
      designed: ["dayone", "pending", "offline", "stale", "parked", "denied"],
      excluded: [
        {
          state: "conflict",
          reason: "single-writer surface; no second writer can revise a row",
          citation: "docs/blueprint-seats.md#engine-contracts",
        },
      ],
    });
  });

  it("accepts a partition that designs every canonical state", () => {
    const out = validateManifest({
      ...baseManifest(),
      states: {
        designed: [...CANONICAL_DESIGNED_STATES],
        excluded: [],
      },
    });
    expect(out.states?.designed).toStrictEqual([...CANONICAL_DESIGNED_STATES]);
  });

  it("rejects a partition that omits a canonical state", () => {
    const err = thrownBy(() =>
      validateManifest({
        ...baseManifest(),
        states: {
          designed: CANONICAL_DESIGNED_STATES.filter(
            (state) => state !== "conflict"
          ),
          excluded: [],
        },
      })
    );
    expect(err).toBeInstanceOf(ManifestError);
    expect((err as ManifestError).code).toBe("invalid_field");
    expect((err as ManifestError).message).toContain("conflict");
  });

  it("rejects a state claimed by both sides", () => {
    const err = thrownBy(() =>
      validateManifest({
        ...baseManifest(),
        states: {
          designed: [...CANONICAL_DESIGNED_STATES],
          excluded: [
            {
              state: "denied",
              reason: "duplicated on purpose",
              citation: "docs/blueprint-seats.md#engine-contracts",
            },
          ],
        },
      })
    );
    expect(err).toBeInstanceOf(ManifestError);
    expect((err as ManifestError).code).toBe("invalid_field");
    expect((err as ManifestError).message).toContain("denied");
  });

  it("rejects a state listed twice under designed", () => {
    const err = thrownBy(() =>
      validateManifest({
        ...baseManifest(),
        states: {
          designed: [...CANONICAL_DESIGNED_STATES, "denied"],
          excluded: [],
        },
      })
    );
    expect(err).toBeInstanceOf(ManifestError);
  });

  it("rejects an unknown state name", () => {
    expect(() =>
      validateManifest({
        ...baseManifest(),
        states: {
          designed: [...CANONICAL_DESIGNED_STATES, "loading"],
          excluded: [],
        },
      })
    ).toThrow(ManifestError);
  });

  it("rejects an excluded entry with no citation", () => {
    expect(() =>
      validateManifest({
        ...baseManifest(),
        states: {
          designed: CANONICAL_DESIGNED_STATES.filter(
            (state) => state !== "stale"
          ),
          excluded: [{ state: "stale", reason: "no replica here" }],
        },
      })
    ).toThrow(ManifestError);
  });

  it("rejects an excluded entry with no reason", () => {
    expect(() =>
      validateManifest({
        ...baseManifest(),
        states: {
          designed: CANONICAL_DESIGNED_STATES.filter(
            (state) => state !== "stale"
          ),
          excluded: [
            {
              state: "stale",
              citation: "docs/blueprint-seats.md#engine-contracts",
            },
          ],
        },
      })
    ).toThrow(ManifestError);
  });

  // An empty string is the cheapest way to satisfy "has a reason"; the schema's
  // minLength: 1 is what keeps a blank from buying a structural exclusion.
  it("rejects an excluded entry whose reason is empty", () => {
    expect(() =>
      validateManifest({
        ...baseManifest(),
        states: {
          designed: CANONICAL_DESIGNED_STATES.filter(
            (state) => state !== "stale"
          ),
          excluded: [
            {
              state: "stale",
              reason: "",
              citation: "docs/blueprint-seats.md#engine-contracts",
            },
          ],
        },
      })
    ).toThrow(ManifestError);
  });

  it("rejects an excluded entry carrying an unknown field", () => {
    expect(() =>
      validateManifest({
        ...baseManifest(),
        states: {
          designed: CANONICAL_DESIGNED_STATES.filter(
            (state) => state !== "stale"
          ),
          excluded: [
            {
              state: "stale",
              reason: "no replica here",
              citation: "docs/blueprint-seats.md#engine-contracts",
              todo: "revisit",
            },
          ],
        },
      })
    ).toThrow(ManifestError);
  });

  it("rejects a states block missing the excluded side entirely", () => {
    expect(() =>
      validateManifest({
        ...baseManifest(),
        states: { designed: [...CANONICAL_DESIGNED_STATES] },
      })
    ).toThrow(ManifestError);
  });
});

describe(parseManifest, () => {
  it("parses well-formed JSON", () => {
    const out = parseManifest(JSON.stringify(baseManifest()));
    expect(out.name).toBe("Todos");
  });

  it("rejects invalid JSON with code invalid_json", () => {
    const err = thrownBy(() => parseManifest("not json"));
    expect(err).toBeInstanceOf(ManifestError);
    expect((err as ManifestError).code).toBe("invalid_json");
  });
});

describe("compileSchema + Ajv round-trip", () => {
  it("compiles a schema and validates against it", () => {
    const validate = compileSchema({
      type: "object",
      properties: { id: { type: "number" } },
      required: ["id"],
      additionalProperties: false,
    });
    expect(validate({ id: 5 })).toBe(true);
    expect(validate({})).toBe(false);
    expect(validate({ id: "x" })).toBe(false);
  });
});

describe("findAction / findQuery", () => {
  it("looks up by name", () => {
    const m = validateManifest(baseManifest());
    expect(findAction(m, "add")?.name).toBe("add");
    expect(findAction(m, "missing")).toBeUndefined();
    expect(findQuery(m, "list")?.name).toBe("list");
    expect(findQuery(m, "missing")).toBeUndefined();
  });
});
