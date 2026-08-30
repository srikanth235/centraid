import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

// Whole-list replace — no address is a secret. The primary locker_item.url
// and its Companion bindings are untouched.

interface AddressInput {
  url?: unknown;
  match_policy?: unknown;
}

export default async function setAddresses({ body, ctx }: HandlerArgs) {
  const input = actionInput(body);
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
  return runVaultAction(ctx, {
    command: "locker.set_addresses",
    input: { item_id: String(input.item_id ?? ""), addresses },
  });
}
