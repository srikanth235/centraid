import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

/**
 * ALREADY-TRASHED assets only (#711), and no undo: the asset row, faces,
 * tags, album membership and annotations go now, and the bytes go to the
 * gateway's next storage sweep. An asset an edited copy still points at is
 * refused — the copy goes first, so its record of origin never becomes a lie.
 */
export default async function purgeAsset({ body, ctx }: HandlerArgs) {
  const input = actionInput(body);
  return runVaultAction(ctx, {
    command: "media.purge_asset",
    input: { asset_id: String(input.asset_id ?? "") },
  });
}
