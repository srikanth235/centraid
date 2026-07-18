/**
 * Create a folder through core.create_folder — a new SKOS concept in the
 * owner's folders scheme, nested under parent_folder_id (omit for the
 * drive's top level). The vault refuses duplicate sibling names. Risk low.
 */
export default async ({ body, ctx }: HandlerArgs) => {
  const input = (body ?? {}) as Record<string, unknown>;
  try {
    const outcome = await ctx.vault.invoke({
      command: 'core.create_folder',
      input: {
        name: String(input.name ?? ''),
        ...(input.parent_folder_id != null
          ? { parent_folder_id: String(input.parent_folder_id) }
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
