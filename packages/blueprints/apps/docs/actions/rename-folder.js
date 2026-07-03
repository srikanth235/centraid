/**
 * Rename a folder through core.rename_folder. The drive's top level (the
 * scheme's root concept) refuses. Risk low.
 *
 * @type {import('@centraid/openclaw-plugin').ActionHandler}
 */
export default async ({ body, ctx }) => {
  const input = body ?? {};
  try {
    const outcome = await ctx.vault.invoke({
      command: 'core.rename_folder',
      input: {
        folder_id: String(input.folder_id ?? ''),
        name: String(input.name ?? ''),
      },
      purpose: 'dpv:ServiceProvision',
    });
    return { status: 200, body: outcome };
  } catch (err) {
    return { status: 200, body: { status: 'denied', reason: err.message, code: err.code } };
  }
};
