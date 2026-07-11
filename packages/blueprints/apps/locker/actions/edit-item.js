/**
 * Rewrite an item's fields and tags through locker.edit_item. Forwards
 * item_id plus whichever fields the caller supplied; the command overwrites
 * only the columns the item's type owns and refuses a trashed item. Risk low.
 *
 * @type {import('@centraid/app-engine').ActionHandler}
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
];

export default async ({ body, ctx }) => {
  const input = body ?? {};
  const cmdInput = { item_id: String(input.item_id ?? '') };
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
    return { status: 200, body: { status: 'denied', reason: err.message, code: err.code } };
  }
};
