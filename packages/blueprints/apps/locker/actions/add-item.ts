/**
 * Save a new item through locker.add_item. Forwards the type, title, tags and
 * whichever secret/plain fields the caller supplied; the vault command drops
 * any field that does not belong to the chosen type, so nothing is smuggled
 * in. Risk low.
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
  const cmdInput: Record<string, unknown> = {
    type: String(input.type ?? ''),
    title: String(input.title ?? ''),
  };
  if (Array.isArray(input.tags)) cmdInput.tags = input.tags.map(String);
  if (input.url_match_policy != null) cmdInput.url_match_policy = String(input.url_match_policy);
  for (const f of FIELDS) if (input[f] != null && input[f] !== '') cmdInput[f] = String(input[f]);
  try {
    const outcome = await ctx.vault.invoke({
      command: 'locker.add_item',
      input: cmdInput,
      purpose: 'dpv:ServiceProvision',
    });
    return { status: 200, body: outcome };
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return { status: 200, body: { status: 'denied', reason: e.message, code: e.code } };
  }
};
