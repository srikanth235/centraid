/**
 * Remove an item's passkey slot, metadata and sealed key material together, through locker.clear_passkey.
 */

export default async function clearPasskey({ body, ctx }: HandlerArgs) {
  const input = (body ?? {}) as Record<string, unknown>;
  try {
    const outcome = await ctx.vault.invoke({
      command: "locker.clear_passkey",
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
