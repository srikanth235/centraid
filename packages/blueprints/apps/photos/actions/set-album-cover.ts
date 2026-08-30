import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

/**
 * Choose an existing album member as its cover through media.set_album_cover.
 */
export default async function setAlbumCover({ body, ctx }: HandlerArgs) {
  const input = actionInput(body);
  return runVaultAction(ctx, {
    command: "media.set_album_cover",
    input: {
      album_id: String(input.album_id ?? ""),
      asset_id: String(input.asset_id ?? ""),
    },
  });
}
