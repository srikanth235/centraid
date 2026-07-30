export default async function organizeTask({ body, ctx }: HandlerArgs) {
  try {
    const outcome = await ctx.vault.invoke({
      command: "schedule.organize_task",
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
