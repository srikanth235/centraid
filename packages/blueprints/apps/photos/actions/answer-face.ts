/**
 * Answer face proposal #712 — sole Face-review write; answers `confirm`
 * (+`party_id`) / `reject` / `dismiss`, never confirm/reject.
 * @type {import('@centraid/server/engine').ActionHandler}
 */
export default async function answerFace({ body, ctx }: HandlerArgs) {
  const input = (body ?? {}) as Record<string, unknown>;
  const answer = String(input.answer ?? "");
  const partyId = input.party_id == null ? "" : String(input.party_id);
  try {
    const outcome = await ctx.vault.invoke({
      command: "media.answer_face_proposal",
      input: {
        region_id: String(input.region_id ?? ""),
        answer,
        ...(answer === "confirm" && partyId ? { party_id: partyId } : {}),
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
