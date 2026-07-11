/**
 * Rename a notebook through the vault's typed command. The vault refuses a
 * name already used by another of the owner's notebooks (two identically
 * named notebooks are indistinguishable in every filing UI); renaming a
 * notebook to its own name is an idempotent no-op.
 *
 * @type {import('@centraid/app-engine').ActionHandler}
 */
export default async ({ body, ctx }) => {
  const input = body ?? {};
  try {
    const outcome = await ctx.vault.invoke({
      command: 'knowledge.rename_notebook',
      input: {
        notebook_id: String(input.notebook_id ?? ''),
        name: String(input.name ?? ''),
      },
      purpose: 'dpv:ServiceProvision',
    });
    return { status: 200, body: outcome };
  } catch (err) {
    return { status: 200, body: { status: 'denied', reason: err.message, code: err.code } };
  }
};
