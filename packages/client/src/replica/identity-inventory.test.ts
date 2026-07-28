/**
 * IndexedDB replica identity inventory (issue #545 B8).
 */

import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";

import { createIndexedDbReplicaIdentityInventory } from "./identity-inventory.js";

describe(createIndexedDbReplicaIdentityInventory, () => {
  it("activate / list / markTerminal / deferTerminal / remove", async () => {
    const inv = createIndexedDbReplicaIdentityInventory(new IDBFactory());
    const a = { gatewayId: "gw", vaultId: "v1" };
    const b = { gatewayId: "gw", vaultId: "v2" };

    await expect(inv.activate(a)).resolves.toBe(true);
    await expect(inv.activate(a)).resolves.toBe(true); // re-activate remembered
    await expect(inv.activate(b)).resolves.toBe(true);
    let rows = await inv.list();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.state === "remembered")).toBe(true);

    await inv.markTerminal(a);
    rows = await inv.list();
    const terminal = rows.find((r) => r.vaultId === "v1");
    expect(terminal?.state).toBe("terminal-pending");
    expect(terminal?.purgeAttempts).toBe(0);

    // activate refuses while terminal-pending
    await expect(inv.activate(a)).resolves.toBe(false);

    const failedAt = 1_000_000;
    await inv.deferTerminal(a, failedAt, 100, 10_000);
    rows = await inv.list();
    const deferred = rows.find((r) => r.vaultId === "v1")!;
    expect(deferred.purgeAttempts).toBe(1);
    expect(deferred.retryAt).toBe(failedAt + 100);

    await inv.deferTerminal(a, failedAt, 100, 150);
    const capped = (await inv.list()).find((r) => r.vaultId === "v1")!;
    expect(capped.purgeAttempts).toBe(2);
    // baseDelay * 2^(attempts-1) = 200, capped at maxDelay 150
    expect(capped.retryAt).toBe(failedAt + 150);

    await inv.remove(a);
    expect((await inv.list()).map((r) => r.vaultId)).toStrictEqual(["v2"]);
  });
});
