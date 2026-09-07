/**
 * WHERE A DOCUMENT CAME FROM (#903, #929; paged since #996 wave 4, R8).
 *
 * Split out of `./_shared.ts` when the reads became paged walks: the shares
 * half and this one are two independent denials over two independent planes,
 * and the file that held both went past the repo's size limit rather than
 * losing a comment that explains why a lost NAME is not a lost ARRIVAL.
 *
 * NOT bounded by the caller's window: this is what DISCOVERS rows — a
 * delivered copy carries no folders-scheme tag of its own, so the drive's tag
 * window cannot see it — which is why the subscription read takes a page of
 * its own, sized by the caller, and everything after it joins over what that
 * page returned.
 *
 * SHAPE-KEYED, NOT ROW-KEYED: a document arrives because a SHAPE placed it, so
 * the subscription this vault holds is what names the sender and the moment.
 *
 * Its own denial is survivable at both levels. The whole function answers
 * `null` — "we cannot see", never "nothing arrived" — and `readSenderNames`
 * answers empty maps, because an unnamed sender still belongs on the shelf.
 */

import { inList, readPages } from "../../_shared/paged-reads.ts";
import { SHARE_FAN_OUT } from "./_shared.ts";
import type { BindingRow, PartyRow } from "./_shared.ts";

const DOCUMENT_TARGET_TYPE = "core.document";

interface SubscriptionRow {
  authority_id: string;
  origin_vault_id: string;
  subscribed_at?: string | null;
}

interface LineageRow {
  authority_id: string;
  target_type: string;
  target_id: string;
}

/** One inbound placement: which vault delivered a document, and when. */
export interface SharedFromEntry {
  vault_id: string;
  /** `null` is "cannot say who", never "nobody": no live binding names them. */
  party_id: string | null;
  name: string | null;
  /** Landed here, epoch ms. */
  at: number;
}

async function readSenderNames({
  ctx,
  vaultIds,
}: {
  ctx: HandlerCtx;
  vaultIds: string[];
}): Promise<{
  partyByVault: Map<string, string>;
  nameByParty: Map<string, string>;
}> {
  const empty = { partyByVault: new Map(), nameByParty: new Map() };
  if (vaultIds.length === 0) return empty;
  try {
    const vaultIn = inList("vault_id", vaultIds);
    const bindings = await readPages<BindingRow>(
      ctx,
      {
        name: "docs.origins.bindings",
        // A revoked binding no longer says whose vault that is.
        select: "binding_id, party_id, vault_id",
        from: "share_party_vault_binding",
        where: `${vaultIn.sql} AND revoked_at IS NULL`,
        bind: vaultIn.bind,
        order: {
          sortColumn: "binding_id",
          pkColumn: "binding_id",
          descending: false,
        },
      },
      SHARE_FAN_OUT
    );
    const partyByVault = new Map(bindings.map((b) => [b.vault_id, b.party_id]));
    const partyIds = [...new Set(partyByVault.values())];
    if (partyIds.length === 0) return { partyByVault, nameByParty: new Map() };
    const partyIn = inList("party_id", partyIds);
    const parties = await readPages<PartyRow>(
      ctx,
      {
        name: "docs.origins.parties",
        select: "party_id, display_name",
        from: "core_party",
        where: partyIn.sql,
        bind: partyIn.bind,
        order: {
          sortColumn: "party_id",
          pkColumn: "party_id",
          descending: false,
        },
      },
      SHARE_FAN_OUT
    );
    return {
      partyByVault,
      nameByParty: new Map(
        parties.flatMap((p) => {
          const name = p.display_name?.trim();
          return name ? [[p.party_id, name] as const] : [];
        })
      ),
    };
  } catch {
    return empty;
  }
}

export async function readOriginsByDocument({
  ctx,
  limit,
}: {
  ctx: HandlerCtx;
  limit: number;
}): Promise<Map<string, SharedFromEntry> | null> {
  try {
    // THE DISCOVERY READ IS A PAGE. Its keyset's second axis is
    // `authority_id`: `share_subscription` is keyed on
    // (authority_id, audience_vault_id), and in this vault's own copy the
    // audience is always this vault, so the grant is what separates two rows
    // that arrived in the same instant.
    const subscriptions = await ctx.vault.page<SubscriptionRow>({
      query: {
        name: "docs.origins.subscriptions",
        select: "authority_id, origin_vault_id, subscribed_at",
        from: "share_subscription",
        where: "state = ?",
        bind: ["subscribed"],
        order: {
          sortColumn: "subscribed_at",
          pkColumn: "authority_id",
          descending: true,
        },
      },
      limit,
    });
    const subscriptionRows = subscriptions.rows;
    if (subscriptionRows.length === 0) return new Map();
    const authorityIds = [
      ...new Set(subscriptionRows.map((s) => s.authority_id)),
    ];
    const authorityIn = inList("authority_id", authorityIds);
    // Bounded by the subscriptions just read; `target_id` is the keyset's
    // second axis because the lineage's key is
    // (authority_id, target_type, target_id) and the type is pinned here.
    const lineageRows = await readPages<LineageRow>(
      ctx,
      {
        name: "docs.origins.lineage",
        select: "authority_id, target_type, target_id",
        from: "share_subscription_lineage",
        where: `target_type = ? AND ${authorityIn.sql}`,
        bind: [DOCUMENT_TARGET_TYPE, ...authorityIn.bind],
        order: {
          sortColumn: "authority_id",
          pkColumn: "target_id",
          descending: false,
        },
      },
      SHARE_FAN_OUT
    );
    if (lineageRows.length === 0) return new Map();
    const byGrant = new Map(subscriptionRows.map((s) => [s.authority_id, s]));

    // A LOST NAME IS NOT A LOST ARRIVAL: only a denied placement is unknown.
    const { partyByVault, nameByParty } = await readSenderNames({
      ctx,
      vaultIds: [...new Set(subscriptionRows.map((s) => s.origin_vault_id))],
    });

    return new Map(
      lineageRows.flatMap((row) => {
        const subscription = byGrant.get(row.authority_id);
        if (!subscription) return [];
        const partyId = partyByVault.get(subscription.origin_vault_id) ?? null;
        return [
          [
            row.target_id,
            {
              vault_id: subscription.origin_vault_id,
              party_id: partyId,
              name: partyId ? (nameByParty.get(partyId) ?? null) : null,
              at: Date.parse(subscription.subscribed_at ?? "") || 0,
            } satisfies SharedFromEntry,
          ] as const,
        ];
      })
    );
  } catch {
    return null;
  }
}
