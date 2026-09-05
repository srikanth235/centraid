/**
 * The fixture the Locker #872 suites share. A module rather than a copy for
 * the AAD-aware unseal helper: every seal-boundary assertion decrypts a cell
 * with the AAD that cell must have been sealed under, which proves a copy or a
 * history append RESEALED rather than moved a ciphertext to a cell it no
 * longer belongs to.
 */

import { expect } from "vitest";

import { bootstrapVault } from "../bootstrap.js";
import { openVaultDb } from "../db.js";
import type { VaultDb } from "../db.js";
import { createGateway } from "../gateway/gateway.js";
import type { Gateway } from "../gateway/gateway.js";
import type { Credential, InvokeOutcome } from "../gateway/types.js";
import { isSealedValue, sealAad, unsealValue } from "../schema/sealed.js";
import { registerLockerCommands } from "./locker.js";

export interface LockerFixture {
  db: VaultDb;
  gw: Gateway;
  owner: Credential;
  invoke: (command: string, input: Record<string, unknown>) => InvokeOutcome;
  out: <T = Record<string, unknown>>(outcome: InvokeOutcome) => T;
  addLogin: (input?: Record<string, unknown>) => string;
  itemRow: (itemId: string) => Record<string, unknown>;
  count: (sql: string, ...params: string[]) => number;
  unsealCell: (
    physical: string,
    column: string,
    rowId: string,
    value: unknown
  ) => string;
}

export function lockerFixture(): LockerFixture {
  const db = openVaultDb();
  const boot = bootstrapVault(db, { ownerName: "Alex" });
  const gw = createGateway(db);
  registerLockerCommands(gw);
  const owner: Credential = {
    kind: "device",
    deviceId: boot.deviceId,
    deviceKey: boot.deviceKey,
  };
  const invoke = (
    command: string,
    input: Record<string, unknown>
  ): InvokeOutcome => gw.invoke(owner, { command, input });
  const out = <T = Record<string, unknown>>(outcome: InvokeOutcome): T => {
    expect(
      outcome.status,
      outcome.status === "executed" ? "" : JSON.stringify(outcome)
    ).toBe("executed");
    return (outcome as unknown as { output: T }).output;
  };
  return {
    db,
    gw,
    owner,
    invoke,
    out,
    addLogin: (input: Record<string, unknown> = {}) =>
      out<{ item_id: string }>(
        invoke("locker.add_item", {
          type: "login",
          title: "Email",
          username: "alex@example.test",
          password: "correct horse battery",
          ...input,
        })
      ).item_id,
    itemRow: (itemId: string) =>
      db.vault
        .prepare("SELECT * FROM locker_item WHERE item_id = ?")
        .get(itemId) as Record<string, unknown>,
    // SQLite rows are null-prototype, so counts are compared as numbers.
    count: (sql: string, ...params: string[]) =>
      Number((db.vault.prepare(sql).get(...params) as { n: number }).n),
    unsealCell: (
      physical: string,
      column: string,
      rowId: string,
      value: unknown
    ) => {
      expect(isSealedValue(value), `${physical}.${column} sealed at rest`).toBe(
        true
      );
      return unsealValue(
        db.sealKey,
        sealAad(physical, column, rowId),
        String(value)
      );
    },
  };
}
