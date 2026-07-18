/**
 * Rewrite an item's fields and tags through locker.edit_item. Forwards
 * item_id plus whichever fields the caller supplied; the command overwrites
 * only the columns the item's type owns and refuses a trashed item. Risk low.
 */

const FIELDS = [
  'username',
  'password',
  'url',
  'otp_seed',
  'notes',
  'cardholder',
  'card_number',
  'expiry',
  'cvv',
  'brand',
  'content',
  'fullname',
  'email',
  'phone',
  'address',
  'network',
] as const;

export default async ({ body, ctx }: HandlerArgs) => {
  const input = (body ?? {}) as Record<string, unknown>;
  const cmdInput: Record<string, unknown> = { item_id: String(input.item_id ?? '') };
  if (input.title != null) cmdInput.title = String(input.title);
  if (Array.isArray(input.tags)) cmdInput.tags = input.tags.map(String);
  for (const f of FIELDS) if (input[f] != null) cmdInput[f] = String(input[f]);
  try {
    const outcome = await ctx.vault.invoke({
      command: 'locker.edit_item',
      input: cmdInput,
      purpose: 'dpv:ServiceProvision',
    });
    return { status: 200, body: outcome };
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return { status: 200, body: { status: 'denied', reason: e.message, code: e.code } };
  }
};
