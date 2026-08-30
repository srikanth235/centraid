import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

/**
 * Album entries and face regions go with it and covers hand off. The bytes
 * soft-delete only when nothing else references them, so re-uploading the
 * same file restores the photo.
 */
export default async function deleteAsset({ body, ctx }: HandlerArgs) {
  const input = actionInput(body);
  return runVaultAction(ctx, {
    command: "media.delete_asset",
    input: { asset_id: String(input.asset_id ?? "") },
  });
}
