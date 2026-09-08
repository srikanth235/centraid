import { afterEach, describe, expect, test } from "vitest";

import { tempDirSync } from "@centraid/test-kit/temp-dir";

import { bootstrapVault } from "./bootstrap.js";
import { registerTaskCommands } from "./commands/tasks.js";
import { openVaultDb } from "./db.js";
import type { VaultDb } from "./db.js";
import { createGateway } from "./gateway/gateway.js";
import { automationAnswers } from "./grant/automation-authority.js";
import { answerScopes } from "./grant/automation-principal.test-fixtures.js";
import {
  ensureAgentEnrolled,
  ensureAppEnrolled,
  recoverVaultBootstrap,
  listEnrolledAgents,
  lookupAgentByName,
  lookupAppByName,
  markAgentRevoked,
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
    expect(boot2.concepts["same-as"]).toBe(boot1.concepts["same-as"]);
    // The recovered credential authenticates: an owner read succeeds.
    const gw = createGateway(second);
    const cred = {
      kind: "device",
      deviceId: boot2.deviceId,
      deviceKey: boot2.deviceKey,
    } as const;
    const result = gw.read(cred, {
      entity: "core.party",
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
    // `name` stays the enrollment slug — a wide swath of the desktop renderer
    // key-equates it to the app id — but the raw slug still self-heals onto
    // `access_app.display_name` (surfaced via a parked invocation's
    // `caller`, never through `.name`).
    expect(first.name).toBe("expense-tracker");
    // node:sqlite hands back null-prototype rows; spreading compares the column
    // data (which is the contract) without asserting the driver's prototype.
    expect({
      ...db.vault
        .prepare("SELECT display_name FROM access_app WHERE app_id = ?")
        .get(first.appId),
    }).toStrictEqual({ display_name: "Expense Tracker" });
  });

  test("an automation's standing answers are one row per subject and verb", () => {
    const db = openVaultDb();
    cleanups.push(() => db.close());
    const boot = bootstrapVault(db, { ownerName: "Priya" });
    ensureAgentEnrolled(db, "calendar");
    expect(automationAnswers(db.vault, "calendar")).toStrictEqual([]);
    answerScopes(db, boot, "calendar", [
      { schema: "schedule", verbs: "read+act" },
      { schema: "core", table: "event", verbs: "read" },
    ]);
    expect(
      automationAnswers(db.vault, "calendar").map((answer) => ({
        subjectType: answer.subjectType,
        subjectId: answer.subjectId,
        verb: answer.verb,
        decision: answer.decision,
      }))
    ).toStrictEqual([
      {
        subjectType: "agent.pack",
        subjectId: "schedule",
        verb: "act",
        decision: "granted",
      },
      {
        subjectType: "agent.pack",
        subjectId: "schedule",
        verb: "read",
        decision: "granted",
      },
      {
        subjectType: "core.entity",
        subjectId: "core.event",
        verb: "read",
        decision: "granted",
      },
    ]);
  });

  test("ensureAgentEnrolled is idempotent per host-side name; answers match on the automation id", () => {
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

    // Deny-by-default: the enrolled agent reads nothing until an answer lands.
    const cred = {
      kind: "agent",
      agentId: first.agentId,
      deviceId: boot.deviceId,
      deviceKey: boot.deviceKey,
    } as const;
    expect(() =>
      gw.read(cred, {
        entity: "schedule.task",
      })
    ).toThrow(/deny/u);

    answerScopes(db, boot, "briefing", [
      { schema: "schedule", verbs: "read+act" },
    ]);
    expect(automationAnswers(db.vault, "briefing")).toHaveLength(2);

    // The answer covers reads AND typed commands under the schedule pack.
    const read = gw.read(cred, {
      entity: "schedule.task",
    });
    expect(read.rows).toStrictEqual([]);
    const outcome = gw.invoke(cred, {
      command: "schedule.add_task",
      input: { title: "water the plants" },
    });
    expect(outcome.status).toBe("executed");

    // Retiring the enrollment drops authentication entirely.
    markAgentRevoked(db, first.agentId);
    expect(lookupAgentByName(db, "briefing")).toBeUndefined();
    expect(() =>
      gw.read(cred, {
        entity: "schedule.task",
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

    // No caller has the automation's real manifest name yet — the fallback
    // beats a raw id slug (the exact complaint: Approvals showed
    // "e2e-agent-purge-demo" with no indication of who was asking).
    const first = ensureAgentEnrolled(db, "e2e-agent-purge-demo");
    expect(first.created).toBe(true);
    expect(first.name).toBe("E2e Agent Purge Demo");
    expect(lookupAgentByName(db, "e2e-agent-purge-demo")?.name).toBe(
      "E2e Agent Purge Demo"
    );

    // A caller with the real pretty name upserts it in place — same agent
    // identity (every grant/receipt against its party survives), not a
    // second enrollment.
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

    // A dev vault enrolled before this fix stored the raw slug as the
    // display name outright — the very next enrollment touch heals it,
    // with no re-enrollment ceremony.
    db.vault
      .prepare(`UPDATE core_party SET display_name = ? WHERE party_id = ?`)
      .run("e2e-agent-purge-demo", first.partyId);
    const healed = ensureAgentEnrolled(db, "e2e-agent-purge-demo");
    expect(healed.agentId).toBe(first.agentId);
    expect(healed.name).toBe("E2e Agent Purge Demo");
  });
});
