// ACCESS HISTORY AND IMPORT, ON THIS SEAT — the two surfaces whose read is a
// WORKFLOW rather than an item read, and which this phone can now perform.
//
// Both were drawn as facts plus a where-sentence while their doors lived on
// another seat. Both doors are reachable from here now, and they are reached
// the same way everything else in this app is: through `locker-gateway.ts`,
// never the replica. Neither read has any cached answer to fall back to, and
// neither must ever grow one —
//
//   * ACCESS is online-only by construction: `consent.receipt` lives in
//     journal.db, which the replica does not carry. A cached history would be a
//     list of what this device happened to hold, drawn as the whole record.
//   * IMPORT is online-only by construction: the payload is the member's file,
//     every secret in it, and a durable offline queue is exactly where that
//     must not sit.
//
// The state they fill is `locker-store.ts`'s, written through the one narrow
// seam it exposes, so a lock takes both with it — the entries and the staged
// rows through the SHARED bag's own `wipeSecretState`, the rest through the
// companion reset beside it. Nothing here restates the session machine, the
// permit arithmetic or the wipe.
//
// AND NEITHER SURFACE INVENTS A ROW. A refusal is not an empty history and a
// draft that parsed nothing is not a draft with nothing to publish; each is
// stated as itself.

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

/** Re-emit the store with the bag's own mutation visible, the way every other
 *  bag write in this seat does it (`locker-store.ts` `searchLocker`). */
function emitBag(patch: Parameters<typeof setLockerSurfaceState>[0]): void {
  setLockerSurfaceState({ ...patch, bag: { ...readLockerVault().bag } });
}

// ─── Access history ─────────────────────────────────────────────────────────

/**
 * Read the receipts this session may see.
 *
 * THREE ANSWERS, NEVER ONE EMPTINESS. A landed read fills the list — which may
 * legitimately be empty, and says so as day one. An authentication refusal is
 * the session being gone, so it locks rather than blanking a screen behind a
 * live-looking frame. Anything else leaves the list `null` and states the
 * refusal, because "we could not read the ledger" and "the ledger is empty" are
 * the two sentences an audit surface may never confuse.
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

// ─── Import ─────────────────────────────────────────────────────────────────

/** The drafts waiting, newest first. `draftBatches` is the shared narrowing —
 *  a published or discarded batch is history, not a review. */
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

/**
 * Pick one file and stage it as a draft.
 *
 * NOTHING REACHES THE VAULT HERE. A staged batch is a draft the member reviews;
 * publishing it is a second, explicit act. A cancel says nothing — the member
 * closed the sheet — and the two file refusals (too large, unreadable) say what
 * they are, in this seat's own words, because both are facts about a phone.
 *
 * A file the border recognised nothing in still stages a draft, and that draft
 * is a refusal rather than an empty review: it is named as one and left for the
 * member to discard.
 */
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

/** Open one draft for review. The rows are dispositions and column mappings —
 *  a staged row carries no value — and they land in the bag beside the access
 *  entries so a lock takes them too. */
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

/** Apply the open draft. THE VAULT WINS: a row whose secret the vault already
 *  holds comes back `skipped`, and `publishedCopy` says so in the register's
 *  own words rather than reporting it as a success. */
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

/** Drop the open draft. Nothing was ever in the vault, so the sentence says
 *  nothing was written rather than naming an undo. */
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
