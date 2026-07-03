/**
 * Dispose an item through the vault's typed command. Disposal keeps the row —
 * disposed_on is stamped (defaulting to today) and the history stays; the
 * vault refuses a second disposal as a failed precondition.
 *
 * @type {import('@centraid/openclaw-plugin').ActionHandler}
 */
export default async ({ body, ctx }) => {
  const input = body ?? {};
  try {
    const outcome = await ctx.vault.invoke({
      command: 'home.dispose_item',
      input: {
        item_id: String(input.item_id ?? ''),
        ...(input.disposed_on != null ? { disposed_on: String(input.disposed_on) } : {}),
      },
      purpose: 'dpv:ServiceProvision',
    });
    return { status: 200, body: outcome };
  } catch (err) {
    return { status: 200, body: { status: 'denied', reason: err.message, code: err.code } };
  }
};
