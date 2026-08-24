// Engine profiles (#807) — that the built-ins are derived rather than
// stored, that egress is computed from the engine and unreachable from input,
// and that the write gate refuses out loud everything the reader drops.

import { describe, expect, test } from "vitest";

import { BUILT_IN_PROFILE } from "@centraid/vault";

import { ENRICH_CAPABILITIES } from "./capability-registry.js";
import {
  ENGINE_PROFILE_PREFS_PREFIX,
  builtInProfileFor,
  builtInProfiles,
  capabilityAllowsDelegate,
  delegateEgress,
  delegateRefusalReason,
  engineProfilePrefsKey,
  engineProfileEgress,
  engineProfilesForCapability,
  isBuiltInProfileId,
  laneEgress,
  listEngineProfiles,
  readEngineProfile,
  userEngineProfiles,
  validateEngineProfilePatch,
} from "./engine-profiles.js";

/** One well-formed stored profile; `model` is a fixture id, never a source literal. */
function stored(overrides: Record<string, unknown> = {}) {
  return {
    capability: "ocr",
    label: "Careful OCR",
    harness: "codex",
    model: "some-model-id",
    ...overrides,
  };
}

describe("built-in profiles", () => {
  test("every capability has exactly one, derived from the registry", () => {
    const profiles = builtInProfiles();
    expect(profiles).toHaveLength(ENRICH_CAPABILITIES.length);
    expect(profiles.map((profile) => profile.capability)).toStrictEqual(
      ENRICH_CAPABILITIES.map((contract) => contract.id)
    );
    for (const profile of profiles) {
      expect(profile.id).toBe(BUILT_IN_PROFILE);
      expect(profile.builtIn).toBe(true);
      expect(profile.engine).toStrictEqual({ kind: "built-in" });
      expect(profile.label).toContain(profile.capability);
    }
  });

  test("an unknown capability has no profile", () => {
    expect(builtInProfileFor("nope")).toBeUndefined();
  });

  test("they exist with empty prefs — nothing is stored for them", () => {
    expect(listEngineProfiles({})).toStrictEqual(builtInProfiles());
    expect(userEngineProfiles({})).toStrictEqual([]);
  });

  test("the id is the same string every capability's stamps carry", () => {
    expect(isBuiltInProfileId(BUILT_IN_PROFILE)).toBe(true);
    expect(isBuiltInProfileId("mine")).toBe(false);
  });
});

describe("egress is computed from the engine", () => {
  test("the lane maps to on-device / gateway, and gateway is the fail-safe", () => {
    expect(laneEgress("device")).toBe("on-device");
    expect(laneEgress("gateway")).toBe("gateway");
    expect(builtInProfileFor("ocr")!.egress).toBe("gateway");
    expect(builtInProfileFor("ocr", { laneFor: () => "device" })!.egress).toBe(
      "on-device"
    );
  });

  test("every delegate profile is provider, whatever the harness", () => {
    expect(delegateEgress("codex")).toBe("provider");
    expect(delegateEgress("pi")).toBe("provider");
    expect(
      engineProfileEgress({
        capability: "ocr",
        engine: { kind: "delegate", harness: "codex" },
      })
    ).toBe("provider");
  });

  test("a stored profile cannot claim a lower class than its engine implies", () => {
    const prefs = {
      [engineProfilePrefsKey("mine")]: stored({ egress: "on-device" }),
    };
    // Read: the claim is not a field the reader consults.
    expect(readEngineProfile(prefs, "mine")!.egress).toBe("provider");
    // Write: it is refused rather than ignored.
    expect(validateEngineProfilePatch(prefs)).toContain("computed");
  });
});

describe("faces admits no delegate", () => {
  test("the refusal is stated, and only faces carries one", () => {
    expect(capabilityAllowsDelegate("faces")).toBe(false);
    expect(delegateRefusalReason("faces")).toContain("biometric");
    for (const contract of ENRICH_CAPABILITIES) {
      if (contract.id === "faces") continue;
      expect(capabilityAllowsDelegate(contract.id)).toBe(true);
      expect(delegateRefusalReason(contract.id)).toBeUndefined();
    }
  });

  test("a faces delegate profile can neither be written nor read back", () => {
    const prefs = {
      [engineProfilePrefsKey("faces-llm")]: stored({ capability: "faces" }),
    };
    expect(validateEngineProfilePatch(prefs)).toContain("biometric");
    expect(readEngineProfile(prefs, "faces-llm")).toBeUndefined();
    expect(engineProfilesForCapability(prefs, "faces")).toStrictEqual([
      builtInProfileFor("faces"),
    ]);
  });
});

describe("prefs round-trip", () => {
  test("a stored profile reads back with its bindings intact", () => {
    const prefs = {
      [engineProfilePrefsKey("mine")]: stored({
        configPins: { thought_level: "high", mode: "careful" },
        promptRev: "r3",
      }),
      "harness.kind": "codex",
    };
    expect(readEngineProfile(prefs, "mine")).toStrictEqual({
      id: "mine",
      label: "Careful OCR",
      capability: "ocr",
      engine: {
        kind: "delegate",
        harness: "codex",
        model: "some-model-id",
        configPins: { thought_level: "high", mode: "careful" },
        promptRev: "r3",
      },
      egress: "provider",
      builtIn: false,
      delegateCapable: true,
    });
    expect(validateEngineProfilePatch(prefs)).toBeUndefined();
  });

  test("a JSON string value is accepted — CLI-authored prefs are strings", () => {
    const prefs = {
      [engineProfilePrefsKey("mine")]: JSON.stringify(stored()),
    };
    expect(readEngineProfile(prefs, "mine")?.engine).toStrictEqual({
      kind: "delegate",
      harness: "codex",
      model: "some-model-id",
    });
  });

  test("the built-in id needs a capability to resolve; ordinary ids do not", () => {
    expect(readEngineProfile({}, BUILT_IN_PROFILE)).toBeUndefined();
    expect(readEngineProfile({}, BUILT_IN_PROFILE, "ocr")).toStrictEqual(
      builtInProfileFor("ocr")
    );
  });

  test("the listing is built-ins then the member's, and only this namespace", () => {
    const prefs = {
      "harness.kind": "codex",
      "model.codex.default": "some-model-id",
      [engineProfilePrefsKey("zeta")]: stored({ capability: "doc-text" }),
      [engineProfilePrefsKey("alpha")]: stored(),
    };
    const listed = listEngineProfiles(prefs);
    expect(listed.slice(0, ENRICH_CAPABILITIES.length)).toStrictEqual(
      builtInProfiles()
    );
    expect(
      listed.slice(ENRICH_CAPABILITIES.length).map((profile) => profile.id)
    ).toStrictEqual(["alpha", "zeta"]);
    expect(
      engineProfilesForCapability(prefs, "ocr").map((p) => p.id)
    ).toStrictEqual([BUILT_IN_PROFILE, "alpha"]);
  });

  test("the prefs key is the namespace the gateway validates", () => {
    expect(engineProfilePrefsKey("mine")).toBe(
      `${ENGINE_PROFILE_PREFS_PREFIX}mine`
    );
  });
});

describe("validation refuses out loud what the reader drops", () => {
  // `readerDrops` marks the cases the lenient reader also refuses. The
  // optional fields (label, model, prompt rev, pins) are typo-tolerant on
  // read — a bad one is dropped and the profile still runs — but the writer
  // refuses them rather than silently discarding what a member typed.
  interface RejectionCase {
    name: string;
    patch: Record<string, unknown>;
    fragment: string;
    /** The lenient reader drops it too. False for the typo-tolerant optionals. */
    readerDrops?: boolean;
  }
  const cases: RejectionCase[] = [
    {
      name: "an unknown capability",
      patch: {
        [engineProfilePrefsKey("mine")]: stored({ capability: "vibes" }),
      },
      fragment: "not a capability",
    },
    {
      name: "a missing capability",
      patch: {
        [engineProfilePrefsKey("mine")]: stored({ capability: undefined }),
      },
      fragment: "must name the capability",
    },
    {
      name: "an unknown harness kind",
      patch: {
        [engineProfilePrefsKey("mine")]: stored({ harness: "hal9000" }),
      },
      fragment: "not a harness this gateway can run",
    },
    {
      name: "a missing harness",
      patch: {
        [engineProfilePrefsKey("mine")]: stored({ harness: undefined }),
      },
      fragment: "must name the harness",
    },
    {
      name: "malformed JSON",
      patch: { [engineProfilePrefsKey("mine")]: "{not json" },
      fragment: "must be a JSON object",
    },
    {
      name: "a non-object value",
      patch: { [engineProfilePrefsKey("mine")]: 7 },
      fragment: "must be a JSON object",
    },
    {
      name: "shadowing a built-in id",
      patch: { [engineProfilePrefsKey(BUILT_IN_PROFILE)]: stored() },
      fragment: "cannot be overridden",
    },
    {
      name: "an unusable id",
      patch: { [`${ENGINE_PROFILE_PREFS_PREFIX}Mine!`]: stored() },
      fragment: "lower-case letters",
    },
    {
      name: "a non-string label",
      patch: { [engineProfilePrefsKey("mine")]: stored({ label: 3 }) },
      fragment: "label must be text",
      readerDrops: false,
    },
    {
      name: "a non-string model",
      patch: { [engineProfilePrefsKey("mine")]: stored({ model: 3 }) },
      fragment: "model must be",
      readerDrops: false,
    },
    {
      name: "a non-string prompt revision",
      patch: { [engineProfilePrefsKey("mine")]: stored({ promptRev: 3 }) },
      fragment: "prompt revision must be text",
      readerDrops: false,
    },
    {
      name: "config pins that are not a map",
      patch: {
        [engineProfilePrefsKey("mine")]: stored({ configPins: ["high"] }),
      },
      fragment: "config pins must be",
      readerDrops: false,
    },
  ];

  test.each(cases)("rejects $name", ({ patch, fragment, readerDrops }) => {
    expect(validateEngineProfilePatch(patch)).toContain(fragment);
    const id = Object.keys(patch)[0]!.slice(ENGINE_PROFILE_PREFS_PREFIX.length);
    // Whatever the writer refuses structurally, the reader never surfaces.
    const read =
      isBuiltInProfileId(id) || readerDrops === false
        ? undefined
        : readEngineProfile(patch, id);
    expect(read).toBeUndefined();
  });

  test("ignores keys outside the namespace and always allows deletion", () => {
    expect(
      validateEngineProfilePatch({ "harness.kind": "codex", "model.x.y": 3 })
    ).toBeUndefined();
    expect(
      validateEngineProfilePatch({ [engineProfilePrefsKey("mine")]: null })
    ).toBeUndefined();
    expect(
      validateEngineProfilePatch({
        [engineProfilePrefsKey(BUILT_IN_PROFILE)]: null,
      })
    ).toBeUndefined();
  });

  test("reports the first offending key only", () => {
    const reason = validateEngineProfilePatch({
      [engineProfilePrefsKey("aaa")]: stored({ capability: "vibes" }),
      [engineProfilePrefsKey("bbb")]: stored({ harness: "hal9000" }),
    });
    expect(reason).toContain('"aaa"');
  });
});
