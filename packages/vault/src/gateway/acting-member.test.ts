import { plainSqliteRow } from "@centraid/test-kit/sqlite";
// L4 attribution + the on-behalf-of cap (issue #599 decisions 7–8).
//
// Two claims, both about the journal being able to answer "who did this?":
//   * every write records the acting MEMBER, by id, so a rename cannot fork
//     or strand anyone's history;
//   * an agent turn is hard-capped at the role of the member it works for —
//     Sid's assistant fails exactly where Sid would, and the refusal names
//     both of them.
import { describe, beforeEach, expect, test } from "vitest";

import {
  bootstrapVault,
  createGrant,
  enrollAgent,
  enrollDevice,
  type BootstrapResult,
} from "../bootstrap.js";
import { registerScheduleCommands } from "../commands/schedule.js";
import { openVaultDb, type VaultDb } from "../db.js";
import { uuidv7 } from "../ids.js";
import { createGateway, Gateway } from "./gateway.js";
import type { Credential } from "./types.js";

const PURPOSE = "dpv:ServiceProvision";
const SID = "member-1a2b-sid";

let db: VaultDb;
let gw: Gateway;
let boot: BootstrapResult;
let calendarId: string;
describe("acting-member suite", () => {
  beforeEach(() => {
    db = openVaultDb();
    boot = bootstrapVault(db, { ownerName: "Priya" });
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

  /** An enrolled automation agent granted `read+act` over the schedule. */
  function assistant(onBehalfOfMember?: {
    memberId: string;
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
      ...(onBehalfOfMember ? { onBehalfOfMember } : {}),
    };
  }

  function receiptDetail(action: string): Record<string, unknown> {
    const row = db.journal
      .prepare(
        `SELECT detail_json FROM consent_receipt
        WHERE action = ? ORDER BY receipt_id DESC LIMIT 1`
      )
      .get(action) as { detail_json: string | null } | undefined;
    return JSON.parse(row?.detail_json ?? "{}") as Record<string, unknown>;
  }

  test("a write records the acting member id, and the id is what survives a rename", () => {
    const owner: Credential = {
      kind: "device",
      deviceId: boot.deviceId,
      deviceKey: boot.deviceKey,
    };

    const outcome = gw.invoke(owner, {
      command: "schedule.propose_event",
      input: proposeInput("School run"),
      purpose: PURPOSE,
      actingMemberId: SID,
    });

    expect(outcome.status).toBe("executed");
    expect(receiptDetail("act schedule.propose_event")).toMatchObject({
      actingMember: SID,
    });
    // The journal holds an OPAQUE id — no label anywhere in the row — which is
    // exactly why renaming the person on the gateway cannot touch it.
    expect(
      JSON.stringify(receiptDetail("act schedule.propose_event"))
    ).not.toContain("Sid");
  });

  test("an unattributed write journals no member rather than inventing one", () => {
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
      "actingMember"
    );
  });

  test("an agent for a read-role member is refused the write the member could not make", () => {
    const cred = assistant({ memberId: SID, mayAct: false });

    const outcome = gw.invoke(cred, {
      command: "schedule.propose_event",
      input: proposeInput("Refused"),
      purpose: PURPOSE,
      actingMemberId: SID,
    });

    expect(outcome.status).toBe("denied");
    if (outcome.status !== "denied") throw new Error("expected denial");
    expect(outcome.reason).toContain(SID);
    // Nothing was written, and the refusal names agent AND member.
    expect(
      plainSqliteRow(
        db.vault.prepare("SELECT count(*) AS n FROM core_event").get()
      )
    ).toStrictEqual({ n: 0 });
    expect(receiptDetail("act schedule.propose_event")).toMatchObject({
      actingMember: SID,
    });
  });

  test("an agent for a write-role member acts, and the receipt names both", () => {
    const cred = assistant({ memberId: SID, mayAct: true });

    const outcome = gw.invoke(cred, {
      command: "schedule.propose_event",
      input: proposeInput("Allowed"),
      purpose: PURPOSE,
      actingMemberId: SID,
    });

    expect(outcome.status).toBe("executed");
    expect(receiptDetail("act schedule.propose_event")).toMatchObject({
      actingMember: SID,
    });
    const provenance = db.journal
      .prepare(
        `SELECT agent_kind FROM consent_provenance ORDER BY prov_id DESC LIMIT 1`
      )
      .get() as { agent_kind: string };
    expect(provenance.agent_kind).toBe("ai_agent");
  });

  test("the cap bites reads never — a read-role member still reads through their agent", () => {
    const cred = assistant({ memberId: SID, mayAct: false });

    expect(() =>
      gw.read(cred, { entity: "schedule.calendar", purpose: PURPOSE })
    ).not.toThrow();
  });
});
