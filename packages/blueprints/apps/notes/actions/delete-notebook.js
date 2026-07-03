/**
 * Delete a notebook through the vault's typed command. A notebook is pure
 * structure: member notes are unfiled, never destroyed — the outcome reports
 * notes_unfiled. The vault refuses while child notebooks exist, so the
 * hierarchy never dangles.
 *
 * @type {import('@centraid/openclaw-plugin').ActionHandler}
 */
export default async ({ body, ctx }) => {
  const input = body ?? {};
  try {
    const outcome = await ctx.vault.invoke({
      command: 'knowledge.delete_notebook',
      input: {
        notebook_id: String(input.notebook_id ?? ''),
      },
      purpose: 'dpv:ServiceProvision',
    });
    return { status: 200, body: outcome };
  } catch (err) {
    return { status: 200, body: { status: 'denied', reason: err.message, code: err.code } };
  }
};
