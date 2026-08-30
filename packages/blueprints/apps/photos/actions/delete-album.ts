import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

/** Only the album goes; its photos stay in the library. */
export default async function deleteAlbum({ body, ctx }: HandlerArgs) {
  const input = actionInput(body);
  return runVaultAction(ctx, {
    command: "media.delete_album",
    input: { album_id: String(input.album_id ?? "") },
  });
}
