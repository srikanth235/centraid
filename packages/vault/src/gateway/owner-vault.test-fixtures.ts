/**
 * ONE OWNER, ONE VAULT, ONE GATEWAY — the opening every gateway suite writes.
 *
 * Four suites under this directory had already copied the same nine lines of
 * imports and the same `beforeEach` that bootstraps a vault, wraps it in a
 * gateway and mints the owner's device credential. The repo's convention for
 * that is a `*.test-fixtures.ts` module (see `store-core.test-fixtures.ts`),
 * and this is it, so a suite added from here on states what it is ABOUT rather
 * than restating how a vault is opened.
 */
import { bootstrappedVault } from "@centraid/test-kit/vault";

import { bootstrapVault } from "../bootstrap.js";
import type { BootstrapResult } from "../bootstrap.js";
import { openVaultDb } from "../db.js";
import type { VaultDb } from "../db.js";
import { isSealedValue, sealAad, unsealValue } from "../schema/sealed.js";
import { createGateway } from "./gateway.js";
import type { Gateway } from "./gateway.js";
import type { Credential } from "./types.js";

export interface OwnerVault {
  db: VaultDb;
  gateway: Gateway;
  boot: BootstrapResult;
  /** The first device's key: the owner's credential. */
  owner: Credential;
}

export function openOwnerVault(ownerName = "Priya"): OwnerVault {
  const { db, boot } = bootstrappedVault(
    { openVaultDb, bootstrapVault },
    { ownerName }
  );
  return {
    db,
    boot,
    gateway: createGateway(db),
    owner: {
      kind: "device",
      deviceId: boot.deviceId,
      deviceKey: boot.deviceKey,
    },
  };
}

/**
 * Open one sealed cell directly, with the vault's own DEK.
 *
 * THE REPLACEMENT FOR `gw.reveal` ON A LOCKER ROW (#996, rulings R13 and
 * W6-D2). The door refuses the `locker` schema now — the key is on the seat —
 * but the properties the sealed-column class still owns are unchanged and
 * still need proving: that a rotation rewrote every cell, that a stale key
 * stops opening them, that a `«sealed»` round-trip did not overwrite the
 * secret, that a staged import published ciphertext rather than plaintext.
 *
 * Each of those is a claim about WHAT IS IN THE CELL, and asking the door was
 * only ever a convenient way to look. This looks directly, so the assertions
 * survive the door's refusal instead of being deleted with it.
 */
export function unsealCell(
  db: VaultDb,
  physical: string,
  column: string,
  rowId: string,
  key: Buffer = db.sealKey
): string | null {
  const pk = (
    db.vault
      .prepare(`PRAGMA table_info(${JSON.stringify(physical)})`)
      .all() as {
      name: string;
      pk: number;
    }[]
  ).find((c) => c.pk === 1)?.name;
  const row = db.vault
    .prepare(`SELECT "${column}" AS cell FROM "${physical}" WHERE "${pk}" = ?`)
    .get(rowId) as { cell: unknown } | undefined;
  const value = row?.cell;
  if (typeof value !== "string" || value === "") return null;
  if (!isSealedValue(value)) return value;
  return unsealValue(key, sealAad(physical, column, rowId), value);
}
