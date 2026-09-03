import { describe, beforeEach, expect, test } from "vitest";

import { plainSqliteRow } from "@centraid/test-kit/sqlite";
import { bootstrappedVault } from "@centraid/test-kit/vault";

import {
  bootstrapVault,
  createGrant,
  enrollAgent,
  enrollDevice,
} from "../bootstrap.js";
import type { BootstrapResult } from "../bootstrap.js";
import { registerScheduleCommands } from "../commands/schedule.js";
import { openVaultDb } from "../db.js";
import type { VaultDb } from "../db.js";
import { uuidv7 } from "../ids.js";
import type { Gateway } from "./gateway.js";
import { createGateway } from "./gateway.js";
import type { Credential } from "./types.js";

const PURPOSE = "dpv:ServiceProvision";
const SID = "owner-1a2b-sid";

let db: VaultDb;
let gw: Gateway;
let boot: BootstrapResult;
let calendarId: string;
describe("acting-owner suite", () => {
  beforeEach(() => {
    ({ db, boot } = bootstrappedVault(
      { openVaultDb, bootstrapVault },
      { ownerName: "Priya" }
    ));
    gw = createGateway(db);
    registerScheduleCommands(gw);
    calendarId = uuidv7();
    db.vault
      .prepare(
        `INSERT INTO schedule_calendar (calendar_id, owner_party_id, name, default_tz, visibility)
       VALUES (?, ?, 'Family', 'Asia/Kolkata', 'private')`
      )
      .run(calendarId, boot.ownerPartyId);
  });

  function proposeInput(summary: string): Record<string, unknown> {
    return {
      summary,
      dtstart: "2026-07-03T09:00:00Z",
      dtend: "2026-07-03T09:15:00Z",
      calendar_id: calendarId,
    };
  }

  function assistant(onBehalfOfOwner?: {
    ownerId: string;
    mayAct: boolean;
  }): Credential {
    const agent = enrollAgent(db, { name: "assistant", modelRef: "model-x" });
    const device = enrollDevice(db, boot.ownerPartyId, "agent-host");
    createGrant(db, {
      granteePartyId: agent.partyId,
      purposeConceptId: boot.concepts[PURPOSE] as string,
      grantedByPartyId: boot.ownerPartyId,
      scopes: [{ schema: "schedule", verbs: "read+act" }],
    });
    return {
      kind: "agent",
      agentId: agent.agentId,
      deviceId: device.deviceId,
      deviceKey: device.deviceKey,
      ...(onBehalfOfOwner ? { onBehalfOfOwner } : {}),
    };
  }

  function receiptDetail(action: string): Record<string, unknown> {
    const row = db.audit
      .prepare(
        `SELECT detail_json FROM access_receipt
        WHERE action = ? ORDER BY receipt_id DESC LIMIT 1`
      )
      .get(action) as { detail_json: string | null } | undefined;
    return JSON.parse(row?.detail_json ?? "{}") as Record<string, unknown>;
  }

  test("a write records the acting owner id, and the id is what survives a rename", () => {
    const owner: Credential = {
      kind: "device",
      deviceId: boot.deviceId,
      deviceKey: boot.deviceKey,
    };

    const outcome = gw.invoke(owner, {
      command: "schedule.propose_event",
      input: proposeInput("School run"),
      purpose: PURPOSE,
      actingOwnerId: SID,
    });

    expect(outcome.status).toBe("executed");
    expect(receiptDetail("act schedule.propose_event")).toMatchObject({
      actingOwner: SID,
    });
    expect(
      JSON.stringify(receiptDetail("act schedule.propose_event"))
    ).not.toContain("Sid");
  });

  test("an unattributed write journals no owner rather than inventing one", () => {
    const owner: Credential = {
      kind: "device",
      deviceId: boot.deviceId,
      deviceKey: boot.deviceKey,
    };

    gw.invoke(owner, {
      command: "schedule.propose_event",
      input: proposeInput("Unattributed"),
      purpose: PURPOSE,
    });

    expect(receiptDetail("act schedule.propose_event")).not.toHaveProperty(
      "actingOwner"
    );
  });

  test("an agent for an owner who does not own the vault is refused the write the owner could not make", () => {
    const cred = assistant({ ownerId: SID, mayAct: false });

    const outcome = gw.invoke(cred, {
      command: "schedule.propose_event",
      input: proposeInput("Refused"),
      purpose: PURPOSE,
      actingOwnerId: SID,
    });

    expect(outcome.status).toBe("denied");
    if (outcome.status !== "denied") throw new Error("expected denial");
    expect(outcome.reason).toContain(SID);
    expect(
      plainSqliteRow(
        db.vault.prepare("SELECT count(*) AS n FROM core_event").get()
      )
    ).toStrictEqual({ n: 0 });
    expect(receiptDetail("act schedule.propose_event")).toMatchObject({
      actingOwner: SID,
    });
  });

  test("an agent for the owner who owns the vault acts, and the receipt names both", () => {
    const cred = assistant({ ownerId: SID, mayAct: true });

    const outcome = gw.invoke(cred, {
      command: "schedule.propose_event",
      input: proposeInput("Allowed"),
      purpose: PURPOSE,
      actingOwnerId: SID,
    });

    expect(outcome.status).toBe("executed");
    expect(receiptDetail("act schedule.propose_event")).toMatchObject({
      actingOwner: SID,
    });
    const provenance = db.audit
      .prepare(
        `SELECT agent_kind FROM access_provenance ORDER BY prov_id DESC LIMIT 1`
      )
      .get() as { agent_kind: string };
    expect(provenance.agent_kind).toBe("ai_agent");
  });

  test("the cap bites reads never — an owner who cannot write still reads through their agent", () => {
    const cred = assistant({ ownerId: SID, mayAct: false });

    expect(() =>
      gw.read(cred, { entity: "schedule.calendar", purpose: PURPOSE })
    ).not.toThrow();
  });
});
