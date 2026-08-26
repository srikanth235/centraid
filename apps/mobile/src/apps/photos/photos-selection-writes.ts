// Selection-bar writes shared by every Photos shelf (v4 handoff §6). Same
// action string everywhere: one word, one write. SERIAL: each write awaits
// the previous — parallel races the replica queue and the optimistic overlay.

import { runSelectionBatch } from "@centraid/blueprints/apps/_shared/selection-engine";

import type {
  MobileReplicaSession,
  NativeWriteResult,
} from "../../lib/replica/native-session";
import type { PhotoAsset } from "./timeline-model";

/** In a vault, not only on the camera roll. Device-only rows have no vault write. */
export type VaultAsset = PhotoAsset & { assetId: string };

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
 * One favourite value for the whole selection, never a per-item toggle.
 * `on` is `false` only on the Favorites shelf (take these off this shelf).
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
      }),
    emit
  );
}

/** Trash vault rows only — never the device original. */
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
      }),
    emit
  );
}

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
      }),
    emit
  );
}

/**
 * Irreversible vault-row purge. Overlay is a `delete`, not a flag: the row
 * leaves the replica. Call after PhotoStateView confirmation; order is
 * `emptyTrashOrder` — the vault refuses to purge a source an edited copy still
 * names. Never touches the device original.
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
      }),
    emit
  );
}

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
      return session.write("photos", {
        action: "add-to-album",
        input: {
          album_id: albumId,
          asset_id: asset.assetId,
          position: position++,
        },
      });
    },
    emit
  );
}

/** Phone shelves are not wired to `kit/fetch-gate`; Download would no-op. */
export const NO_DOWNLOAD_REASON =
  "Downloading originals is not built for the phone yet.";
