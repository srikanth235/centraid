/**
 * THE UPLOAD LEDGER STRANDED AT A PERCENT-ENCODED PATH (#1014, R19).
 *
 * `ExpoSqliteDriver.open` used to hand expo-sqlite a plain filesystem PATH as
 * the database directory. On iOS that string is resolved with `URL(string:)`,
 * which parses a schemeless path as an opaque URL whose `absoluteString` is
 * the percent-ENCODED text — so a container path containing
 * `Library/Application Support` opened `Library/Application%20Support`, a real
 * directory the OS then created, one over from the durable one everything else
 * uses. Every upload queued through the encoded spelling was invisible to any
 * entry point that had opened the other, and vice versa.
 *
 * The driver now passes a `file://` URI. This module names the file the old
 * spelling left behind so the device wiring can move it back exactly once,
 * with its WAL sidecars: the queue is source-of-truth for unreplicated bytes,
 * so abandoning it would abandon uploads a member is still waiting on.
 *
 * Pure, so the rule is testable without a device.
 */

/** The sidecars SQLite keeps beside a WAL database; all three must travel. */
export const SQLITE_SIDECAR_SUFFIXES: readonly string[] = ["", "-wal", "-shm"];

export interface LegacyDatabaseMove {
  from: string;
  to: string;
}

/**
 * Where the encoded spelling of `location` put `name`, or `undefined` when the
 * two spellings agree (a path with nothing to escape, which is every Android
 * container and most simulators).
 */
export function legacyEncodedDatabaseDirectory(
  location: string
): string | undefined {
  const encoded = encodeURI(location);
  return encoded === location ? undefined : encoded;
}

/**
 * The files to move, in order. Empty when there is nothing to do — including
 * when the durable file ALREADY exists, because the ledger in the right place
 * is the one holding the rows this process is about to use, and overwriting it
 * with an older stranded copy would lose queued uploads rather than recover
 * them.
 */
export function planLegacyDatabaseMove(
  location: string,
  name: string,
  exists: (path: string) => boolean
): LegacyDatabaseMove[] {
  const legacy = legacyEncodedDatabaseDirectory(location);
  if (legacy === undefined) return [];
  if (exists(`${location}/${name}`)) return [];
  if (!exists(`${legacy}/${name}`)) return [];
  return SQLITE_SIDECAR_SUFFIXES.filter((suffix) =>
    exists(`${legacy}/${name}${suffix}`)
  ).map((suffix) => ({
    from: `${legacy}/${name}${suffix}`,
    to: `${location}/${name}${suffix}`,
  }));
}
