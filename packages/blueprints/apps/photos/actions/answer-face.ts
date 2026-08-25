/**
 * Answer one face proposal (#712) — the app-plane half of
 * `media.answer_face_proposal`, and the ONLY write behind the Face review
 * queue on every surface (the review screen, the lightbox's mini-loop, and
 * the native twin).
 *
 * ONE WRITE, THREE ANSWERS, never a confirm/reject pair: a confirm that
 * demanded a person leaves "reviewed and deliberately left unnamed" nowhere to
 * go, and a reject that DELETED the row leaves nothing remembering that the
 * owner said no — between them they cannot finish a queue. See the vault
 * command's own header for the full account.
 *
 * The three answers are the discriminant, not three endpoints:
 *   - `confirm` — this is that person. Carries `party_id`.
 *   - `reject`  — not this person, and do not ask again.
 *   - `dismiss` — reviewed; keep the face, leave it unnamed.
 *
 * Risk low, like everything else in this loop: it curates DERIVED data.
 *
 * @type {import('@centraid/server/engine').ActionHandler}
 */
export default async function answerFace({ body, ctx }: HandlerArgs) {
  const input = (body ?? {}) as Record<string, unknown>;
  const answer = String(input.answer ?? "");
  // `party_id` is passed ONLY for a confirm: the vault refuses a reject or
  // dismiss that names one (its `answer_names_a_party_iff_confirm`
  // precondition), because a party on an answered-but-not-confirmed region
  // would keep that person counting a face they were never confirmed on.
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
