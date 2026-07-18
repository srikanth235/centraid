/**
 * Revise a person's name, role line, avatar hue or how-you-met note. Runs through people.edit_person — consent-checked and receipted, risk low.
 */
export default async ({ body, ctx }: HandlerArgs) => {
  try {
    const outcome = await ctx.vault.invoke({
      command: 'people.edit_person',
      input: (body ?? {}) as Record<string, unknown>,
      purpose: 'dpv:ServiceProvision',
    });
    return { status: 200, body: outcome };
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return { status: 200, body: { status: 'denied', reason: e.message, code: e.code } };
  }
};
