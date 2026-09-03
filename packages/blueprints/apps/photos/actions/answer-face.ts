import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

export default async function answerFace({ body, ctx }: HandlerArgs) {
  const input = actionInput(body);
  const answer = String(input.answer ?? "");
  const partyId = input.party_id == null ? "" : String(input.party_id);
  return runVaultAction(ctx, {
    command: "media.answer_face_proposal",
    input: {
      region_id: String(input.region_id ?? ""),
      answer,
      ...(answer === "confirm" && partyId ? { party_id: partyId } : {}),
    },
  });
}
