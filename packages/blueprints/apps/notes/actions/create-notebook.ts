/**
 * Create a notebook through the vault's typed command. Sibling order is
 * assigned by the vault (end of the list); nesting via parent_notebook_id
 * is supported by the model but this app keeps its chips flat for now.
 */
export default async ({ body, ctx }: HandlerArgs) => {
  const input = (body ?? {}) as Record<string, unknown>;
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
    const e = err as { code?: string; message?: string };
    return { status: 200, body: { status: 'denied', reason: e.message, code: e.code } };
  }
};
