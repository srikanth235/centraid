// EVERY WRITE LOCKER ISSUES FROM THIS SEAT, and the door each one takes.
//
// TWO DOORS, AND WHICH ONE IS NOT A CHOICE MADE HERE. `writes.ts` builds the
// payload and stamps `onlineOnly` on exactly the two actions whose payload can
// carry a secret; this module hands the value to the native session, which
// refuses to enqueue anything so stamped (`native-session.ts` `postAction`).
// A secret therefore has no representation in the durable outbox at any layer:
// not as an intent, not as an optimistic row, not as a payload hash.
//
// The metadata acts — star, trash, restore — take the ORDINARY replica path
// and queue like any other write, which is the other half of the same rule
// (README-Locker §2, row "Writes").

import { SEALED, draftFrom } from "@centraid/blueprints/apps/locker/draft";
import {
  exportCsv,
  exportFileName,
} from "@centraid/blueprints/apps/locker/export-file";
import type { ExportPayload } from "@centraid/blueprints/apps/locker/export-file";
import {
  EDIT_CREATED,
  EDIT_SAVED,
  EXPORT_NOTHING,
  EXPORT_PARKED,
  EXPORT_WRITTEN,
  PURGED,
  RESTORED_WHOLE,
} from "@centraid/blueprints/apps/locker/route-copy";
import type { ItemDraftSeed } from "@centraid/blueprints/apps/locker/types";
import {
  STARRED,
  TRASHED,
  UNSTARRED,
} from "@centraid/blueprints/apps/locker/view-copy";
import {
  addItemWrite,
  editItemWrite,
  exportWrite,
  purgeWrite,
  restoreWrite,
  starWrite,
  trashWrite,
} from "@centraid/blueprints/apps/locker/writes";
import type { LockerWrite } from "@centraid/blueprints/apps/locker/writes";

import { postStatus } from "../../kit/components/status-line";
import {
  nativeWriteOutput,
  surfaceWriteFailure,
  surfaceWriteOutcome,
} from "../../kit/replica/write-outcome";
import type { MobileReplicaSession } from "../../lib/replica/native-session";
import { handOffLockerExport } from "./locker-files";
import { loadLockerItems } from "./locker-store";
import { seedFromEntry } from "./otpauth";

/**
 * A one-time-code field takes a seed OR an otpauth URI (`route-copy.ts`'s own
 * note says so), and the camera hands back a bare seed. Both are normalised
 * through the ONE grammar (`otpauth.ts`) before the payload is built, so a
 * pasted URI and a scanned square produce the same stored value. An entry the
 * grammar refuses is left exactly as the member typed it: the vault's own
 * validation is the honest place for that refusal, not a silent rewrite.
 */
function normalizeOtpSeed(seed: ItemDraftSeed): ItemDraftSeed {
  const entered = seed.fields.otp_seed;
  if (!entered || entered === SEALED) return seed;
  const parsed = seedFromEntry(entered);
  if (!parsed || parsed === entered) return seed;
  return { ...seed, fields: { ...seed.fields, otp_seed: parsed } };
}

/** The one door. `write.onlineOnly` travels with the payload rather than being
 *  decided at the call site, so a new secret-bearing action cannot be issued
 *  through the queue by a caller that forgot. */
async function issue(
  session: MobileReplicaSession | undefined,
  write: LockerWrite,
  executed: string
): Promise<boolean> {
  if (!session) {
    surfaceWriteFailure(
      new Error("This phone is not paired with a gateway."),
      "Not written"
    );
    return false;
  }
  try {
    const outcome = await session.write("locker", {
      action: write.action,
      input: write.input as never,
      ...(write.onlineOnly === true ? { onlineOnly: true } : {}),
    });
    const ok = surfaceWriteOutcome(outcome);
    if (ok) postStatus(executed);
    return ok;
  } catch (error) {
    surfaceWriteFailure(error, "Not written");
    return false;
  }
}

/** Create or rewrite an item. ONLINE ONLY — `writes.ts` says so, and the
 *  session's online-only door is what enforces it. */
export async function saveLockerItem(
  session: MobileReplicaSession | undefined,
  seed: ItemDraftSeed
): Promise<boolean> {
  const draft = draftFrom(normalizeOtpSeed(seed));
  const write =
    seed.mode === "edit" && seed.itemId
      ? editItemWrite({ ...draft, itemId: seed.itemId })
      : addItemWrite(draft);
  const ok = await issue(
    session,
    write,
    seed.mode === "edit" ? EDIT_SAVED : EDIT_CREATED
  );
  if (ok) await loadLockerItems();
  return ok;
}

/** The product-wide star. Metadata: it queues. */
export function starLockerItem(
  session: MobileReplicaSession | undefined,
  itemId: string,
  starred: boolean
): Promise<boolean> {
  return issue(
    session,
    starWrite(itemId, starred),
    starred ? UNSTARRED : STARRED
  );
}

/** Thirty days, with its star and its tags. Metadata: it queues. */
export function trashLockerItem(
  session: MobileReplicaSession | undefined,
  itemId: string
): Promise<boolean> {
  return issue(session, trashWrite(itemId), TRASHED);
}

/** The true reverse of a trash — the one act in this app that offers Undo. */
export function restoreLockerItem(
  session: MobileReplicaSession | undefined,
  itemId: string
): Promise<boolean> {
  return issue(session, restoreWrite(itemId), RESTORED_WHOLE);
}

/** Irreversible, confirmed, and PARKED OFF-OWNER by the vault itself — which
 *  is why the outcome is read from the write's own status rather than
 *  announced ahead of it (`surfaceWriteOutcome` publishes the parked reason,
 *  and `PURGED` is posted only where the vault actually did it). */
export function purgeLockerItem(
  session: MobileReplicaSession | undefined,
  itemId: string
): Promise<boolean> {
  return issue(session, purgeWrite(itemId), PURGED);
}

/**
 * THE ONE ACT THAT PRODUCES PLAINTEXT (README-Locker §6).
 *
 * It does not go through `issue` and the reason is not tidiness: `issue`
 * announces a generic outcome and throws the payload away, and this act's whole
 * point IS the payload. Its outcomes are §6's own three sentences — written,
 * parked, nothing came back — rather than the write grammar's.
 *
 * ONLINE-ONLY, and not by a decision made here: `exportWrite` stamps the flag
 * and the native session's online-only door is what refuses to enqueue it. A
 * mass reveal has no representation in the durable outbox at any layer.
 *
 * PARKED OFF-OWNER. The command parks a mass reveal asked for on a device that
 * is not the owner's, so the outcome is read from the write's own status and
 * narrated as a park — saying "written" would claim an act that did not run.
 *
 * The plaintext is never held: it is turned into bytes and handed to the system
 * sheet inside this call, and nothing keeps a reference to either.
 */
export async function exportLockerVault(
  session: MobileReplicaSession | undefined,
  options: { includeTrashed?: boolean; includeHistory?: boolean }
): Promise<void> {
  if (!session) {
    surfaceWriteFailure(
      new Error("This phone is not paired with a gateway."),
      "Not exported"
    );
    return;
  }
  const write = exportWrite(options);
  let outcome;
  try {
    outcome = await session.write("locker", {
      action: write.action,
      input: write.input as never,
      onlineOnly: true,
    });
  } catch (error) {
    surfaceWriteFailure(error, "Not exported");
    return;
  }
  const settled = nativeWriteOutput(outcome) as
    | { status?: string; reason?: string; output?: ExportPayload }
    | undefined;
  if (settled?.status === "parked") {
    postStatus(EXPORT_PARKED);
    return;
  }
  if (settled?.status === "denied") {
    surfaceWriteFailure(new Error(settled.reason ?? ""), "Not exported");
    return;
  }
  const payload = settled?.output;
  if (!payload?.items) {
    postStatus(EXPORT_NOTHING);
    return;
  }
  try {
    await handOffLockerExport(exportFileName(payload), exportCsv(payload));
  } catch (error) {
    surfaceWriteFailure(error, "Not exported");
    return;
  }
  postStatus(EXPORT_WRITTEN);
}
