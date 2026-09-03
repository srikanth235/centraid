import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

const METADATA = [
  "user_handle",
  "display_name",
  "credential_id",
  "algorithm",
] as const;

export default async function setPasskey({ body, ctx }: HandlerArgs) {
  const input = actionInput(body);
  const cmdInput: Record<string, unknown> = {
    item_id: String(input.item_id ?? ""),
    rp_id: String(input.rp_id ?? ""),
  };
  for (const key of METADATA) {
    if (input[key] != null) cmdInput[key] = String(input[key]);
  }
  if (input.private_key != null)
    cmdInput.private_key = String(input.private_key);
  return runVaultAction(ctx, {
    command: "locker.set_passkey",
    input: cmdInput,
  });
}
