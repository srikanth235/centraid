/**
 * One item's full fields for the detail pane — the ONLY query that returns
 * secrets (password, card number, CVV, OTP seed, note body), and only for the
 * single item the owner opened. Secrets are SEALED columns (#293): the
 * read shows placeholders, so this query is where the app exercises its
 * `reveal` scope — one reveal per open, receipted per item by the vault, the
 * "item usage" audit trail. Carries the item's tags and its favorite star so
 * the detail pane is self-contained. A missing or wrong id returns
 * item:null, never an error.
 *
 * AND ONE PERMIT BUYS EXACTLY ONE REVEAL (#873). `consumeItemPermit` DELETES
 * the item token before plaintext leaves the vault, so a call cannot reveal the
 * item's own columns and then a sidecar row as well. That is why `sidecar`
 * is a MODE rather than an addition: when the caller names a sealed sidecar
 * row, this query spends the permit on that row and the item's own columns come
 * back as the placeholders they are at rest.
 */

import {
  readAddresses,
  readAlias,
  readAttachments,
  readFields,
  readHistory,
  readPasskey,
} from "./item-sidecars.ts";
import { readTags, readStarred } from "./items.ts";
import { degradeType } from "./type-degradation.ts";

interface FullRow {
  item_id: string;
  type: string;
  title: string;
  username?: string | null;
  password?: string | null;
  url?: string | null;
  url_match_policy?: "registrable-domain" | "exact-host" | null;
  otp_seed?: string | null;
  notes?: string | null;
  cardholder?: string | null;
  card_number?: string | null;
  expiry?: string | null;
  cvv?: string | null;
  brand?: string | null;
  content?: string | null;
  fullname?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  network?: string | null;
  compromised?: number | boolean | null;
  deleted_at?: string | null;
  purge_at?: string | null;
  archived_at?: string | null;
  password_set_at?: string | null;
  updated_at?: string;
}

export default async function itemHandler({
  input,
  ctx,
}: {
  input?: Record<string, unknown>;
  ctx: HandlerCtx;
}) {
  const itemId = String(input?.item_id ?? "");
  if (!itemId) return { item: null };
  try {
    const res = await ctx.vault.read({
      acceptTruncation: true,
      entity: "locker.item",
      where: [{ column: "item_id", op: "eq", value: itemId }],
    });
    const row = ((res.rows ?? []) as unknown as FullRow[])[0];
    if (!row) return { item: null };
    // NO REVEAL HERE (#996, rulings R13 and W6-D2). This query used to hand
    // the gateway a session token and an item token and take plaintext off the
    // answer. The gateway no longer unseals a Locker row for a client at all —
    // the shell does, with `K`, behind the member's unlock — so what comes back
    // is the browsable half: titles, addresses, usernames, and the secret
    // columns as the vault stores them. That is also why this pane paints
    // while the Locker is locked, which the permit could never allow.
    const [
      tagsByItem,
      starredIds,
      alias,
      fields,
      addresses,
      passkey,
      history,
      attachments,
    ] = await Promise.all([
      readTags(ctx, [itemId]),
      readStarred(ctx, [itemId]),
      readAlias(ctx, itemId),
      readFields(ctx, itemId),
      readAddresses(ctx, itemId),
      readPasskey(ctx, itemId),
      // The item as it stands is what the newest revision is diffed against.
      // `row`'s sealed cells may be plaintext by now; the revision read reaches
      // for PLAIN columns only, and never for one of them.
      readHistory(ctx, itemId, row as unknown as Record<string, unknown>),
      readAttachments(ctx, itemId),
    ]);
    const item = {
      item_id: row.item_id,
      // A type this build does not know renders as a note carrying its custom
      // fields — never as an empty pane.
      type: degradeType(row.type),
      degraded_from: degradeType(row.type) === row.type ? null : row.type,
      title: row.title,
      username: row.username ?? null,
      password: row.password ?? null,
      url: row.url ?? null,
      url_match_policy: row.url_match_policy ?? "registrable-domain",
      otp_seed: row.otp_seed ?? null,
      notes: row.notes ?? null,
      cardholder: row.cardholder ?? null,
      card_number: row.card_number ?? null,
      expiry: row.expiry ?? null,
      cvv: row.cvv ?? null,
      brand: row.brand ?? null,
      content: row.content ?? null,
      fullname: row.fullname ?? null,
      email: row.email ?? null,
      phone: row.phone ?? null,
      address: row.address ?? null,
      network: row.network ?? null,
      compromised: row.compromised === 1 || row.compromised === true,
      favorite: starredIds.has(itemId),
      tags: tagsByItem.get(itemId) ?? [],
      trashed: row.deleted_at != null,
      archived: row.archived_at != null,
      archived_at: row.archived_at ?? null,
      password_set_at: row.password_set_at ?? null,
      // The alias, read back at last (README-Locker §8's first paper cut):
      // `locker_item_alias` became a registered table in #872, so the form can
      // show the current binding, clear it, and reassign it.
      alias,
      fields,
      addresses,
      passkey,
      history,
      attachments,
      purge_at: row.purge_at ?? null,
      updated_at: row.updated_at,
    };
    // The sidecar plaintext rides BESIDE the item rather than inside it: a
    // sealed sidecar row's shape stays exactly what `item-sidecars.ts` returns,
    // so no payload of this query ever has a place to put a secret it was not
    // asked for.
    return { item };
  } catch (error) {
    const e = error as { code?: string; message?: string };
    return { item: null, vaultDenied: { code: e.code, message: e.message } };
  }
}
