// ONLINE-ONLY: `private_key` is key material and never enters the durable
// offline queue. Resending `«sealed»` keeps the stored key.

const METADATA = [
  "user_handle",
  "display_name",
  "credential_id",
  "algorithm",
] as const;

export default async function setPasskey({ body, ctx }: HandlerArgs) {
  const input = (body ?? {}) as Record<string, unknown>;
  const cmdInput: Record<string, unknown> = {
    item_id: String(input.item_id ?? ""),
    rp_id: String(input.rp_id ?? ""),
  };
  for (const key of METADATA) {
    if (input[key] != null) cmdInput[key] = String(input[key]);
  }
  if (input.private_key != null)
    cmdInput.private_key = String(input.private_key);
  try {
    const outcome = await ctx.vault.invoke({
      command: "locker.set_passkey",
      input: cmdInput,
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
