/**
 * A member names a place, through media.name_place (issue #816).
 *
 * The counterpart to `set-place.ts`, and the only door in this app that writes
 * a place row itself: that one points a photograph at a place, this one says
 * what the place is called. Until a member names it, a place minted from GPS
 * carries its own coordinate as a label and every surface phrases it as "A
 * place with no name yet" (place-phrase.ts) — this is how that ends.
 *
 * `kind` is optional and carries exactly one member declaration today: "this
 * is home", which is what anchors a relative phrase ("3.4 km NE of Home") on
 * every other place the vault cannot name.
 *
 * The name is the ONLY derived-data-free write here: the command refuses to
 * touch `address_json`, so a gazetteer's finding survives being renamed over.
 *
 * @type {import('@centraid/openclaw-plugin').ActionHandler}
 */
export default async function namePlace({ body, ctx }: HandlerArgs) {
  const input = (body ?? {}) as Record<string, unknown>;
  try {
    const outcome = await ctx.vault.invoke({
      command: "media.name_place",
      input: {
        place_id: String(input.place_id ?? ""),
        name: String(input.name ?? ""),
        ...(input.kind != null && input.kind !== ""
          ? { kind: String(input.kind) }
          : {}),
      },
      purpose: "dpv:ServiceProvision",
    });
    return { status: 200, body: outcome };
  } catch (error) {
    const e = error as { code?: string; message?: string };
    return {
      status: 200,
      body: { status: "denied", reason: e.message, code: e.code },
    };
  }
}
