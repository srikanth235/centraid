/**
 * Delete one custom field from an item through locker.remove_field.
 */

export default async function removeField({ body, ctx }: HandlerArgs) {
  const input = (body ?? {}) as Record<string, unknown>;
  try {
    const outcome = await ctx.vault.invoke({
      command: "locker.remove_field",
      input: {
        item_id: String(input.item_id ?? ""),
        field_id: String(input.field_id ?? ""),
      },
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
