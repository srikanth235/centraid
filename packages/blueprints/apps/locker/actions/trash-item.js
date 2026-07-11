/**
 * locker.trash_item — see app.json for the contract. A consent denial or a
 * precondition refusal comes back as a first-class outcome the app narrates.
 *
 * @type {import('@centraid/app-engine').ActionHandler}
 */
export default async ({ body, ctx }) => {
  const input = body ?? {};
  try {
    const outcome = await ctx.vault.invoke({
      command: 'locker.trash_item',
      input: { item_id: String(input.item_id ?? '') },
      purpose: 'dpv:ServiceProvision',
    });
    return { status: 200, body: outcome };
  } catch (err) {
    return { status: 200, body: { status: 'denied', reason: err.message, code: err.code } };
  }
};
