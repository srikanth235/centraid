// The frame's transfer policy record (#711); rule EVALUATION against the
// radios lives in `lib/upload/native-policy.test.ts`. AsyncStorage stubbed
// so the record logic runs under node.

import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_TRANSFER_POLICY,
  TRANSFER_POLICY_KEY,
  TRANSFER_POLICY_SWITCHES,
  describeTransferPolicy,
  hydrateTransferPolicy,
  writeTransferPolicy,
} from "./transfer-policy";

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
    // Renaming the key resets every member device to defaults.
    expect(TRANSFER_POLICY_KEY).toBe("photos.backupRules");
  });

  it("defaults to the conservative answer", () => {
    expect(DEFAULT_TRANSFER_POLICY).toStrictEqual({
      wifiOnly: true,
      allowMetered: false,
      allowRoaming: false,
      chargerOnly: false,
      // `never` OFF by default: "under rules", not "not at all" (#712).
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

  // REFUSAL GRAMMAR (#712): required `inertReason` keeps grey switches explained.
  it("every inert switch states a reason, and no active one does", () => {
    const policies = [
      DEFAULT_TRANSFER_POLICY,
      { ...DEFAULT_TRANSFER_POLICY, wifiOnly: false },
      { ...DEFAULT_TRANSFER_POLICY, wifiOnly: false, allowMetered: true },
      { ...DEFAULT_TRANSFER_POLICY, never: true },
    ];
    // Collected then asserted once — an `if` around an `expect` hides the case.
    const seen = policies.flatMap((policy) =>
      TRANSFER_POLICY_SWITCHES.map((rule) => ({
        key: rule.key,
        inert: rule.inert(policy),
        explained: (rule.inertReason(policy)?.length ?? 0) > 10,
      }))
    );
    expect(seen.filter((row) => row.inert !== row.explained)).toStrictEqual([]);
    // …and the sample has both cases, or the assert is vacuous.
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
    // Floor rule wins: never read "Wi-Fi only" on a device that transfers nothing.
    expect(
      roaming?.inertReason({ ...DEFAULT_TRANSFER_POLICY, never: true })
    ).toContain("Never move bytes off this device");
  });

  it("charging is orthogonal and never inert", () => {
    expect(inertKeys(DEFAULT_TRANSFER_POLICY)).not.toContain("chargerOnly");
  });

  it("`never` makes every other switch inert, and is never inert itself", () => {
    // Floor (#712): the switch must stay reachable, or it cannot be undone.
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
    // `net` is ink/edge, never fill (§18) — reserved for ON-halts-transfers.
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
    ).toBe("Never — nothing leaves this device.");
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
