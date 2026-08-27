/**
 * Archive an item through locker.archive_item — "keep forever, hide from lists". Not a trash: no purge date is set, and the item is exactly where it was when it comes back.
 */

export default async function archiveItem({ body, ctx }: HandlerArgs) {
  const input = (body ?? {}) as Record<string, unknown>;
  try {
    const outcome = await ctx.vault.invoke({
      command: "locker.archive_item",
      input: { item_id: String(input.item_id ?? "") },
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
