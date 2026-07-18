/**
 * Delete a folder through core.delete_folder. Only empty folders go — the
 * vault refuses ('folder_is_empty') while any documents (trashed included)
 * or subfolders remain, so nothing is ever orphaned. Risk low.
 */
export default async ({ body, ctx }: HandlerArgs) => {
  const input = (body ?? {}) as Record<string, unknown>;
  try {
    const outcome = await ctx.vault.invoke({
      command: 'core.delete_folder',
      input: {
        folder_id: String(input.folder_id ?? ''),
      },
      purpose: 'dpv:ServiceProvision',
    });
    return { status: 200, body: outcome };
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return { status: 200, body: { status: 'denied', reason: e.message, code: e.code } };
  }
};
