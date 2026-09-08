import { readById } from "../../_shared/paged-reads.ts";

/**
 * Whether face enrichment is enabled for this vault (#352
 * phase 3/4): a straight read of `enrich.policy` for the photos domain — an
 * app-readable MIRROR of the owner's settings
 * (packages/vault/src/schema/enrich.ts), never the settings bag itself
 * (that stays owner-only, GET/PATCH /centraid/_vault/enrich). `tier` is
 * one of 'off' | 'device' | 'gateway' (#712 C5, renamed from
 * 'off' | 'local' | 'model'); the toolbar's "Detect faces now" only
 * fires when it isn't 'off' — when it is, the UI says so plainly rather
 * than showing a button that would silently no-op.
 */

interface RawPolicy {
  tier?: string;
}

export default async function enrichmentStatus({ ctx }: HandlerArgs) {
  try {
    // One row, asked for as one row: `enrich_policy` is keyed on the domain.
    const row = await readById<RawPolicy>(
      ctx,
      {
        name: "photos.enrichment.policy",
        select: "domain, tier, updated_at",
        from: "enrich_policy",
        idColumn: "domain",
      },
      "photos"
    );
    return { tier: row?.tier ?? "off" };
  } catch (error) {
    const e = error as { code?: string; message?: string };
    if (e.code === "VAULT_ACCESS") {
      return { tier: null, vaultDenied: { code: e.code, message: e.message } };
    }
    return { tier: null, error: String(e.message ?? error) };
  }
}
