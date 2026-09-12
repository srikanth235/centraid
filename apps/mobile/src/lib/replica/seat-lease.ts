// WHO IS ALLOWED TO OPEN THIS SEAT FILE RIGHT NOW (#1014, P1/C8).
//
// The background task opened a SECOND `SeatWorkerCore` and a second outbox
// over the file the foreground mount already held. On expo-sqlite that is not
// two connections at all — the module caches by database NAME — so the
// headless pass's `finally` closed the FOREGROUND's handle, and on resume every
// read, write, claim and `sync()` threw against a phone that still looked
// mounted, with no `mountKey` change to make it remount.
//
// TWO THINGS FIX IT AND BOTH ARE NEEDED. `useNewConnection: true` stops the
// two from being the same object; a LEASE stops them from being two writers on
// one file, which the outbox's read-modify-write and R24's in-transaction
// clear both assume they are not.
//
// THE LEASE IS A FILE BESIDE THE SEAT, NOT A ROW IN IT. The whole point is to
// decide BEFORE opening the database — a background pass that has to open the
// file to learn it may not open the file has already done the damage — and a
// sidecar is the only place a phone can read without SQLite.
//
// AND IT EXPIRES. A process killed by the OS mid-pass never releases anything,
// so an owner id alone would strand a vault for good. The holder writes an
// expiry and renews it as it works; a lease whose expiry has passed is dead and
// the next asker takes it. The window is chosen to be much longer than a
// foreground gap between syncs and much shorter than a member's patience.

import { File } from "expo-file-system";

import { pathToFileUri } from "../../../modules/centraid-storage";

/** How long a lease stands without a renewal. */
export const SEAT_LEASE_TTL_MS = 5 * 60_000;

export interface SeatLease {
  /** Push the expiry out. Cheap enough to call on every pass. */
  renew: () => void;
  /** Give the file up. Idempotent. */
  release: () => void;
}

interface LeaseFile {
  readonly owner: string;
  readonly expiresAt: number;
}

function leaseFile(databasePath: string): File {
  return new File(pathToFileUri(`${databasePath}.lease.json`));
}

function readLease(file: File): LeaseFile | undefined {
  try {
    if (!file.exists) return undefined;
    const held = JSON.parse(file.textSync()) as Partial<LeaseFile>;
    if (typeof held.owner !== "string" || typeof held.expiresAt !== "number")
      return undefined;
    return { owner: held.owner, expiresAt: held.expiresAt };
  } catch {
    // An unreadable lease is no lease: refusing to open a seat because a
    // scratch file is corrupt would turn a stale lock into a lost vault.
    return undefined;
  }
}

function writeLease(file: File, lease: LeaseFile): void {
  if (!file.exists) file.create({ intermediates: true });
  file.write(JSON.stringify(lease));
}

/** What is holding this seat, or undefined when nothing live is. */
export function seatLeaseHolder(
  databasePath: string,
  now = Date.now()
): string | undefined {
  const held = readLease(leaseFile(databasePath));
  return held && held.expiresAt > now ? held.owner : undefined;
}

/**
 * Take the lease, or answer undefined because someone live holds it.
 *
 * `owner` is the caller's name for itself ("foreground", "background"). The
 * SAME owner re-taking its own lease succeeds: a foreground mount that
 * re-opens after a crash is the holder, not a rival, and making it wait out
 * its own stale expiry would leave a phone unable to open its own vault.
 */
export function acquireSeatLease(
  databasePath: string,
  owner: string,
  ttlMs = SEAT_LEASE_TTL_MS
): SeatLease | undefined {
  const file = leaseFile(databasePath);
  const held = readLease(file);
  if (held && held.owner !== owner && held.expiresAt > Date.now())
    return undefined;
  let released = false;
  const stamp = (): void => {
    if (released) return;
    try {
      writeLease(file, { owner, expiresAt: Date.now() + ttlMs });
    } catch {
      // A lease that cannot be written is a lease nobody else can see. The
      // seat still opens: this coordinates two openers, it does not authorise
      // one, and refusing here would make an unwritable directory a vault the
      // member cannot reach.
    }
  };
  stamp();
  return {
    renew: stamp,
    release: () => {
      released = true;
      try {
        // Only if it is still OURS: a lease that expired and was taken by the
        // background pass must not be deleted by the foreground's late close.
        const current = readLease(file);
        if (!current || current.owner === owner) {
          if (file.exists) file.delete();
        }
      } catch {
        // Nothing to do about a file the OS will not remove; it expires.
      }
    },
  };
}
