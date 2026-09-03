interface RawPolicy {
  tier?: string;
}

export default async function enrichmentStatus({ ctx }: HandlerArgs) {
  const purpose = "dpv:ServiceProvision";
  try {
    const result = await ctx.vault.read({
      entity: "enrich.policy",
      where: [{ column: "domain", op: "eq", value: "photos" }],
      purpose,
    });
    const row = ((result.rows ?? []) as unknown as RawPolicy[])[0];
    return { tier: row?.tier ?? "off" };
  } catch (error) {
    const e = error as { code?: string; message?: string };
    if (e.code === "VAULT_ACCESS") {
      return { tier: null, vaultDenied: { code: e.code, message: e.message } };
    }
    return { tier: null, error: String(e.message ?? error) };
  }
}
