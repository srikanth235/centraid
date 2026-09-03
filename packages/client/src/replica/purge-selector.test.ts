import { describe, expect, it } from "vitest";

import {
  forgetReplicaPurgeSelector,
  listReplicaPurgeSelectors,
  rememberReplicaPurgeSelector,
  replicaPurgeSelectorMatches,
} from "./purge-selector.js";
import type { ReplicaPurgeSelector } from "./purge-selector.js";

function memoryStorage(seed?: string) {
  const values = new Map<string, string>();
  if (seed !== undefined)
    values.set("centraid.replica.purge-selectors.v1", seed);
  return {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => {
      values.set(k, v);
    },
    removeItem: (k: string) => {
      values.delete(k);
    },
    values,
  };
}

describe("list / remember / forget", () => {
  it("returns [] without storage or on corrupt JSON", () => {
    expect(listReplicaPurgeSelectors(undefined)).toStrictEqual([]);
    expect(listReplicaPurgeSelectors(memoryStorage("not-json"))).toStrictEqual(
      []
    );
    expect(listReplicaPurgeSelectors(memoryStorage("{}"))).toStrictEqual([]);
  });

  it("dedupes, validates kinds, and round-trips remember/forget", () => {
    const storage = memoryStorage();
    const identity: ReplicaPurgeSelector = {
      kind: "identity",
      gatewayId: "gw1",
      vaultId: "v1",
    };
    const gateway: ReplicaPurgeSelector = { kind: "gateway", gatewayId: "gw1" };
    const inactive: ReplicaPurgeSelector = {
      kind: "inactive-vaults",
      gatewayId: "gw1",
      activeVaultId: "v-active",
    };

    expect(rememberReplicaPurgeSelector(identity, storage)).toBe(true);
    expect(rememberReplicaPurgeSelector(identity, storage)).toBe(true); // idempotent
    expect(rememberReplicaPurgeSelector(gateway, storage)).toBe(true);
    expect(rememberReplicaPurgeSelector(inactive, storage)).toBe(true);
    expect(listReplicaPurgeSelectors(storage)).toHaveLength(3);

    expect(forgetReplicaPurgeSelector(gateway, storage)).toBe(true);
    expect(
      listReplicaPurgeSelectors(storage)
        .map((s) => s.kind)
        .sort()
    ).toStrictEqual(["identity", "inactive-vaults"]);
    expect(forgetReplicaPurgeSelector(identity, storage)).toBe(true);
    expect(forgetReplicaPurgeSelector(inactive, storage)).toBe(true);
    expect(listReplicaPurgeSelectors(storage)).toStrictEqual([]);
    expect(storage.values.has("centraid.replica.purge-selectors.v1")).toBe(
      false
    );

    expect(rememberReplicaPurgeSelector(identity, undefined)).toBe(false);
    expect(forgetReplicaPurgeSelector(identity, undefined)).toBe(true);
  });

  it("drops invalid entries from stored JSON", () => {
    const storage = memoryStorage(
      JSON.stringify([
        { kind: "gateway", gatewayId: "ok" },
        { kind: "gateway" },
        { kind: "identity", gatewayId: "g", vaultId: "" },
        { kind: "nope", gatewayId: "g" },
      ])
    );
    expect(listReplicaPurgeSelectors(storage)).toStrictEqual([
      { kind: "gateway", gatewayId: "ok" },
    ]);
  });
});

describe(replicaPurgeSelectorMatches, () => {
  const id = { gatewayId: "gw", vaultId: "v1" };
  it("matches identity / gateway / inactive-vaults semantics", () => {
    expect(
      replicaPurgeSelectorMatches(
        { kind: "identity", gatewayId: "gw", vaultId: "v1" },
        id
      )
    ).toBe(true);
    expect(
      replicaPurgeSelectorMatches(
        { kind: "identity", gatewayId: "gw", vaultId: "other" },
        id
      )
    ).toBe(false);
    expect(
      replicaPurgeSelectorMatches({ kind: "gateway", gatewayId: "gw" }, id)
    ).toBe(true);
    expect(
      replicaPurgeSelectorMatches({ kind: "gateway", gatewayId: "other" }, id)
    ).toBe(false);
    expect(
      replicaPurgeSelectorMatches(
        { kind: "inactive-vaults", gatewayId: "gw", activeVaultId: "v-active" },
        id
      )
    ).toBe(true);
    expect(
      replicaPurgeSelectorMatches(
        { kind: "inactive-vaults", gatewayId: "gw", activeVaultId: "v1" },
        id
      )
    ).toBe(false);
  });
});
