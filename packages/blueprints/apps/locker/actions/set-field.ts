/**
 * Create or rewrite ONE custom field on an item through locker.set_field
 * (GAPS §3.3 #2). One field per call, not a list: a `sealed` field's value is
 * a secret, and only a TOP-LEVEL command input is hashed out of the append-only
 * journal by the vault's `sealedInput` redaction. A list of fields would have
 * carried the member's secrets into the journal in the clear.
 *
 * ONLINE-ONLY for the same reason `add-item` and `edit-item` are: the payload
 * can carry a secret, and a secret never enters the durable offline queue.
 * Sending the vault's `«sealed»` placeholder back leaves the stored value
 * alone, so a member can rename a sealed field without re-typing it.
 */

export default async function setField({ body, ctx }: HandlerArgs) {
  const input = (body ?? {}) as Record<string, unknown>;
  const cmdInput: Record<string, unknown> = {
    item_id: String(input.item_id ?? ""),
    label: String(input.label ?? ""),
    kind: String(input.kind ?? "text"),
  };
  if (input.field_id != null) cmdInput.field_id = String(input.field_id);
  if (input.section != null) cmdInput.section = String(input.section);
  if (input.value != null) cmdInput.value = String(input.value);
  if (input.position != null) cmdInput.position = Number(input.position);
  try {
    const outcome = await ctx.vault.invoke({
      command: "locker.set_field",
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
