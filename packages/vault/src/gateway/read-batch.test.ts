// Gateway.readBatch (#916). A gateway read is a WRITER: it appends an
// access.receipt, and SQLite commits every one of them on its own — so a
// background scan that reads five entities pays five fsyncs and five copies of
// the same b-tree leaf pages in the WAL. `readBatch` puts the scan's reads in
// one transaction so the SAME receipts land in one commit. These tests pin the
// three properties that make that safe: the receipts are all still there, a
// refusal's receipt survives the throw that follows it, and the batch refuses
// to nest inside an open transaction rather than corrupting one.

import { beforeEach, describe, expect, test } from "vitest";

import { bootstrappedVault } from "@centraid/test-kit/vault";

import { bootstrapVault } from "../bootstrap.js";
import type { BootstrapResult } from "../bootstrap.js";
import { openVaultDb } from "../db.js";
import type { VaultDb } from "../db.js";
import type { Gateway } from "./gateway.js";
import { createGateway } from "./gateway.js";
import { GatewayError } from "./types.js";
import type { Credential } from "./types.js";

let db: VaultDb;
let gw: Gateway;
let boot: BootstrapResult;
let owner: Credential;

const PURPOSE = "dpv:ServiceProvision";

function receiptCount(): number {
  return (
    db.vault.prepare("SELECT COUNT(*) AS n FROM access_receipt").get() as {
      n: number;
    }
  ).n;
}

describe("gateway read batch", () => {
  beforeEach(() => {
    ({ db, boot } = bootstrappedVault(
      { openVaultDb, bootstrapVault },
      { ownerName: "Priya" }
    ));
    gw = createGateway(db);
    owner = {
      kind: "device",
      deviceId: boot.deviceId,
      deviceKey: boot.deviceKey,
    };
  });

  test("every read inside the batch still leaves its own receipt", () => {
    const before = receiptCount();
    const rows = gw.readBatch(() => [
      gw.read(owner, { entity: "schedule.task", purpose: PURPOSE }).rows.length,
      gw.read(owner, { entity: "core.event", purpose: PURPOSE }).rows.length,
      gw.read(owner, { entity: "core.party", purpose: PURPOSE }).rows.length,
    ]);
    expect(rows).toHaveLength(3);
    expect(receiptCount()).toBe(before + 3);
    // Committed, not merely pending: the batch leaves no open transaction.
    expect(db.vault.isTransaction).toBe(false);
  });

  test("a refusal inside the batch keeps its deny receipt", () => {
    const before = receiptCount();
    expect(() =>
      gw.readBatch(() => {
        gw.read(owner, { entity: "schedule.task", purpose: PURPOSE });
        return gw.read(owner, { entity: "no.such_entity", purpose: PURPOSE });
      })
    ).toThrow(GatewayError);
    // The allow receipt AND the deny receipt the refusal wrote — rolling the
    // batch back would destroy exactly the evidence the deny exists to leave.
    expect(receiptCount()).toBe(before + 2);
    expect(db.vault.isTransaction).toBe(false);
    const last = db.vault
      .prepare(
        "SELECT decision, object_type FROM access_receipt ORDER BY seq DESC LIMIT 1"
      )
      .get() as { decision: string; object_type: string };
    expect(last).toMatchObject({
      decision: "deny",
      object_type: "no.such_entity",
    });
  });

  test("the batch refuses to nest rather than commit someone else's work", () => {
    expect(() => gw.readBatch(() => gw.readBatch(() => 1))).toThrow(
      /cannot nest/u
    );
    // The outer batch still closes cleanly after the inner one refused.
    expect(db.vault.isTransaction).toBe(false);
  });
});
