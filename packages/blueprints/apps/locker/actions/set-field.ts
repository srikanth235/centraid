import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

/**
 * One field per call, not a list: only a TOP-LEVEL command input is hashed out
 * of the append-only journal by the vault's `sealedInput` redaction, so a list
 * would carry sealed values into the journal in the clear. Online-only: the
 * payload can carry a secret, and a secret never enters the offline queue.
 */

export default async function setField({ body, ctx }: HandlerArgs) {
  const input = actionInput(body);
  const cmdInput: Record<string, unknown> = {
    item_id: String(input.item_id ?? ""),
    label: String(input.label ?? ""),
    kind: String(input.kind ?? "text"),
  };
  if (input.field_id != null) cmdInput.field_id = String(input.field_id);
  if (input.section != null) cmdInput.section = String(input.section);
  if (input.value != null) cmdInput.value = String(input.value);
  if (input.position != null) cmdInput.position = Number(input.position);
  return runVaultAction(ctx, {
    command: "locker.set_field",
    input: cmdInput,
  });
}
