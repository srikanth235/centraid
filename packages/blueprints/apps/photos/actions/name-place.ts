import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

/**
 * Names a place (#816); the counterpart to `set-place.ts`, which points a
 * photograph at a place instead. Until a member names it, a place minted from
 * GPS carries its coordinate as a label and every surface phrases it as "A
 * place with no name yet" (place-phrase.ts).
 *
 * `kind` carries one member declaration today: "this is home", the anchor for
 * relative phrasing ("3.4 km NE of Home") on places the vault cannot name.
 *
 * The command refuses to touch `address_json`, so a gazetteer's finding
 * survives being renamed over.
 */
export default async function namePlace({ body, ctx }: HandlerArgs) {
  const input = actionInput(body);
  return runVaultAction(ctx, {
    command: "media.name_place",
    input: {
      place_id: String(input.place_id ?? ""),
      name: String(input.name ?? ""),
      ...(input.kind != null && input.kind !== ""
        ? { kind: String(input.kind) }
        : {}),
    },
  });
}
