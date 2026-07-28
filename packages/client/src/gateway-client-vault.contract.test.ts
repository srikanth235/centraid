// Owner-plane contracts: vault status/registry, CSV import staging, the
// outbox / grant / scope-request decision surface, and the gateway log
// transports (paged read + SSE). The app / automation / turn surfaces stay in
// gateway-client-automations.contract.test.ts. Split from that file (500-line
// repo-hygiene cap); shared harness in gateway-client-contract-fixtures.ts.

import { describe, expect, it } from "vitest";

import {
  fetchMock,
  installGatewayContractHarness,
  logs,
  outbox,
  state,
  vault,
} from "./gateway-client-contract-fixtures.js";

installGatewayContractHarness();

describe("renderer gateway owner-plane contracts", () => {
  it("covers owner vault, import, outbox, and log transport contracts", async () => {
    await vault.listAgents();
    await vault.listVaultEntityTypes();
    await vault.searchVaultEntities("invoice");
    await vault.searchVaultAnchors("amount");
    await vault.vaultStatus();
    await vault.listVaults();
    await vault.updateVault({
      vaultId: "vault-1",
      name: "Renamed",
      color: null,
      icon: "home",
      blurb: undefined,
    });
    await vault.vaultApps();
    await vault.approveVaultGrant({
      appId: "daily",
      purpose: "dpv:ServiceProvision",
      scopes: [{ schema: "business", table: "invoice", verbs: "read" }],
      expiresAt: "2026-08-01T00:00:00.000Z",
    });
    await vault.revokeVaultGrant({ grantId: "grant-1" });
    await vault.vaultParked();
    await vault.confirmVaultParked({
      invocationId: "invocation-1",
      approve: true,
    });
    await vault.vaultDemoStatus();
    await vault.vaultDemoLoad("daily");
    await vault.vaultImportStage({
      filename: "invoices.csv",
      text: "id,total\n1,5",
      accountName: "Work",
      currency: "USD",
    });
    await vault.vaultImportsList();
    await vault.vaultImportRows("batch-1");
    await vault.vaultImportPublish("batch-1");
    await vault.vaultImportDiscard("batch-1");
    await vault.vaultConnections();
    await vault.vaultConnectionSetStatus("connection-1", "paused");

    await outbox.getBlocking();
    await outbox.getReview(5);
    await outbox.getReview();
    await outbox.listOutboxItems(["pending", "parked"]);
    await outbox.listOutboxItems();
    await expect(
      outbox.decideOutboxItem({
        itemId: "item-1",
        decision: "approve",
        artifact: { subject: "Hello" },
        alwaysAllow: true,
        note: "Reviewed",
      })
    ).resolves.toMatchObject({ status: "executed" });
    await outbox.listOutboxGrants();
    await outbox.revokeOutboxGrant("grant-1");
    await outbox.listScopeRequests();
    await outbox.decideScopeRequest({ requestId: "scope-1", approve: true });

    await expect(
      logs.fetchGatewayLogs({ after: 1, limit: 10 })
    ).resolves.toMatchObject({
      entries: [expect.objectContaining({ message: "booted" })],
    });
    const entries: string[] = [];
    await logs.streamGatewayLogs(
      (entry) => entries.push(entry.message),
      new AbortController().signal,
      1
    );
    expect(entries).toStrictEqual(["ready"]);

    const writes = fetchMock.mock.calls.map(([url, init]) => ({
      method: (init as RequestInit | undefined)?.method,
      path: new URL(String(url)).pathname,
    }));
    expect(writes).toContainEqual({
      method: "POST",
      path: "/centraid/_vault/imports/batch-1/publish",
    });
    expect(writes).toContainEqual({
      method: "POST",
      path: "/centraid/_vault/outbox/item-1",
    });
  });

  it("treats an absent vault plane as a valid state", async () => {
    state.forceVault404 = true;
    await expect(vault.vaultStatus()).resolves.toBeUndefined();
    await expect(vault.listVaults()).resolves.toBeUndefined();
  });
});
