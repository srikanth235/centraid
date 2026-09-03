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
  "alias",
] as const;

export default async function addItem({ body, ctx }: HandlerArgs) {
  const input = actionInput(body);
  const cmdInput: Record<string, unknown> = {
    type: String(input.type ?? ""),
    title: String(input.title ?? ""),
  };
  if (Array.isArray(input.tags)) cmdInput.tags = input.tags.map(String);
  if (input.url_match_policy != null)
    cmdInput.url_match_policy = String(input.url_match_policy);
  for (const f of FIELDS)
    if (input[f] != null && input[f] !== "") cmdInput[f] = String(input[f]);
  return runVaultAction(ctx, {
    command: "locker.add_item",
    input: cmdInput,
  });
}
