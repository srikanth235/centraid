import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

/**
 * THE OWNER REJECTS A CROSS-SOURCE MATCH (#996, R20(c) / OQ-12).
 *
 * A refusal is written down for the same reason an acceptance is: a proposal
 * the member has already answered must not come back. `distinct-from` is a
 * judgment about two rows — "these two payments of the same amount are two
 * payments" — and it is the answer the matcher reads before proposing again.
 */
export default async function rejectMatch({ body, ctx }: HandlerArgs) {
  const input = actionInput(body);
  return runVaultAction(ctx, {
    command: "core.link_entities",
    input: {
      from_type: "core.transaction",
      from_id: String(input.left_txn_id ?? ""),
      to_type: "core.transaction",
      to_id: String(input.right_txn_id ?? ""),
      relation: "distinct-from",
    },
  });
}
