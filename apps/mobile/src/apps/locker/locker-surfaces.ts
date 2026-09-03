// Two workflow reads, through `locker-gateway.ts`, never the replica. Neither
// may grow a cached answer; both write through the store's one seam, so a lock
// takes the entries and the staged rows with it via `wipeSecretState`.
import {
  draftBatches,
  publishedCopy,
} from "@centraid/blueprints/apps/locker/import-model";
import {
  IMPORT_DISCARDED,
  IMPORT_NO_ROWS,
  IMPORT_STAGED,
} from "@centraid/blueprints/apps/locker/route-copy";

import { pickLockerImportFile } from "./locker-files";
import {
  discardLockerImport,
  lockerAccess,
  lockerImportBatches,
  lockerImportRows,
  publishLockerImport,
  stageLockerImport,
} from "./locker-gateway";
import {
  loadLockerItems,
  lockNow,
  readLockerVault,
  setLockerSurfaceState,
} from "./locker-store";

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function emitBag(patch: Parameters<typeof setLockerSurfaceState>[0]): void {
  setLockerSurfaceState({ ...patch, bag: { ...readLockerVault().bag } });
}

/**
 * A refusal leaves the list `null` and states itself: "we could not read the
 * ledger" and "the ledger is empty" are two sentences an audit surface may
 * never confuse.
 */
export async function loadLockerAccess(): Promise<void> {
  const vault = readLockerVault();
  const token = vault.bag.sessionToken;
  if (!token) return;
  setLockerSurfaceState({ surfaceBusy: true, accessError: "" });
  try {
    const payload = await lockerAccess(token);
    if (payload.authRequired) {
      lockNow();
      return;
    }
    if (payload.vaultDenied) {
      readLockerVault().bag.accessEntries = null;
      emitBag({
        accessError:
          payload.vaultDenied.message ?? "The vault refused the receipts.",
        accessWindow: null,
        surfaceBusy: false,
      });
      return;
    }
    readLockerVault().bag.accessEntries = payload.entries ?? [];
    emitBag({
      accessError: "",
      accessWindow: {
        truncated: payload.truncated === true,
        window: payload.window ?? 0,
      },
      surfaceBusy: false,
    });
  } catch (error) {
    readLockerVault().bag.accessEntries = null;
    emitBag({
      accessError: message(error),
      accessWindow: null,
      surfaceBusy: false,
    });
  }
}

export async function loadLockerImportDrafts(): Promise<void> {
  setLockerSurfaceState({ surfaceBusy: true });
  try {
    const batches = await lockerImportBatches();
    setLockerSurfaceState({
      importBatches: draftBatches(batches),
      surfaceBusy: false,
    });
  } catch (error) {
    setLockerSurfaceState({
      importBatches: [],
      importNote: message(error),
      surfaceBusy: false,
    });
  }
}

export async function stageLockerImportFile(): Promise<void> {
  setLockerSurfaceState({ importNote: "", surfaceBusy: true });
  let picked: Awaited<ReturnType<typeof pickLockerImportFile>>;
  try {
    picked = await pickLockerImportFile();
  } catch (error) {
    setLockerSurfaceState({ importNote: message(error), surfaceBusy: false });
    return;
  }
  if (!picked) {
    setLockerSurfaceState({ surfaceBusy: false });
    return;
  }
  try {
    const staged = await stageLockerImport(picked);
    const rows = Object.values(staged.staged ?? {}).reduce(
      (sum, n) => sum + n,
      0
    );
    setLockerSurfaceState({
      importNote: rows === 0 ? IMPORT_NO_ROWS : IMPORT_STAGED,
      surfaceBusy: false,
    });
    await loadLockerImportDrafts();
    if (staged.batchId) await openLockerImportDraft(staged.batchId);
  } catch (error) {
    setLockerSurfaceState({ importNote: message(error), surfaceBusy: false });
  }
}

export async function openLockerImportDraft(batchId: string): Promise<void> {
  readLockerVault().bag.importRows = null;
  emitBag({ openBatchId: batchId, surfaceBusy: true });
  try {
    const rows = await lockerImportRows(batchId);
    readLockerVault().bag.importRows = rows;
    emitBag({ surfaceBusy: false });
  } catch (error) {
    emitBag({ importNote: message(error), surfaceBusy: false });
  }
}

export async function publishLockerImportDraft(batchId: string): Promise<void> {
  setLockerSurfaceState({ surfaceBusy: true });
  try {
    const result = await publishLockerImport(batchId);
    readLockerVault().bag.importRows = null;
    emitBag({
      importNote: publishedCopy(result),
      openBatchId: null,
      surfaceBusy: false,
    });
    await loadLockerImportDrafts();
    await loadLockerItems();
  } catch (error) {
    emitBag({ importNote: message(error), surfaceBusy: false });
  }
}

export async function discardLockerImportDraft(batchId: string): Promise<void> {
  setLockerSurfaceState({ surfaceBusy: true });
  try {
    await discardLockerImport(batchId);
    readLockerVault().bag.importRows = null;
    emitBag({
      importNote: IMPORT_DISCARDED,
      openBatchId: null,
      surfaceBusy: false,
    });
    await loadLockerImportDrafts();
  } catch (error) {
    emitBag({ importNote: message(error), surfaceBusy: false });
  }
}
