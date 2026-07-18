/**
 * Add a person to your circle: mints a canonical core.party plus its people_profile, optionally filed into a list. Runs through people.add_person — consent-checked and receipted, risk low.
 */
export default async ({ body, ctx }: HandlerArgs) => {
  try {
    const outcome = await ctx.vault.invoke({
      command: 'people.add_person',
      input: (body ?? {}) as Record<string, unknown>,
      purpose: 'dpv:ServiceProvision',
    });
    return { status: 200, body: outcome };
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return { status: 200, body: { status: 'denied', reason: e.message, code: e.code } };
  }
};
