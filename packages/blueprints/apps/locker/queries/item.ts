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

type SealedField = "password" | "otp_seed" | "card_number" | "cvv" | "content";
const SEALED_FIELDS: SealedField[] = [
  "password",
  "otp_seed",
  "card_number",
  "cvv",
  "content",
];

/** The sealed SIDECAR rows a permit may be spent on instead (#873). Named here
 *  rather than trusted from the input: an entity this query does not recognise
 *  is not a reveal it will attempt on the caller's word. */
const SIDECAR_COLUMNS: Record<string, string> = {
  "locker.item_field": "value_sealed",
  "locker.item_history": "password",
  "locker.item_passkey": "private_key",
};

interface SidecarAsk {
  entity: string;
  entityId: string;
  column: string;
}

/** The `sidecar` input, once it has proved it names a row this query reveals. */
function sidecarAsk(
  input: Record<string, unknown> | undefined
): SidecarAsk | null {
  const raw = input?.sidecar as Partial<SidecarAsk> | undefined;
  if (!raw) return null;
  const entity = String(raw.entity ?? "");
  const entityId = String(raw.entityId ?? "");
  const column = SIDECAR_COLUMNS[entity];
  if (!column || !entityId || raw.column !== column) return null;
  return { entity, entityId, column };
}

export default async function itemHandler({
  input,
  ctx,
}: {
  input?: Record<string, unknown>;
  ctx: HandlerCtx;
}) {
  const purpose = "dpv:ServiceProvision";
  const itemId = String(input?.item_id ?? "");
  if (!itemId) return { item: null };
  const sidecar = sidecarAsk(input);
  const authentication = {
    sessionToken: String(input?.auth_session ?? ""),
    itemToken: String(input?.item_token ?? ""),
  };
  let sidecarValue: string | null = null;
  try {
    const res = await ctx.vault.read({
      entity: "locker.item",
      where: [{ column: "item_id", op: "eq", value: itemId }],
      purpose,
    });
    const row = ((res.rows ?? []) as unknown as FullRow[])[0];
    if (!row) return { item: null };
    // The reveal (#293): swap the sealed placeholders for plaintext —
    // consent-checked under the app's `reveal` scope, receipted per open.
    // Skipped entirely when the permit is earmarked for a sidecar row, because
    // it would consume the one token that reveal needs.
    if (sidecar) {
      const revealed = (await ctx.vault.reveal({
        entity: sidecar.entity,
        entityId: sidecar.entityId,
        columns: [sidecar.column],
        authentication,
        purpose,
      })) as { values?: Record<string, string | null> };
      sidecarValue = revealed.values?.[sidecar.column] ?? null;
    } else {
      try {
        const revealed = (await ctx.vault.reveal({
          entity: "locker.item",
          entityId: itemId,
          columns: SEALED_FIELDS,
          authentication,
          purpose,
        })) as { values?: Partial<Record<SealedField, string | null>> };
        for (const field of SEALED_FIELDS)
          row[field] = revealed.values?.[field] ?? null;
      } catch (error) {
        // A Locker UI reveal always supplies both proofs. Authentication
        // failures must stay visible so the app relocks instead of rendering a
        // placeholder as if the item had no secret. Legacy/Companion callers
        // without those fields retain the consent-placeholder behavior.
        if (input?.auth_session || input?.item_token) throw error;
        // No reveal grant: the pane still renders, secrets stay placeholders.
      }
    }
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
      readTags(ctx, [itemId], purpose),
      readStarred(ctx, [itemId], purpose),
      readAlias(ctx, itemId, purpose),
      readFields(ctx, itemId, purpose),
      readAddresses(ctx, itemId, purpose),
      readPasskey(ctx, itemId, purpose),
      readHistory(ctx, itemId, purpose),
      readAttachments(ctx, itemId, purpose),
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
    return sidecar ? { item, sidecar: { value: sidecarValue } } : { item };
  } catch (error) {
    const e = error as { code?: string; message?: string };
    return { item: null, vaultDenied: { code: e.code, message: e.message } };
  }
}
