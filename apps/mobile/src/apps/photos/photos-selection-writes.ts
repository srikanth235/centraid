// The writes the selection bar's targets fire (v4 handoff §6).
//
// One implementation, shared by every Photos shelf, for the reason the bar
// itself is shared: `Favorite` on the Duplicates shelf and `Favorite` on an
// album must be the same write, or the same word means two things. Each of
// these is the SAME action string the screens already used one at a time —
// `update-asset`, `delete-asset`, `restore` — applied over a selection.
//
// SERIAL BY CONTRACT. Every loop here awaits the previous write. The replica
// session queues intents per vault and the optimistic rows are read back by
// the next iteration; parallel writes race both, and the ledger loses the
// member's own order. This is the same rule `PhotosHome`'s add-to-album loop
// and `PhotoStateView`'s restore loop already followed.

import { runSelectionBatch } from "@centraid/blueprints/apps/_shared/selection-engine";

import type { MultiVaultReplicaSession } from "../../lib/replica/multi-vault-session";
import type {
  MobileReplicaSession,
  NativeWriteResult,
} from "../../lib/replica/native-session";
import { optimisticRowId } from "../../lib/replica/optimistic";
import type { PhotoAsset } from "./timeline-model";

/** An asset a write can name: one that exists in a vault, not only on the
 *  camera roll. Selecting a device-only photograph and asking the vault to
 *  favourite it is not a failure to report — there is nothing there yet. */
export type VaultAsset = PhotoAsset & { assetId: string };

/** A vault asset that also knows which vault it came from — what a placement
 *  needs, since a share moves a row FROM somewhere INTO somewhere. */
export function vaultAssets(
  assets: readonly PhotoAsset[],
  selection: ReadonlySet<string>
): VaultAsset[] {
  return assets.filter(
    (asset): asset is VaultAsset =>
      selection.has(asset.id) && Boolean(asset.assetId)
  );
}

type Emit = (result: NativeWriteResult) => void;

async function runSerially(
  targets: readonly VaultAsset[],
  write: (asset: VaultAsset) => Promise<NativeWriteResult>,
  emit: Emit
): Promise<void> {
  const results = await runSelectionBatch(targets, write);
  const failures: unknown[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") emit(result.value);
    else failures.push(result.reason);
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `${failures.length} selection write${failures.length === 1 ? "" : "s"} failed`
    );
  }
}

/**
 * Set the favourite flag on every selected photograph — one value for the
 * whole selection, never a per-item toggle: a bar that un-favourites half a
 * selection and favourites the other half is not one action.
 *
 * `on` is `false` only on the Favorites shelf, where the target can mean
 * exactly one thing (take these off this shelf) and where it replaces the
 * shelf's own former `Remove` control.
 */
export function batchFavorite(
  session: MobileReplicaSession,
  targets: readonly VaultAsset[],
  emit: Emit,
  on = true
): Promise<void> {
  return runSerially(
    targets,
    (asset) =>
      session.write("photos", {
        action: "update-asset",
        input: { asset_id: asset.assetId, favorite: on ? 1 : 0 },
        optimistic: [
          {
            op: "upsert",
            entity: "media.media_asset",
            rowId: asset.assetId,
            values: { favorite: on ? 1 : 0 },
          },
        ],
      }),
    emit
  );
}

/** Move every selected photograph to trash. The DEVICE original is never
 *  touched by this — only the vault's row is. */
export function batchTrash(
  session: MobileReplicaSession,
  targets: readonly VaultAsset[],
  emit: Emit
): Promise<void> {
  return runSerially(
    targets,
    (asset) =>
      session.write("photos", {
        action: "delete-asset",
        input: { asset_id: asset.assetId },
        optimistic: [
          {
            op: "upsert",
            entity: "media.media_asset",
            rowId: asset.assetId,
            values: { deleted_at: new Date().toISOString() },
          },
        ],
      }),
    emit
  );
}

/** Restore every selected photograph out of trash — back to the day it was
 *  taken (proto:4445), which is what clearing `deleted_at` means here. */
export function batchRestore(
  session: MobileReplicaSession,
  targets: readonly VaultAsset[],
  emit: Emit
): Promise<void> {
  return runSerially(
    targets,
    (asset) =>
      session.write("photos", {
        action: "restore",
        input: { asset_id: asset.assetId },
        optimistic: [
          {
            op: "upsert",
            entity: "media.media_asset",
            rowId: asset.assetId,
            values: { deleted_at: null, purge_at: null },
          },
        ],
      }),
    emit
  );
}

/**
 * Delete every photograph in `targets` FOREVER — the trash's own action, and
 * the only write in this app a member cannot take back. The optimistic overlay
 * is a `delete`, not a flag change, because that is what happens: the row
 * leaves the replica rather than gaining a state.
 *
 * The confirmation happens before this is called (PhotoStateView), and the
 * order is `emptyTrashOrder`'s (photos-trash.ts) — the vault refuses to purge
 * an asset an edited copy still names as its source.
 *
 * The DEVICE original is never touched by this either; only the vault's row is.
 */
export function batchPurge(
  session: MobileReplicaSession,
  targets: readonly VaultAsset[],
  emit: Emit
): Promise<void> {
  return runSerially(
    targets,
    (asset) =>
      session.write("photos", {
        action: "purge-asset",
        input: { asset_id: asset.assetId },
        optimistic: [
          {
            op: "delete",
            entity: "media.media_asset",
            rowId: asset.assetId,
          },
        ],
      }),
    emit
  );
}

/** Add every selected photograph to one album, keeping the member's order. */
export function batchAddToAlbum(
  session: MobileReplicaSession,
  targets: readonly VaultAsset[],
  albumId: string,
  firstPosition: number,
  emit: Emit
): Promise<void> {
  let position = firstPosition;
  return runSerially(
    targets,
    (asset) => {
      const entryId = optimisticRowId("album-entry");
      const values = {
        entry_id: entryId,
        collection_id: albumId,
        target_type: "media.media_asset",
        target_id: asset.assetId,
        position: position++,
        added_at: new Date().toISOString(),
      };
      return session.write("photos", {
        action: "add-to-album",
        input: { album_id: albumId, asset_id: asset.assetId },
        optimistic: [
          {
            op: "upsert",
            entity: "core.collection_entry",
            rowId: entryId,
            values,
          },
        ],
      });
    },
    emit
  );
}

/**
 * COPY TO ⟨VAULT⟩, for a selection (issue #726, P0).
 *
 * The destination arrives explicitly from the call site — one of the OTHER
 * mounted writable vaults, chosen at the moment of copying
 * (`use-copy-to-vault.ts`). There is no stored share-target pointer to
 * resolve any more, and no Photos "Sharing" place for the copy to land in:
 * the place is simply the vault the member named.
 *
 * A PLACEMENT, NOT A COPY. `kind: "add"` puts the SAME photograph in a second
 * place; minting a second asset would give the member two records to keep in
 * step. Serial for the same reason every other batch here is: the placement
 * outbox is a durable per-device queue and the member's order is part of what
 * it records.
 *
 * Offline is not a failure — `MultiVaultReplicaSession.place` enqueues into
 * `native_placement_outbox` and drains on reconnect — so a `queued` outcome is
 * reported as queued, never as an error.
 */
export interface VaultCopyOutcome {
  placed: number;
  queued: number;
  /** Placements the gateway refused, with its own reason for the first. */
  refused: string[];
}

export async function batchCopyToVault(
  // The PLACEMENT session, not the per-vault write session: this copy crosses
  // vaults, which is the one thing `MobileReplicaSession` deliberately cannot
  // express.
  session: MultiVaultReplicaSession,
  targets: readonly VaultAsset[],
  targetVaultId: string,
  fallbackSourceVaultId?: string
): Promise<VaultCopyOutcome> {
  const outcome: VaultCopyOutcome = {
    placed: 0,
    queued: 0,
    refused: [],
  };
  const results = await runSelectionBatch(targets, async (asset) => {
    const sourceVaultId = asset.sourceVaultId ?? fallbackSourceVaultId;
    // A row with no vault provenance cannot be placed FROM anywhere, and
    // guessing one would file the photograph out of a vault it never sat in.
    if (!sourceVaultId || sourceVaultId === targetVaultId) return null;
    return session.place({
      kind: "add",
      itemType: "media.media_asset",
      itemId: asset.assetId,
      sourceVaultId,
      targetVaultId,
    });
  });
  for (const result of results) {
    if (result.status === "rejected") {
      outcome.refused.push(
        result.reason instanceof Error
          ? result.reason.message
          : "the copy failed before the gateway answered"
      );
      continue;
    }
    const record = result.value;
    if (!record) continue;
    if (record.status === "executed") outcome.placed += 1;
    else if (record.status === "denied" || record.status === "failed")
      outcome.refused.push(record.reason ?? "the gateway refused the copy");
    else outcome.queued += 1;
  }
  return outcome;
}

/** The one line the status line shows after a copy. Determinate counts only. */
export function copyOutcomeMessage(
  outcome: VaultCopyOutcome,
  targetLabel: string
): string {
  const parts: string[] = [];
  if (outcome.placed > 0)
    parts.push(`${outcome.placed} copied into ${targetLabel}`);
  if (outcome.queued > 0)
    parts.push(`${outcome.queued} queued until the gateway reconnects`);
  if (outcome.refused.length > 0)
    parts.push(`${outcome.refused.length} refused: ${outcome.refused[0]}`);
  return parts.length > 0
    ? parts.join(" · ")
    : `Nothing to copy — these photographs are already in ${targetLabel}.`;
}

/**
 * Why `Download` cannot fire from a phone shelf today. Pulling originals back
 * out of the vault runs through the frame's metered-connection gate
 * (`kit/fetch-gate`), which no Photos shelf is wired to; saying so is the
 * honest answer, and a target that quietly did nothing was the defect.
 */
export const NO_DOWNLOAD_REASON =
  "Downloading originals is not built for the phone yet.";
