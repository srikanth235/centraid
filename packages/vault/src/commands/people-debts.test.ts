import { assert, beforeEach, describe, expect, test } from "vitest";

import { bootstrapVault, enrollAgent } from "../bootstrap.js";
import type { BootstrapResult } from "../bootstrap.js";
import { openVaultDb } from "../db.js";
import type { VaultDb } from "../db.js";
import type { Gateway } from "../gateway/gateway.js";
import { createGateway } from "../gateway/gateway.js";
import type { Credential } from "../gateway/types.js";
import { answerScopes } from "../grant/automation-principal.test-fixtures.js";
import { registerPartyCommands } from "./parties.js";
import { registerPeopleCommands } from "./people.js";

let db: VaultDb;
let gw: Gateway;
let boot: BootstrapResult;
let owner: Credential;

describe("people: debts", () => {
  beforeEach(() => {
    db = openVaultDb();
    boot = bootstrapVault(db, { ownerName: "Priya" });
    gw = createGateway(db);
    registerPeopleCommands(gw);
    registerPartyCommands(gw);
    owner = {
      kind: "device",
      deviceId: boot.deviceId,
      deviceKey: boot.deviceKey,
    };
  });

  function invoke(command: string, input: Record<string, unknown>) {
    return gw.invoke(owner, {
      command,
      input,
    });
  }

  function out<T = Record<string, unknown>>(o: ReturnType<typeof invoke>): T {
    expect(o.status, JSON.stringify(o)).toBe("executed");
    return (o as { output: T }).output;
  }

  function addPerson(input: Record<string, unknown> = {}) {
    return out<{ party_id: string }>(
      invoke("people.add_person", {
        display_name: "Maya Chen",
        cadence_days: 14,
        ...input,
      })
    ).party_id;
  }

  test("debts add in minor units and settle (a settled debt refuses re-settling)", () => {
    const partyId = addPerson();
    const debtId = out<{ debt_id: string }>(
      invoke("people.add_debt", {
        party_id: partyId,
        direction: "owed",
        amount_minor: 4000,
        reason: "Concert ticket",
      })
    ).debt_id;
    const row = db.vault
      .prepare(
        "SELECT from_party, to_party, amount_minor, settled_at FROM tally_obligation WHERE obligation_id = ?"
      )
      .get(debtId) as {
      from_party: string;
      to_party: string;
      amount_minor: number;
      settled_at: string | null;
    };
    expect(row).toMatchObject({
      from_party: partyId,
      to_party: boot.ownerPartyId,
      amount_minor: 4000,
      settled_at: null,
    });
    expect(invoke("people.settle_debt", { debt_id: debtId }).status).toBe(
      "executed"
    );
    const again = invoke("people.settle_debt", { debt_id: debtId });
    expect(again.status).toBe("failed");
    assert(again.status === "failed");
    expect(again.predicate).toContain("debt_open");
  });

  test("the installed People grant can write an obligation and read it through Tally", () => {
    const partyId = addPerson();
    const app = enrollAgent(db, {
      name: "people",
      modelRef: "test-automation",
    });
    answerScopes(db, boot, "people", [
      { schema: "people", verbs: "read+act" },
      { schema: "tally", table: "obligation", verbs: "read" },
    ]);
    const appCredential: Credential = {
      kind: "agent",
      agentId: app.agentId,
      deviceId: boot.deviceId,
      deviceKey: boot.deviceKey,
    };
    const added = gw.invoke(appCredential, {
      command: "people.add_debt",
      input: {
        party_id: partyId,
        direction: "owed",
        amount_minor: 7250,
        reason: "Train fare",
      },
    });
    expect(added.status).toBe("executed");
    const debtId = (added as { output: { debt_id: string } }).output.debt_id;
    expect(
      gw
        .read(appCredential, {
          entity: "tally.obligation",
          where: [{ column: "obligation_id", op: "eq", value: debtId }],
        })
        .rows.map((row) => row.obligation_id)
    ).toContain(debtId);
  });
});
