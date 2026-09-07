// THE GATEWAY DOES NOT UNSEAL A LOCKER ROW (#996, rulings R13 and W6-D2).
//
// This file used to prove the permit: a sealed sidecar spent its OWNING item's
// one-shot token, a second field could not reuse it, a trashed item's sidecars
// stopped revealing, and a nonexistent row refused exactly as an existing one
// without a permit so the sidecars were no existence oracle. Every one of
// those was a rule about who may make the GATEWAY produce plaintext.
//
// The gateway does not produce it any more. `K` is on the seat, a seat
// decrypts what it already holds behind its own unlock, and what reaches the
// gateway is the reveal receipt rather than a request for a value — so the
// permit's rules have nothing left to govern, and the property that replaces
// all of them is the one below: the door refuses the whole `locker` SCHEMA,
// with no argument that opens it.
//
// The reveal itself is proved where it happens now:
// `packages/client/src/locker/locker-secret.test.ts` (the envelope, held equal
// to `locker-key-plane.ts`'s by encrypting on one side and decrypting on the
// other) and `locker-kit-door.test.ts` (the door's refusals, and the receipt
// written before the plaintext).
//
// THE DOOR ITSELF STAYS, because it is not Locker's ([W6-D1]): the §293 sealed
// column class still carries `sync.connection_credential`'s broker tokens and
// the ext band's declared lists, and the broker must still inject a token it
// holds for the member. What is refused is the schema, not the mechanism —
// which is exactly what the last test here pins.

import { beforeEach, describe, expect, test } from "vitest";

import { bootstrappedVault } from "@centraid/test-kit/vault";

import { bootstrapVault } from "../bootstrap.js";
import type { BootstrapResult } from "../bootstrap.js";
import { registerLockerCommands } from "../commands/locker.js";
import { openVaultDb } from "../db.js";
import type { VaultDb } from "../db.js";
import { createGateway } from "./gateway.js";
import type { Gateway } from "./gateway.js";
import type { Credential } from "./types.js";

let db: VaultDb;
let gw: Gateway;
let boot: BootstrapResult;
let owner: Credential;

/** The failing reason, with the per-call receipt id stripped off. */
function refusal(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return (error as Error).message.replace(/^deny \(receipt [^)]+\): /u, "");
  }
  throw new Error("expected a refusal");
}

describe("the gateway does not unseal a Locker row", () => {
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

  test("the OWNER is refused — there is no credential that opens this door", () => {
    // The owner on their own device, with every scope, is the strongest
    // caller there is. If the answer were "it depends", the boundary would be
    // an authorization question again rather than a place the key is not.
    const itemId = addLogin();
    expect(
      refusal(() =>
        gw.reveal(owner, {
          entity: "locker.item",
          entityId: itemId,
          columns: ["password"],
        })
      )
    ).toContain("opened on the seat that holds the vault key");
  });

  test("a sealed sidecar is refused the same way as its item", () => {
    // The gate used to be keyed on the SCHEMA rather than on `locker.item`
    // alone, so that a sidecar could not slip past a rule written for the
    // item. The refusal keeps that shape for the same reason.
    const itemId = addLogin();
    const fieldId = addSealedField(itemId, "r3c0very-c0de");
    for (const request of [
      {
        entity: "locker.item_field",
        entityId: fieldId,
        columns: ["value_sealed"],
      },
      {
        entity: "locker.item_passkey",
        entityId: itemId,
        columns: ["private_key"],
      },
    ]) {
      expect(refusal(() => gw.reveal(owner, request))).toContain(
        "does not unseal locker rows"
      );
    }
  });

  test("a row that does not exist refuses identically — still no oracle", () => {
    // The old gate refused a missing sidecar exactly as it refused an existing
    // one without a permit, so the door could not be used to enumerate. The
    // refusal is now schema-wide and arrives BEFORE any row is read, which is
    // the same property with a shorter proof.
    const itemId = addLogin();
    const present = refusal(() =>
      gw.reveal(owner, {
        entity: "locker.item",
        entityId: itemId,
        columns: ["password"],
      })
    );
    const absent = refusal(() =>
      gw.reveal(owner, {
        entity: "locker.item",
        entityId: "01890000-0000-7000-8000-000000000000",
        columns: ["password"],
      })
    );
    expect(absent).toBe(present);
  });

  test("no plaintext reaches the caller, and the refusal is receipted", () => {
    const itemId = addLogin("k7Q-vn2-Rme");
    let thrown: Error | undefined;
    try {
      gw.reveal(owner, {
        entity: "locker.item",
        entityId: itemId,
        columns: ["password"],
      });
    } catch (error) {
      thrown = error as Error;
    }
    expect(thrown?.message).not.toContain("k7Q-vn2-Rme");
    // A refusal is receipted like an allowance — that was true of the permit
    // gate and stays true of the door.
    const receipt = db.audit
      .prepare(
        `SELECT decision, object_type FROM access_receipt
          WHERE action = 'reveal' ORDER BY seq DESC LIMIT 1`
      )
      .get() as { decision: string; object_type: string } | undefined;
    expect(receipt).toMatchObject({
      decision: "deny",
      object_type: "locker.item",
    });
  });

  test("entities OUTSIDE the locker schema still reveal (W6-D1)", () => {
    // The door is not Locker's. `sync.connection_credential` carries the
    // broker's tokens and the gateway must still be able to inject one, so
    // what the last commit refused is a schema and not a mechanism.
    const connectionId = "01890000-0000-7000-8000-00000000c001";
    db.vault
      .prepare(
        `INSERT INTO sync_connection (connection_id, kind, label, status, trust, created_at)
         VALUES (?, 'demo', 'Demo', 'active', 'staged', '2026-01-01T00:00:00.000Z')`
      )
      .run(connectionId);
    db.vault
      .prepare(
        `INSERT INTO sync_connection_credential
           (connection_id, cred_kind, access_token, allowed_hosts, updated_at)
         VALUES (?, 'api_key', 'plain-token', '[]', '2026-01-01T00:00:00.000Z')`
      )
      .run(connectionId);

    const revealed = gw.reveal(owner, {
      entity: "sync.connection_credential",
      entityId: connectionId,
      columns: ["access_token"],
    });
    expect(revealed.values["access_token"]).toBe("plain-token");
  });
});
