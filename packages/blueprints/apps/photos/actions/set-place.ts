import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

/** The owner's override of the place linked from EXIF GPS at upload (#352).
 *  No app-plane command MINTS a place: point at an existing `core.place` row,
 *  or omit `place_id` to clear back to unknown. */
export default async function setPlace({ body, ctx }: HandlerArgs) {
  const input = actionInput(body);
  return runVaultAction(ctx, {
    command: "media.set_asset_place",
    input: {
      asset_id: String(input.asset_id ?? ""),
      ...(input.place_id != null && input.place_id !== ""
        ? { place_id: String(input.place_id) }
        : {}),
    },
  });
}
