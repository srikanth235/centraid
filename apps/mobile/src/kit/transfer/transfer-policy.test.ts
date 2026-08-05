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
    });
  });

  it("round-trips through durable storage, filling fields an old record lacks", async () => {
    writeTransferPolicy({ ...DEFAULT_TRANSFER_POLICY, chargerOnly: true });
    await expect(hydrateTransferPolicy()).resolves.toStrictEqual({
      wifiOnly: true,
      allowMetered: false,
      allowRoaming: false,
      chargerOnly: true,
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

  it("charging is orthogonal and never inert", () => {
    expect(inertKeys(DEFAULT_TRANSFER_POLICY)).not.toContain("chargerOnly");
  });
});

describe(describeTransferPolicy, () => {
  it("says what the defaults actually promise", () => {
    expect(describeTransferPolicy(DEFAULT_TRANSFER_POLICY)).toBe(
      "On Wi-Fi only, charging or not."
    );
  });

  it("names roaming only when roaming is on the table", () => {
    expect(
      describeTransferPolicy({
        wifiOnly: false,
        allowMetered: true,
        allowRoaming: false,
        chargerOnly: false,
      })
    ).toBe("On any connection, but not while roaming, charging or not.");
    expect(
      describeTransferPolicy({
        wifiOnly: false,
        allowMetered: true,
        allowRoaming: true,
        chargerOnly: true,
      })
    ).toBe("On any connection, roaming included, and only while charging.");
  });
});
