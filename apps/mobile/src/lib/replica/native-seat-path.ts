// WHERE THIS PHONE KEEPS A SEAT'S FILE (#996 wave 3).
//
// The name and nothing else, in a module with no native imports — because the
// MOUNT POLICY needs it (which vaults this phone holds, and how big each one
// is) and mount policy is answerable offline, in a node test, without
// expo-sqlite or expo-file-system in the graph.
//
// Namespaced by (gateway, vault): two vaults must not share a file, and the
// same vault on two gateways is two files.

import { replicaStorageKey } from "@centraid/client/replica/native";
import type { ReplicaDigest } from "@centraid/client/replica/native";

export interface SeatFileIdentity {
  readonly gatewayId: string;
  readonly vaultId: string;
  /** Hermes has no WebCrypto; the phone passes expo-crypto's. */
  readonly digest?: ReplicaDigest;
}

/** `centraid-seat-…`, the stem the seat's own worker parses back out. */
export async function nativeSeatDatabaseName(
  options: SeatFileIdentity
): Promise<string> {
  const stem = await replicaStorageKey(
    { gatewayId: options.gatewayId, vaultId: options.vaultId },
    options.digest
  );
  return `centraid-seat-${stem}.sqlite3`;
}

/** That name under this phone's durable directory. */
export async function nativeSeatDatabasePath(
  options: SeatFileIdentity,
  storageLocation: string
): Promise<string> {
  return `${storageLocation.replace(/\/+$/u, "")}/${await nativeSeatDatabaseName(options)}`;
}
