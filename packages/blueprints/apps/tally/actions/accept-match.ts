import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

/**
 * THE OWNER ACCEPTS A CROSS-SOURCE MATCH (#996, R20(c) / OQ-12).
 *
 * The answer is written as the vault's own judgment — one `same-as` edge
 * between two transactions, temporal and reversible through `core.unlink` —
 * and NOT as a merge. Nothing is deleted, no amount moves, and both statements
 * still say what they said; what changes is that this vault now knows the two
 * lines are one movement. An acceptance that destroyed one of the rows would
 * make the member's own bank statement unreconcilable against their vault.
 */
export default async function acceptMatch({ body, ctx }: HandlerArgs) {
  const input = actionInput(body);
  return runVaultAction(ctx, {
    command: "core.link_entities",
    input: {
      from_type: "core.transaction",
      from_id: String(input.left_txn_id ?? ""),
      to_type: "core.transaction",
      to_id: String(input.right_txn_id ?? ""),
      relation: "same-as",
    },
  });
}
