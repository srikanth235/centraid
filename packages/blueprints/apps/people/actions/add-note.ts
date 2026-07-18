/**
 * Add a note about a person, kept as a searchable annotation on their party. Runs through people.add_note — consent-checked and receipted, risk low.
 */
export default async ({ body, ctx }: HandlerArgs) => {
  try {
    const outcome = await ctx.vault.invoke({
      command: 'people.add_note',
      input: (body ?? {}) as Record<string, unknown>,
      purpose: 'dpv:ServiceProvision',
    });
    return { status: 200, body: outcome };
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return { status: 200, body: { status: 'denied', reason: e.message, code: e.code } };
  }
};
