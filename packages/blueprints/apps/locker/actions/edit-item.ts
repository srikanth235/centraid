import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

const FIELDS = [
  "username",
  "password",
  "url",
  "otp_seed",
  "notes",
  "cardholder",
  "card_number",
  "expiry",
  "cvv",
  "brand",
  "content",
  "fullname",
  "email",
  "phone",
  "address",
  "network",
  // Connector alias (#298). Forwarded even as the empty string, which the
  // command reads as "clear the alias", freeing it for another live item.
  "alias",
] as const;

export default async function editItem({ body, ctx }: HandlerArgs) {
  const input = actionInput(body);
  const cmdInput: Record<string, unknown> = {
    item_id: String(input.item_id ?? ""),
  };
  if (input.title != null) cmdInput.title = String(input.title);
  if (Array.isArray(input.tags)) cmdInput.tags = input.tags.map(String);
  if (input.url_match_policy != null)
    cmdInput.url_match_policy = String(input.url_match_policy);
  for (const f of FIELDS) if (input[f] != null) cmdInput[f] = String(input[f]);
  return runVaultAction(ctx, {
    command: "locker.edit_item",
    input: cmdInput,
  });
}
