// Locker's sealed SIDECARS ride the same one-shot permit as the item (#873).
// `locker_item_field.value_sealed`, the previous password in a revision, and
// `locker_item_passkey.private_key` are secrets that hang off an item, so the
// reveal gate is keyed on the locker SCHEMA, not on `locker.item` alone — and
// the permit a sidecar reveal spends is the OWNING item's.

import { beforeEach, describe, expect, test } from "vitest";

import { bootstrappedVault } from "@centraid/test-kit/vault";

import { bootstrapVault } from "../bootstrap.js";
import type { BootstrapResult } from "../bootstrap.js";
import { registerLockerCommands } from "../commands/locker.js";
import { openVaultDb } from "../db.js";
import type { VaultDb } from "../db.js";
import { nowIso } from "../ids.js";
import { createGateway } from "./gateway.js";
import type { Gateway } from "./gateway.js";
import type { Credential } from "./types.js";

let db: VaultDb;
let gw: Gateway;
let boot: BootstrapResult;
let owner: Credential;

const SECRET = "correct horse battery staple";

/** The failing reason, with the per-call receipt id stripped off. */
function refusal(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return (error as Error).message.replace(/^deny \(receipt [^)]+\): /u, "");
  }
  throw new Error("expected a refusal");
}

describe("locker sidecar reveal", () => {
  beforeEach(() => {
    ({ db, boot } = bootstrappedVault(
      { openVaultDb, bootstrapVault },
      { ownerName: "Priya" }
    ));
    gw = createGateway(db);
    registerLockerCommands(gw);
    owner = {
      kind: "device",
      deviceId: boot.deviceId,
      deviceKey: boot.deviceKey,
    };
  });

  function addLogin(password = "hunter2-Corr3ct"): string {
    const out = gw.invoke(owner, {
      command: "locker.add_item",
      input: {
        type: "login",
        title: "example.com",
        username: "priya",
        password,
        url: "https://example.com",
      },
    });
    expect(out.status).toBe("executed");
    return (out as { output: { item_id: string } }).output.item_id;
  }

  function addSealedField(itemId: string, value: string): string {
    const out = gw.invoke(owner, {
      command: "locker.set_field",
      input: {
        item_id: itemId,
        section: "",
        label: "Recovery code",
        kind: "sealed",
        value,
      },
    });
    expect(out.status).toBe("executed");
    return (out as { output: { field_id: string } }).output.field_id;
  }

  async function configure(): Promise<string> {
    const result = await gw.authenticateLocker({
      operation: "configure",
      secret: SECRET,
    });
    expect(result.ok).toBe(true);
    return result.sessionToken as string;
  }

  async function permitFor(
    sessionToken: string,
    itemId: string
  ): Promise<string> {
    const result = await gw.authenticateLocker({
      operation: "authorize-item",
      sessionToken,
      secret: SECRET,
      itemId,
    });
    expect(result.ok).toBe(true);
    return result.itemToken as string;
  }

  test("a sealed custom field reveals under the owning item's permit and receipts both ids", async () => {
    const itemId = addLogin();
    const fieldId = addSealedField(itemId, "recovery-c0de");
    const sessionToken = await configure();
    const itemToken = await permitFor(sessionToken, itemId);

    const revealed = gw.reveal(owner, {
      entity: "locker.item_field",
      entityId: fieldId,
      columns: ["value_sealed"],
      authentication: { sessionToken, itemToken },
    });
    expect(revealed.values.value_sealed).toBe("recovery-c0de");

    const receipt = db.audit
      .prepare(
        `SELECT object_type, object_id, decision, detail_json
           FROM access_receipt WHERE receipt_id = ?`
      )
      .get(revealed.receiptId) as {
      object_type: string;
      object_id: string;
      decision: string;
      detail_json: string;
    };
    expect(receipt.object_type).toBe("locker.item_field");
    expect(receipt.object_id).toBe(fieldId);
    expect(receipt.decision).toBe("allow");
    expect(JSON.parse(receipt.detail_json)).toMatchObject({
      columns: ["value_sealed"],
      itemId,
    });
    expect(receipt.detail_json).not.toContain("recovery-c0de");
  });

  test("a sidecar reveal without a permit refuses", async () => {
    const itemId = addLogin();
    const fieldId = addSealedField(itemId, "recovery-c0de");
    await configure();

    expect(() =>
      gw.reveal(owner, {
        entity: "locker.item_field",
        entityId: fieldId,
        columns: ["value_sealed"],
      })
    ).toThrow(/locked/u);
  });

  test("a permit spent by a field reveal is spent for the whole item", async () => {
    const itemId = addLogin("hunter2-Corr3ct");
    const fieldId = addSealedField(itemId, "recovery-c0de");
    const sessionToken = await configure();
    const itemToken = await permitFor(sessionToken, itemId);

    gw.reveal(owner, {
      entity: "locker.item_field",
      entityId: fieldId,
      columns: ["value_sealed"],
      authentication: { sessionToken, itemToken },
    });
    // One-shot: the same token no longer opens the item itself…
    expect(() =>
      gw.reveal(owner, {
        entity: "locker.item",
        entityId: itemId,
        columns: ["password"],
        authentication: { sessionToken, itemToken },
      })
    ).toThrow(/authorization expired/u);
    // …nor the field again.
    expect(() =>
      gw.reveal(owner, {
        entity: "locker.item_field",
        entityId: fieldId,
        columns: ["value_sealed"],
        authentication: { sessionToken, itemToken },
      })
    ).toThrow(/authorization expired/u);
  });

  test("another item's permit never opens this item's sidecar", async () => {
    const itemId = addLogin();
    const fieldId = addSealedField(itemId, "recovery-c0de");
    const otherId = addLogin("other-p4ssword");
    const sessionToken = await configure();
    const otherToken = await permitFor(sessionToken, otherId);

    expect(() =>
      gw.reveal(owner, {
        entity: "locker.item_field",
        entityId: fieldId,
        columns: ["value_sealed"],
        authentication: { sessionToken, itemToken: otherToken },
      })
    ).toThrow(/authorization expired/u);
  });

  test("a nonexistent sidecar row refuses exactly as an existing one without a permit (no oracle)", async () => {
    const itemId = addLogin();
    const fieldId = addSealedField(itemId, "recovery-c0de");
    await configure();

    const missing = refusal(() =>
      gw.reveal(owner, {
        entity: "locker.item_field",
        entityId: "no-such-field",
        columns: ["value_sealed"],
      })
    );
    const present = refusal(() =>
      gw.reveal(owner, {
        entity: "locker.item_field",
        entityId: fieldId,
        columns: ["value_sealed"],
      })
    );
    expect(missing).toBe(present);
  });

  test("with no authentication configured a nonexistent sidecar row refuses like a missing item", () => {
    const missingField = refusal(() =>
      gw.reveal(owner, {
        entity: "locker.item_field",
        entityId: "no-such-field",
        columns: ["value_sealed"],
      })
    );
    const missingItem = refusal(() =>
      gw.reveal(owner, {
        entity: "locker.item",
        entityId: "no-such-item",
        columns: ["password"],
      })
    );
    expect(missingField).toBe(
      "no revealable locker.item_field row no-such-field"
    );
    expect(missingItem).toBe("no revealable locker.item row no-such-item");
  });

  test("a trashed item's sidecars stop revealing, permit or not", async () => {
    const itemId = addLogin();
    const fieldId = addSealedField(itemId, "recovery-c0de");
    const trashed = gw.invoke(owner, {
      command: "locker.trash_item",
      input: { item_id: itemId },
    });
    expect(trashed.status).toBe("executed");

    expect(
      refusal(() =>
        gw.reveal(owner, {
          entity: "locker.item_field",
          entityId: fieldId,
          columns: ["value_sealed"],
        })
      )
    ).toBe(`no revealable locker.item_field row ${fieldId}`);

    const sessionToken = await configure();
    const itemToken = await permitFor(sessionToken, itemId);
    expect(() =>
      gw.reveal(owner, {
        entity: "locker.item_field",
        entityId: fieldId,
        columns: ["value_sealed"],
        authentication: { sessionToken, itemToken },
      })
    ).toThrow(/authorization expired/u);
  });

  // HISTORY IS REVISIONS (#916, D2): `locker_item_history` was a second
  // revision mechanism, so its `password` cell was a second sealed surface
  // with its own reveal path. The previous password rides a
  // `core_entity_revision` snapshot of the item row — ciphertext under the
  // ITEM's additional data — and `locker.export` is what unseals it, under the
  // export's own confirmation, rather than a per-row reveal.
  test("the previous password survives a rotation as sealed ciphertext", () => {
    const itemId = addLogin("first-p4ssword");
    const edited = gw.invoke(owner, {
      command: "locker.edit_item",
      input: { item_id: itemId, password: "second-p4ssword" },
    });
    expect(edited.status).toBe("executed");
    const revision = db.vault
      .prepare(
        `SELECT snapshot_json FROM core_entity_revision
          WHERE entity_type = 'locker.item' AND entity_id = ?
          ORDER BY recorded_at DESC LIMIT 1`
      )
      .get(itemId) as { snapshot_json: string } | undefined;
    expect(revision).toBeDefined();
    const snapshot = JSON.parse(revision!.snapshot_json) as {
      password?: string;
    };
    expect(snapshot.password).toBeTypeOf("string");
    // Sealed at rest: the history of a secret is as much a secret as the
    // current value.
    expect(snapshot.password).not.toContain("first-p4ssword");
  });

  test("a passkey private key reveals under the item's own permit", async () => {
    const itemId = addLogin();
    const stored = gw.invoke(owner, {
      command: "locker.set_passkey",
      input: {
        item_id: itemId,
        rp_id: "example.com",
        private_key: "pk-material-xyz",
      },
    });
    expect(stored.status).toBe("executed");

    const sessionToken = await configure();
    const itemToken = await permitFor(sessionToken, itemId);
    const revealed = gw.reveal(owner, {
      entity: "locker.item_passkey",
      entityId: itemId,
      columns: ["private_key"],
      authentication: { sessionToken, itemToken },
    });
    expect(revealed.values.private_key).toBe("pk-material-xyz");
    // The passkey's PK IS the item, so no separate item id is receipted.
    const detail = db.audit
      .prepare("SELECT detail_json FROM access_receipt WHERE receipt_id = ?")
      .get(revealed.receiptId) as { detail_json: string };
    expect(JSON.parse(detail.detail_json)).toStrictEqual({
      columns: ["private_key"],
    });
  });

  test("entities outside the locker schema are untouched by the Locker gate", async () => {
    db.vault
      .prepare(
        `INSERT INTO sync_connection
           (connection_id, kind, label, status, trust, created_at)
         VALUES (?, 'imap', 'Mailbox', 'active', 'staged', ?)`
      )
      .run("conn-1", nowIso());
    db.vault
      .prepare(
        `INSERT INTO sync_connection_credential
           (connection_id, cred_kind, api_key, allowed_hosts, updated_at)
         VALUES (?, 'api_key', ?, '[]', ?)`
      )
      .run("conn-1", "ak-live-123", nowIso());
    // Locker is configured and holds no permit: a locker.* reveal would refuse.
    await configure();

    const revealed = gw.reveal(owner, {
      entity: "sync.connection_credential",
      entityId: "conn-1",
      columns: ["api_key"],
    });
    expect(revealed.values.api_key).toBe("ak-live-123");
  });
});
