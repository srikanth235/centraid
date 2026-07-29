/** Move a People profile to reversible trash; the canonical party survives. */
export default async function trashPerson({ body, ctx }: HandlerArgs) {
  try {
    const outcome = await ctx.vault.invoke({
      command: "people.trash_person",
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
