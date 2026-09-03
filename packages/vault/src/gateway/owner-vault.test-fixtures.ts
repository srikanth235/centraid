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
