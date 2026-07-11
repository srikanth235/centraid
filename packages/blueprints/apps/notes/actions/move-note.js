/**
 * Refile a note through the vault's typed command. One notebook per note in
 * v1: the vault replaces any existing placement. Omitting notebook_id
 * unfiles the note — moving out is as explicit an intent as moving in.
 *
 * @type {import('@centraid/app-engine').ActionHandler}
 */
export default async ({ body, ctx }) => {
  const input = body ?? {};
  try {
    const outcome = await ctx.vault.invoke({
      command: 'knowledge.move_note',
      input: {
        note_id: String(input.note_id ?? ''),
        ...(input.notebook_id != null ? { notebook_id: String(input.notebook_id) } : {}),
      },
      purpose: 'dpv:ServiceProvision',
    });
    return { status: 200, body: outcome };
  } catch (err) {
    return { status: 200, body: { status: 'denied', reason: err.message, code: err.code } };
  }
};
