/**
 * Create a notebook through the vault's typed command. Sibling order is
 * assigned by the vault (end of the list); nesting via parent_notebook_id
 * is supported by the model but this app keeps its chips flat for now.
 *
 * @type {import('@centraid/openclaw-plugin').ActionHandler}
 */
export default async ({ body, ctx }) => {
  const input = body ?? {};
  try {
    const outcome = await ctx.vault.invoke({
      command: 'knowledge.create_notebook',
      input: {
        name: String(input.name ?? ''),
        ...(input.parent_notebook_id != null
          ? { parent_notebook_id: String(input.parent_notebook_id) }
          : {}),
      },
      purpose: 'dpv:ServiceProvision',
    });
    return { status: 200, body: outcome };
  } catch (err) {
    return { status: 200, body: { status: 'denied', reason: err.message, code: err.code } };
  }
};
