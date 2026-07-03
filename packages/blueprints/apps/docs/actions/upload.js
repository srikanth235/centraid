/**
 * Add a document through core.add_document: the bytes become a sha256-deduped
 * canonical content item filed into a folder (omit folder_id for the drive's
 * top level). Re-uploading identical bytes restores them from trash and
 * renames them. Risk low.
 *
 * @type {import('@centraid/openclaw-plugin').ActionHandler}
 */
export default async ({ body, ctx }) => {
  const input = body ?? {};
  try {
    const outcome = await ctx.vault.invoke({
      command: 'core.add_document',
      input: {
        data_uri: String(input.data_uri ?? ''),
        title: String(input.title ?? ''),
        ...(input.folder_id != null ? { folder_id: String(input.folder_id) } : {}),
      },
      purpose: 'dpv:ServiceProvision',
    });
    return { status: 200, body: outcome };
  } catch (err) {
    return { status: 200, body: { status: 'denied', reason: err.message, code: err.code } };
  }
};
