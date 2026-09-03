import { afterEach, describe, expect, test } from "vitest";

import { tempDirSync } from "@centraid/test-kit/temp-dir";

import { bootstrapVault, createGrant } from "./bootstrap.js";
import { registerTaskCommands } from "./commands/tasks.js";
import { openVaultDb } from "./db.js";
import type { VaultDb } from "./db.js";
import { createGateway } from "./gateway/gateway.js";
import {
  ensureAgentEnrolled,
  ensureAppEnrolled,
  recoverVaultBootstrap,
  listActiveAgentGrants,
  listActiveGrants,
  listEnrolledAgents,
  lookupAgentByName,
  lookupAppByName,
  markAgentRevoked,
  purposeConceptId,
} from "./host.js";

const cleanups: (() => void)[] = [];
describe("host", () => {
  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.();
  });
  test("founding bootstraps explicitly and recovery never creates an absent vault", () => {
    const dir = tempDirSync();
    const first = openVaultDb({ dir });
    const boot1 = bootstrapVault(first, { ownerName: "Priya" });
    first.close();

    const second = openVaultDb({ dir });
    cleanups.push(() => second.close());
    const boot2 = recoverVaultBootstrap(second);
    expect(boot2).toBeDefined();
    if (!boot2) throw new Error("expected recovered vault");
    expect(boot2.fresh).toBe(false);
    expect(boot2.vaultId).toBe(boot1.vaultId);
    expect(boot2.ownerPartyId).toBe(boot1.ownerPartyId);
    expect(boot2.deviceId).toBe(boot1.deviceId);
    expect(boot2.deviceKey).toBe(boot1.deviceKey);
    expect(boot2.concepts["dpv:ServiceProvision"]).toBe(
      boot1.concepts["dpv:ServiceProvision"]
    );
    const gw = createGateway(second);
    const cred = {
      kind: "device",
      deviceId: boot2.deviceId,
      deviceKey: boot2.deviceKey,
    } as const;
    const result = gw.read(cred, {
      entity: "core.party",
      purpose: "dpv:ServiceProvision",
    });
    expect(result.rows.length).toBeGreaterThan(0);

    const empty = openVaultDb();
    cleanups.push(() => empty.close());
    expect(recoverVaultBootstrap(empty)).toBeUndefined();
  });

  test("ensureAppEnrolled is idempotent per host-side name", () => {
    const db: VaultDb = openVaultDb();
    cleanups.push(() => db.close());
    bootstrapVault(db, { ownerName: "Priya" });
    const first = ensureAppEnrolled(db, "expense-tracker");
    expect(first.created).toBe(true);
    const again = ensureAppEnrolled(db, "expense-tracker");
    expect(again.created).toBe(false);
    expect(again.appId).toBe(first.appId);
    expect(again.signingKey).toBe(first.signingKey);
    expect(lookupAppByName(db, "expense-tracker")?.appId).toBe(first.appId);
    expect(lookupAppByName(db, "never-registered")).toBeUndefined();
    expect(first.name).toBe("expense-tracker");
    expect({
      ...db.vault
        .prepare("SELECT display_name FROM access_app WHERE app_id = ?")
        .get(first.appId),
    }).toStrictEqual({ display_name: "Expense Tracker" });
  });

  test("listActiveGrants surfaces purpose notation and scopes", () => {
    const db = openVaultDb();
    cleanups.push(() => db.close());
    const boot = bootstrapVault(db, { ownerName: "Priya" });
    const app = ensureAppEnrolled(db, "calendar");
    expect(listActiveGrants(db, app.appId)).toStrictEqual([]);
    const purpose = purposeConceptId(db, "dpv:ServiceProvision");
    expect(purpose).toBe(boot.concepts["dpv:ServiceProvision"]);
    createGrant(db, {
      appId: app.appId,
      purposeConceptId: purpose as string,
      grantedByPartyId: boot.ownerPartyId,
      scopes: [
        { schema: "schedule", verbs: "read+act" },
        { schema: "core", table: "event", verbs: "read" },
      ],
    });
    const grants = listActiveGrants(db, app.appId);
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({
      purpose: "dpv:ServiceProvision",
      expiresAt: null,
    });
    expect(grants[0]?.scopes).toStrictEqual([
      { schema: "schedule", table: null, verbs: "read+act" },
      { schema: "core", table: "event", verbs: "read" },
    ]);
  });

  test("ensureAgentEnrolled is idempotent per host-side name; grants match on the agent party", () => {
    const db = openVaultDb();
    cleanups.push(() => db.close());
    const boot = bootstrapVault(db, { ownerName: "Priya" });
    const gw = createGateway(db);
    registerTaskCommands(gw);

    const first = ensureAgentEnrolled(db, "briefing");
    expect(first.created).toBe(true);
    const again = ensureAgentEnrolled(db, "briefing");
    expect(again.created).toBe(false);
    expect(again.agentId).toBe(first.agentId);
    expect(again.partyId).toBe(first.partyId);
    expect(lookupAgentByName(db, "briefing")?.agentId).toBe(first.agentId);
    expect(lookupAgentByName(db, "never-enrolled")).toBeUndefined();

    const cred = {
      kind: "agent",
      agentId: first.agentId,
      deviceId: boot.deviceId,
      deviceKey: boot.deviceKey,
    } as const;
    expect(() =>
      gw.read(cred, {
        entity: "schedule.task",
        purpose: "dpv:ServiceProvision",
      })
    ).toThrow(/deny/u);

    createGrant(db, {
      granteePartyId: first.partyId,
      purposeConceptId: purposeConceptId(db, "dpv:ServiceProvision") as string,
      grantedByPartyId: boot.ownerPartyId,
      scopes: [{ schema: "schedule", verbs: "read+act" }],
    });
    const grants = listActiveAgentGrants(db, first.partyId);
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ purpose: "dpv:ServiceProvision" });

    const read = gw.read(cred, {
      entity: "schedule.task",
      purpose: "dpv:ServiceProvision",
    });
    expect(read.rows).toStrictEqual([]);
    const outcome = gw.invoke(cred, {
      command: "schedule.add_task",
      input: { title: "water the plants" },
      purpose: "dpv:ServiceProvision",
    });
    expect(outcome.status).toBe("executed");

    markAgentRevoked(db, first.agentId);
    expect(lookupAgentByName(db, "briefing")).toBeUndefined();
    expect(() =>
      gw.read(cred, {
        entity: "schedule.task",
        purpose: "dpv:ServiceProvision",
      })
    ).toThrow(/unknown caller/u);
    expect(
      listEnrolledAgents(db).find((a) => a.agentId === first.agentId)
    ).toBeUndefined();
  });

  test("ensureAgentEnrolled humanizes a raw enrollment key into a readable display name, and self-heals a stale one (issue: parked-invocation trust legibility)", () => {
    const db = openVaultDb();
    cleanups.push(() => db.close());
    bootstrapVault(db, { ownerName: "Priya" });

    const first = ensureAgentEnrolled(db, "e2e-agent-purge-demo");
    expect(first.created).toBe(true);
    expect(first.name).toBe("E2e Agent Purge Demo");
    expect(lookupAgentByName(db, "e2e-agent-purge-demo")?.name).toBe(
      "E2e Agent Purge Demo"
    );

    const named = ensureAgentEnrolled(db, "e2e-agent-purge-demo", {
      displayName: "Purge Demo",
    });
    expect(named.created).toBe(false);
    expect(named.agentId).toBe(first.agentId);
    expect(named.partyId).toBe(first.partyId);
    expect(named.name).toBe("Purge Demo");
    expect(lookupAgentByName(db, "e2e-agent-purge-demo")?.name).toBe(
      "Purge Demo"
    );

    db.vault
      .prepare(`UPDATE core_party SET display_name = ? WHERE party_id = ?`)
      .run("e2e-agent-purge-demo", first.partyId);
    const healed = ensureAgentEnrolled(db, "e2e-agent-purge-demo");
    expect(healed.agentId).toBe(first.agentId);
    expect(healed.name).toBe("E2e Agent Purge Demo");
  });
});
