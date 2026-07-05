/**
 * Save a new item through locker.add_item. Forwards the type, title, tags and
 * whichever secret/plain fields the caller supplied; the vault command drops
 * any field that does not belong to the chosen type, so nothing is smuggled
 * in. Risk low.
 *
 * @type {import('@centraid/openclaw-plugin').ActionHandler}
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
  const cmdInput = { type: String(input.type ?? ''), title: String(input.title ?? '') };
  if (Array.isArray(input.tags)) cmdInput.tags = input.tags.map(String);
  for (const f of FIELDS) if (input[f] != null && input[f] !== '') cmdInput[f] = String(input[f]);
  try {
    const outcome = await ctx.vault.invoke({
      command: 'locker.add_item',
      input: cmdInput,
      purpose: 'dpv:ServiceProvision',
    });
    return { status: 200, body: outcome };
  } catch (err) {
    return { status: 200, body: { status: 'denied', reason: err.message, code: err.code } };
  }
};
