// Whole-list replace, unlike `set-field`: no address is a secret. The primary
// stays `locker_item.url`, so Companion candidates and bindings are untouched.

interface AddressInput {
  url?: unknown;
  match_policy?: unknown;
}

export default async function setAddresses({ body, ctx }: HandlerArgs) {
  const input = (body ?? {}) as Record<string, unknown>;
  const supplied = Array.isArray(input.addresses)
    ? (input.addresses as AddressInput[])
    : [];
  const addresses = supplied.flatMap((address) => {
    const url = String(address.url ?? "").trim();
    if (!url) return [];
    return [
      {
        url,
        ...(address.match_policy === "exact-host"
          ? { match_policy: "exact-host" }
          : { match_policy: "registrable-domain" }),
      },
    ];
  });
  try {
    const outcome = await ctx.vault.invoke({
      command: "locker.set_addresses",
      input: { item_id: String(input.item_id ?? ""), addresses },
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
