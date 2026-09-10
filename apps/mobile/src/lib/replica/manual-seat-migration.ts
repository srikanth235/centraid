// THE SEAT FILE A `"manual"` MOUNT LEFT BEHIND (#1014, P14 / R-1014-11).
//
// Before this issue a mount with no gateway id named its file with the literal
// `"manual"` in place of one, and `noteActiveIdentity` rewrote the link the
// moment a real endpoint id arrived — which MOVED the path. The rows in the
// old file were recoverable (the gateway still has them); `seat_outbox` was
// not. Every write the member made before the gateway named itself sat in a
// file nothing would open again, undrained and unreported.
//
// The fallback is gone. This is what to do about the phones that already ran
// it: exactly once, when the real gateway id is first known, the file named
// `(manual, vaultId)` is renamed to `(gatewayId, vaultId)` — the outbox and
// the pins ride along, because they are IN that file. It is a rename, not a
// merge: if a file already stands at the new name it is the live seat and the
// old one is left where it is, visible to storage accounting (P6) rather than
// silently deleted with a member's queued writes inside it.

import { File } from "expo-file-system";

import type { ReplicaDigest } from "@centraid/client/replica/native";

import {
  pathToFileUri,
  replicaStorageDirectory,
} from "../../../modules/centraid-storage";
import { nativeSeatDatabaseName } from "./native-seat-path";

/** The id the old ladder fell through to. Frozen: it names files on disk. */
const RETIRED_MANUAL_GATEWAY_ID = "manual";

/** The seat file and every sidecar SQLite keeps beside it. */
const SQLITE_SIDECARS = ["", "-wal", "-shm", "-journal"] as const;

export interface ManualSeatMigration {
  readonly gatewayId: string;
  readonly vaultId: string;
  readonly digest?: ReplicaDigest;
  /** Injected by the suites; defaults to this phone's durable directory. */
  readonly storageLocation?: string;
}

/**
 * Rename this vault's `"manual"` seat file onto its real name.
 *
 * Returns what it did, so a caller can say it out loud: `"renamed"`,
 * `"absent"` (the ordinary case — no phone ever ran the fallback for this
 * vault) or `"blocked"` (a real seat already stands at the new name).
 */
export async function migrateManualSeatFiles(
  options: ManualSeatMigration
): Promise<"renamed" | "absent" | "blocked"> {
  const location = (options.storageLocation ?? replicaStorageDirectory() ?? "")
    .toString()
    .replace(/\/+$/u, "");
  if (location === "") return "absent";
  const [oldName, newName] = await Promise.all([
    nativeSeatDatabaseName({
      gatewayId: RETIRED_MANUAL_GATEWAY_ID,
      vaultId: options.vaultId,
      ...(options.digest ? { digest: options.digest } : {}),
    }),
    nativeSeatDatabaseName({
      gatewayId: options.gatewayId,
      vaultId: options.vaultId,
      ...(options.digest ? { digest: options.digest } : {}),
    }),
  ]);
  if (oldName === newName) return "absent";
  const held = (name: string): File =>
    new File(pathToFileUri(`${location}/${name}`));
  try {
    if (!held(oldName).exists) return "absent";
    // NEVER OVER A LIVE SEAT. A file at the new name is this vault's real
    // copy; overwriting it would destroy ITS outbox to rescue the other one.
    if (held(newName).exists) return "blocked";
    for (const suffix of SQLITE_SIDECARS) {
      const from = held(`${oldName}${suffix}`);
      if (!from.exists) continue;
      from.moveSync(new File(pathToFileUri(`${location}/${newName}${suffix}`)));
    }
    return "renamed";
  } catch {
    // A phone that cannot answer for its own directory keeps the old file:
    // "leave it where it is" is the only move that cannot lose an outbox.
    return "blocked";
  }
}
