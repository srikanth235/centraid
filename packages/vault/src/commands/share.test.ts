import { beforeEach, describe, expect, test } from "vitest";

import { bootstrapVault } from "../bootstrap.js";
import type { BootstrapResult } from "../bootstrap.js";
import { openVaultDb } from "../db.js";
import type { VaultDb } from "../db.js";
import { createGateway } from "../gateway/gateway.js";
import type { Gateway } from "../gateway/gateway.js";
import type { Credential, InvokeOutcome } from "../gateway/types.js";
import { readLiveShareGrant, readShareGrant } from "../grant/grant-store.js";
import { uuidv7 } from "../ids.js";
import {
  bindPartyToVault,
  revokePartyVaultBinding,
} from "../share/party-vault-binding.js";
import { registerShareCommands } from "./share.js";

let db: VaultDb;
let gw: Gateway;
let boot: BootstrapResult;
let owner: Credential;
let ravi: string;
let documentId: string;

interface ReceiptRow {
  grant_id: string | null;
  action: string;
  object_type: string;
  object_id: string | null;
  decision: string;
  detail_json: string | null;
}

function receiptsFor(grantId: string): ReceiptRow[] {
  return db.audit
    .prepare(
      `SELECT grant_id, action, object_type, object_id, decision, detail_json
         FROM access_receipt WHERE grant_id = ? ORDER BY receipt_id`
    )
    .all(grantId) as unknown as ReceiptRow[];
}

describe("commands/share", () => {
  beforeEach(() => {
    db = openVaultDb();
    boot = bootstrapVault(db, { ownerName: "Priya" });
    gw = createGateway(db);
    registerShareCommands(gw);
    owner = {
      kind: "device",
      deviceId: boot.deviceId,
      deviceKey: boot.deviceKey,
    };
    ravi = uuidv7();
    db.vault
      .prepare(
        `INSERT INTO core_party
           (party_id, kind, display_name, sort_name, created_at, updated_at)
         VALUES (?, 'person', 'Ravi', 'Ravi', '2026-01-01T00:00:00.000Z',
                 '2026-01-01T00:00:00.000Z')`
      )
      .run(ravi);
    bindPartyToVault(db.vault, {
      partyId: ravi,
      vaultId: "vault-ravi",
      linkedAt: "2026-01-01T00:00:00.000Z",
      displayName: "Ravi",
    });
    documentId = uuidv7();
  });

  function invoke(
    command: string,
    input: Record<string, unknown>
  ): InvokeOutcome {
    return gw.invoke(owner, {
      command,
      input,
      purpose: "dpv:ServiceProvision",
    });
  }

  function grant(
    extra: Record<string, unknown> = {}
  ): InvokeOutcome & { status: string } {
    return invoke("share.grant", {
      audience_kind: "party",
      audience_id: ravi,
      subject_type: "core.document",
      subject_id: documentId,
      verb: "view",
      ...extra,
    });
  }

  test("a grant is journalled and receipted, and the receipt names the grant", () => {
    const outcome = grant();
    expect(outcome.status).toBe("executed");
    const grantId = (outcome as { output: { grant_id: string } }).output
      .grant_id;
    expect(readShareGrant(db.vault, grantId)).toMatchObject({
      capability: "view",
      revokedAt: null,
    });

    const commandId = (
      db.vault
        .prepare("SELECT command_id FROM agent_command WHERE name = ?")
        .get("share.grant") as { command_id: string }
    ).command_id;
    expect(
      db.audit
        .prepare(
          `SELECT count(*) AS n FROM agent_command_invocation
            WHERE command_id = ? AND status = 'executed'`
        )
        .get(commandId)
    ).toMatchObject({ n: 1 });

    const receipts = receiptsFor(grantId);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      action: "act share.grant",
      object_type: "share.authority",
      object_id: grantId,
      decision: "allow",
    });
    expect(JSON.parse(receipts[0]!.detail_json!)).toMatchObject({
      principalKind: "person",
      principalId: ravi,
      subjectType: "core.document",
      verb: "view",
      decisionRecorded: "granted",
    });

    const again = grant();
    expect((again as { output: { outcome: string } }).output.outcome).toBe(
      "exists"
    );
    expect(receiptsFor(grantId)).toHaveLength(1);
  });

  test("a triple the registry does not carry is refused in the ruled words", () => {
    const secret = grant({ subject_type: "locker.item" });
    expect(secret.status).toBe("failed");
    expect((secret as { reason: string }).reason).toContain(
      "not something this vault can share"
    );
    const edit = grant({ subject_type: "media.asset", verb: "edit" });
    expect(edit.status).toBe("failed");
    expect((edit as { reason: string }).reason).toContain(
      "can be shared for view, not for edit"
    );
    expect(
      db.vault.prepare("SELECT count(*) AS n FROM share_authority").get()
    ).toMatchObject({ n: 1 }); // the owner's own device row, and nothing else
  });

  test("changing a verb is a revoke plus a new answer, never an edit in place", () => {
    const first = grant({ subject_type: "tally.group", verb: "view" });
    const grantId = (first as { output: { grant_id: string } }).output.grant_id;
    const widened = grant({ subject_type: "tally.group", verb: "edit" });
    expect(widened.status).toBe("failed");
    expect((widened as { reason: string }).reason).toContain(
      "already shared for view; withdraw that first"
    );
    expect(readShareGrant(db.vault, grantId)).toMatchObject({
      capability: "view",
    });

    expect(invoke("share.revoke", { grant_id: grantId }).status).toBe(
      "executed"
    );
    const wider = grant({ subject_type: "tally.group", verb: "edit" });
    expect((wider as { output: { outcome: string } }).output.outcome).toBe(
      "created"
    );
  });

  test("a refusal is a live row, and saying yes afterwards revokes it first", () => {
    const declined = invoke("share.decline", {
      audience_kind: "party",
      audience_id: ravi,
      subject_type: "core.document",
      subject_id: documentId,
      verb: "view",
    });
    expect(declined.status).toBe("executed");
    const refusalId = (declined as { output: { authority_id: string } }).output
      .authority_id;
    expect(
      db.vault
        .prepare(
          `SELECT decision, revoked_at FROM share_authority
            WHERE authority_id = ?`
        )
        .get(refusalId)
    ).toMatchObject({ decision: "declined", revoked_at: null });
    expect(receiptsFor(refusalId)).toHaveLength(1);
    expect(
      readLiveShareGrant(
        db.vault,
        { kind: "party", id: ravi },
        "core.document",
        documentId
      )
    ).toBeUndefined();

    const yes = grant();
    expect(yes.status).toBe("executed");
    expect(
      db.vault
        .prepare(
          "SELECT revoked_at FROM share_authority WHERE authority_id = ?"
        )
        .get(refusalId)
    ).not.toMatchObject({ revoked_at: null });
  });

  test("a revoke dates the answer, receipts it, and is idempotent", () => {
    const grantId = (grant() as { output: { grant_id: string } }).output
      .grant_id;
    const revoked = invoke("share.revoke", { grant_id: grantId });
    expect((revoked as { output: { outcome: string } }).output.outcome).toBe(
      "revoked"
    );
    expect(readShareGrant(db.vault, grantId)?.revokedAt).toBeTypeOf("string");
    const receipts = receiptsFor(grantId);
    expect(receipts.map((row) => row.action)).toStrictEqual([
      "act share.grant",
      "act share.revoke",
    ]);
    const again = invoke("share.revoke", { grant_id: grantId });
    expect((again as { output: { outcome: string } }).output.outcome).toBe(
      "already-revoked"
    );
    expect(receiptsFor(grantId)).toHaveLength(2);
    const absent = invoke("share.revoke", { grant_id: uuidv7() });
    expect((absent as { output: { outcome: string } }).output.outcome).toBe(
      "absent"
    );
  });

  test("a grant to a person with no linked account is refused, and names the act that would fix it", () => {
    const uma = uuidv7();
    db.vault
      .prepare(
        `INSERT INTO core_party
           (party_id, kind, display_name, sort_name, created_at, updated_at)
         VALUES (?, 'person', 'Uma', 'Uma', '2026-01-01T00:00:00.000Z',
                 '2026-01-01T00:00:00.000Z')`
      )
      .run(uma);

    const refused = grant({ audience_id: uma }) as {
      status: string;
      reason?: string;
    };
    expect(refused.status).toBe("failed");
    expect(refused.reason).toContain("Uma has no linked account");
    expect(
      db.vault
        .prepare(
          `SELECT count(*) AS n FROM share_authority WHERE principal_id = ?`
        )
        .get(uma)
    ).toMatchObject({ n: 0 });
  });

  test("a grant to a person whose link has ended says the link ended, not that they were never linked", () => {
    revokePartyVaultBinding(db.vault, {
      partyId: ravi,
      vaultId: "vault-ravi",
      revokedAt: "2026-02-01T00:00:00.000Z",
    });
    const refused = grant() as { status: string; reason?: string };
    expect(refused.status).toBe("failed");
    expect(refused.reason).toContain("the link to Ravi's vault has ended");
  });
});
