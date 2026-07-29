export default async function editOccurrence({
  body,
  ctx,
}: HandlerArgs): Promise<ActionResult> {
  const input = (body ?? {}) as Record<string, unknown>;
  try {
    const outcome = await ctx.vault.invoke({
      command: "schedule.edit_event_occurrence",
      input,
      purpose: "dpv:ServiceProvision",
    });
    return { status: 200, body: outcome };
  } catch (error) {
    const detail = error as { code?: string; message?: string };
    return {
      status: 200,
      body: {
        status: "denied",
        reason: detail.message,
        code: detail.code,
      },
    };
  }
}
