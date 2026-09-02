import { assert, beforeEach, describe, expect, test } from "vitest";

import { bootstrapVault } from "../bootstrap.js";
import type { BootstrapResult } from "../bootstrap.js";
import { openVaultDb } from "../db.js";
import type { VaultDb } from "../db.js";
import type { Gateway } from "../gateway/gateway.js";
import { createGateway } from "../gateway/gateway.js";
import type { Credential } from "../gateway/types.js";
import { registerPartyCommands } from "./parties.js";

let db: VaultDb;
let gw: Gateway;
let boot: BootstrapResult;
let owner: Credential;

describe("parties", () => {
  beforeEach(() => {
    db = openVaultDb();
    boot = bootstrapVault(db, { ownerName: "Priya" });
    gw = createGateway(db);
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
      purpose: "dpv:ServiceProvision",
    });
  }

  function addParty(input: Record<string, unknown>): string {
    const outcome = invoke("core.add_party", input);
    expect(outcome.status).toBe("executed");
    return (outcome as { output: { party_id: string } }).output.party_id;
  }

  test("add_party mints a person; reach binds as channels, first per kind preferred", () => {
    const partyId = addParty({
      display_name: "Ravi Kumar",
      sort_name: "Kumar, Ravi",
      identifiers: [
        { scheme: "email", value: "ravi@example.com", label: "work" },
        { scheme: "email", value: "ravi@home.example" },
        { scheme: "tel", value: "+91-98-0000-0000" },
      ],
    });
    const party = db.vault
      .prepare("SELECT * FROM core_party WHERE party_id = ?")
      .get(partyId);
    expect(party).toMatchObject({
      kind: "person",
      display_name: "Ravi Kumar",
      sort_name: "Kumar, Ravi",
    });
    // Email and phone are REACH and land on `social_contact_channel` (#883);
    // the first of a kind claims the preferred slot.
    const channels = db.vault
      .prepare(
        `SELECT kind, value, normalized_value, is_preferred
           FROM social_contact_channel WHERE party_id = ?
          ORDER BY kind, is_preferred DESC, normalized_value`
      )
      .all(partyId) as {
      kind: string;
      value: string;
      normalized_value: string;
      is_preferred: number;
    }[];
    expect(channels.map((row) => ({ ...row }))).toStrictEqual([
      {
        kind: "email",
        value: "ravi@example.com",
        normalized_value: "ravi@example.com",
        is_preferred: 1,
      },
      {
        kind: "email",
        value: "ravi@home.example",
        normalized_value: "ravi@home.example",
        is_preferred: 0,
      },
      {
        kind: "phone",
        value: "+91-98-0000-0000",
        normalized_value: "+919800000000",
        is_preferred: 1,
      },
    ]);
    // Nothing landed in the register: none of these is a key.
    expect(
      db.vault
        .prepare(
          "SELECT count(*) AS n FROM core_party_identifier WHERE party_id = ?"
        )
        .get(partyId)
    ).toMatchObject({ n: 0 });
  });

  test("add_party defaults to kind person and no identifiers", () => {
    const partyId = addParty({ display_name: "Meera" });
    const party = db.vault
      .prepare("SELECT kind FROM core_party WHERE party_id = ?")
      .get(partyId) as {
      kind: string;
    };
    expect(party.kind).toBe("person");
  });

  test("add_party refuses an identifier already claimed by another party (no identity fork)", () => {
    addParty({
      display_name: "Ravi Kumar",
      identifiers: [{ scheme: "email", value: "ravi@example.com" }],
    });
    const outcome = invoke("core.add_party", {
      display_name: "A Second Ravi",
      identifiers: [{ scheme: "email", value: "ravi@example.com" }],
    });
    expect(outcome.status).toBe("failed");
    assert(outcome.status === "failed");
    expect(outcome.reason).toContain("already identifies");
    // The refusal left no half-created party behind.
    const count = db.vault
      .prepare(
        `SELECT count(*) AS n FROM core_party WHERE display_name = 'A Second Ravi'`
      )
      .get() as { n: number };
    expect(count.n).toBe(0);
  });

  test("update_party revises fields and bumps updated_at; agent rows are untouchable", () => {
    const partyId = addParty({ display_name: "Ravi" });
    const before = db.vault
      .prepare("SELECT updated_at FROM core_party WHERE party_id = ?")
      .get(partyId) as { updated_at: string };
    const outcome = invoke("core.update_party", {
      party_id: partyId,
      display_name: "Ravi Kumar",
      birth_date: "1988-04-12",
    });
    expect(outcome.status).toBe("executed");
    const party = db.vault
      .prepare(
        "SELECT display_name, birth_date, updated_at FROM core_party WHERE party_id = ?"
      )
      .get(partyId) as {
      display_name: string;
      birth_date: string;
      updated_at: string;
    };
    expect(party.display_name).toBe("Ravi Kumar");
    expect(party.birth_date).toBe("1988-04-12");
    // `toBeGreaterThanOrEqual` throws on strings, so the ISO-8601 comparison
    // is made here and the boolean asserted.
    const stampNotRewound = party.updated_at >= before.updated_at;
    expect(stampNotRewound, `${party.updated_at} >= ${before.updated_at}`).toBe(
      true
    );

    const now = new Date().toISOString();
    db.vault
      .prepare(
        `INSERT INTO core_party (party_id, kind, display_name, created_at, updated_at)
       VALUES ('agent-party', 'agent', 'assistant', ?, ?)`
      )
      .run(now, now);
    const refused = invoke("core.update_party", {
      party_id: "agent-party",
      display_name: "renamed",
    });
    expect(refused.status).toBe("failed");
    assert(refused.status === "failed");
    expect(refused.predicate).toContain("party_exists_and_editable");
  });
});
