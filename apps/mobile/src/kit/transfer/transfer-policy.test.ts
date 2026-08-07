// The frame's transfer policy record (#711, S4). The EVALUATION of these rules
// against the radios lives in `lib/upload/native-policy.test.ts` and did not
// move; what is pinned here is the record itself — its defaults, the key it is
// stored under, which switches go inert, and the sentence it says about itself.

import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_TRANSFER_POLICY,
  TRANSFER_POLICY_KEY,
  TRANSFER_POLICY_SWITCHES,
  describeTransferPolicy,
  hydrateTransferPolicy,
  writeTransferPolicy,
} from "./transfer-policy";

// AsyncStorage is a native module; the durable mirror is stood in for so the
// record logic runs under node.
vi.mock(import("../../storage") as Promise<unknown>, () => {
  const cache = new Map<string, unknown>();
  return {
    Store: {
      get: <T>(key: string, fallback: T): T =>
        cache.has(key) ? (cache.get(key) as T) : fallback,
      hydrate: <T>(key: string, fallback: T): Promise<T> =>
        Promise.resolve(cache.has(key) ? (cache.get(key) as T) : fallback),
      set: <T>(key: string, value: T): void => {
        cache.set(key, value);
      },
    },
  };
});

describe("the policy record", () => {
  it("keeps the original storage key, whatever the owner is called now", () => {
    // Moving ownership from Photos to the frame must not move the ROW: this
    // key names an answer already sitting on every member's device, and
    // renaming it would silently reset all of them to the defaults.
    expect(TRANSFER_POLICY_KEY).toBe("photos.backupRules");
  });

  it("defaults to the conservative answer", () => {
    // A default that spends a cellular allowance without being asked is a
    // bill, not a preference.
    expect(DEFAULT_TRANSFER_POLICY).toStrictEqual({
      wifiOnly: true,
      allowMetered: false,
      allowRoaming: false,
      chargerOnly: false,
      // …and `never` is OFF by default: the conservative answer is "under
      // rules", not "not at all". A device that shipped refusing every
      // transfer would look identical to a broken one (#712 P5).
      never: false,
    });
  });

  it("round-trips through durable storage, filling fields an old record lacks", async () => {
    writeTransferPolicy({ ...DEFAULT_TRANSFER_POLICY, chargerOnly: true });
    await expect(hydrateTransferPolicy()).resolves.toStrictEqual({
      wifiOnly: true,
      allowMetered: false,
      allowRoaming: false,
      chargerOnly: true,
      never: false,
    });
  });
});

describe("which switches go inert", () => {
  const inertKeys = (policy: typeof DEFAULT_TRANSFER_POLICY): string[] =>
    TRANSFER_POLICY_SWITCHES.filter((rule) => rule.inert(policy)).map(
      (rule) => rule.key
    );

  it("Wi-Fi-only already answered the metered questions", () => {
    expect(inertKeys(DEFAULT_TRANSFER_POLICY)).toStrictEqual([
      "allowMetered",
      "allowRoaming",
    ]);
  });

  it("roaming stays inert until metered is allowed", () => {
    expect(
      inertKeys({ ...DEFAULT_TRANSFER_POLICY, wifiOnly: false })
    ).toStrictEqual(["allowRoaming"]);
    expect(
      inertKeys({
        ...DEFAULT_TRANSFER_POLICY,
        wifiOnly: false,
        allowMetered: true,
      })
    ).toStrictEqual([]);
  });

  // THE REFUSAL GRAMMAR (issue #712 E1). "Shown disabled and explained" was
  // the interface's own promise and only the first half was kept — four
  // switches went grey in silence. `inertReason` is required on the switch's
  // shape now, so these two properties are what keep it honest rather than
  // merely present.
  it("every inert switch states a reason, and no active one does", () => {
    const policies = [
      DEFAULT_TRANSFER_POLICY,
      { ...DEFAULT_TRANSFER_POLICY, wifiOnly: false },
      { ...DEFAULT_TRANSFER_POLICY, wifiOnly: false, allowMetered: true },
      { ...DEFAULT_TRANSFER_POLICY, never: true },
    ];
    // Collected, then asserted once — an `if` around an `expect` hides which
    // case actually ran when the assertion never fires.
    const seen = policies.flatMap((policy) =>
      TRANSFER_POLICY_SWITCHES.map((rule) => ({
        key: rule.key,
        inert: rule.inert(policy),
        explained: (rule.inertReason(policy)?.length ?? 0) > 10,
      }))
    );
    expect(seen.filter((row) => row.inert !== row.explained)).toStrictEqual([]);
    // …and the sample actually contained both cases, or the line above is
    // vacuously true.
    expect(seen.some((row) => row.inert)).toBe(true);
    expect(seen.some((row) => !row.inert)).toBe(true);
  });

  it("names the rule that answered, not a generic 'unavailable'", () => {
    const wifi = TRANSFER_POLICY_SWITCHES.find((r) => r.key === "allowMetered");
    expect(wifi?.inertReason(DEFAULT_TRANSFER_POLICY)).toContain("Wi-Fi only");
    const roaming = TRANSFER_POLICY_SWITCHES.find(
      (r) => r.key === "allowRoaming"
    );
    expect(
      roaming?.inertReason({ ...DEFAULT_TRANSFER_POLICY, wifiOnly: false })
    ).toContain("Metered and cellular");
    // The floor rule wins over the narrower ones, so a member never reads
    // "Wi-Fi only already answered this" on a device that will not transfer
    // at all.
    expect(
      roaming?.inertReason({ ...DEFAULT_TRANSFER_POLICY, never: true })
    ).toContain("Never move bytes off this device");
  });

  it("charging is orthogonal and never inert", () => {
    expect(inertKeys(DEFAULT_TRANSFER_POLICY)).not.toContain("chargerOnly");
  });

  it("`never` makes every other switch inert, and is never inert itself", () => {
    // It is the floor of the table (#712 P5): once this device may not move
    // bytes at all, "on Wi-Fi" and "while charging" are questions about a
    // thing that is not going to happen. The switch that says so must stay
    // reachable, or a member could not undo it.
    const off = { ...DEFAULT_TRANSFER_POLICY, never: true };
    expect(inertKeys(off)).toStrictEqual([
      "wifiOnly",
      "allowMetered",
      "allowRoaming",
      "chargerOnly",
    ]);
    expect(inertKeys(off)).not.toContain("never");
  });
});

describe("the switch table's shape", () => {
  it("is the handoff's five, in the handoff's order, with `never` in net", () => {
    expect(TRANSFER_POLICY_SWITCHES.map((rule) => rule.key)).toStrictEqual([
      "wifiOnly",
      "allowMetered",
      "allowRoaming",
      "chargerOnly",
      "never",
    ]);
    // `net` is ink and an edge, never a fill (§18) — and it is reserved for
    // the one switch whose ON state HALTS transfers rather than scheduling
    // them differently.
    expect(
      TRANSFER_POLICY_SWITCHES.filter((rule) => rule.net).map(
        (rule) => rule.key
      )
    ).toStrictEqual(["never"]);
  });
});

describe(describeTransferPolicy, () => {
  it("says what the defaults actually promise", () => {
    expect(describeTransferPolicy(DEFAULT_TRANSFER_POLICY)).toBe(
      "On Wi-Fi only, charging or not."
    );
  });

  it("says `never` outright, without a network clause it would contradict", () => {
    expect(
      describeTransferPolicy({ ...DEFAULT_TRANSFER_POLICY, never: true })
    ).toBe("Never. Nothing leaves this device until you change that.");
  });

  it("names roaming only when roaming is on the table", () => {
    expect(
      describeTransferPolicy({
        ...DEFAULT_TRANSFER_POLICY,
        wifiOnly: false,
        allowMetered: true,
      })
    ).toBe("On any connection, but not while roaming, charging or not.");
    expect(
      describeTransferPolicy({
        ...DEFAULT_TRANSFER_POLICY,
        wifiOnly: false,
        allowMetered: true,
        allowRoaming: true,
        chargerOnly: true,
      })
    ).toBe("On any connection, roaming included, and only while charging.");
  });
});
