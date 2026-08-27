/**
 * Clone an item through locker.duplicate_item, for a sibling account. Sealed values are copied INSIDE the vault and never round-trip through this device; the copy is not starred and does not carry the original's connector alias.
 */

export default async function duplicateItem({ body, ctx }: HandlerArgs) {
  const input = (body ?? {}) as Record<string, unknown>;
  try {
    const outcome = await ctx.vault.invoke({
      command: "locker.duplicate_item",
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
