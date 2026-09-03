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

function normalizeOtpSeed(seed: ItemDraftSeed): ItemDraftSeed {
  const entered = seed.fields.otp_seed;
  if (!entered || entered === SEALED) return seed;
  const parsed = seedFromEntry(entered);
  if (!parsed || parsed === entered) return seed;
  return { ...seed, fields: { ...seed.fields, otp_seed: parsed } };
}

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

export function trashLockerItem(
  session: MobileReplicaSession | undefined,
  itemId: string
): Promise<boolean> {
  return issue(session, trashWrite(itemId), TRASHED);
}

export function restoreLockerItem(
  session: MobileReplicaSession | undefined,
  itemId: string
): Promise<boolean> {
  return issue(session, restoreWrite(itemId), RESTORED_WHOLE);
}

export function purgeLockerItem(
  session: MobileReplicaSession | undefined,
  itemId: string
): Promise<boolean> {
  return issue(session, purgeWrite(itemId), PURGED);
}

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
