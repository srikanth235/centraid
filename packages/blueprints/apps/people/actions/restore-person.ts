/** Restore a People profile from its grace-window trash. */
export default async function restorePerson({ body, ctx }: HandlerArgs) {
  try {
    const outcome = await ctx.vault.invoke({
      command: "people.restore_person",
      input: (body ?? {}) as Record<string, unknown>,
      purpose: "dpv:ServiceProvision",
    });
    return { status: 200, body: outcome };
  } catch (error) {
    const e = error as { code?: string; message?: string };
    return {
      status: 200,
      body: { status: "denied", reason: e.message, code: e.code },
    };
  }
}
