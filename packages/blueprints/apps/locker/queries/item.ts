/**
 * One item's full fields for the detail pane — the ONLY query that returns
 * secrets (password, card number, CVV, OTP seed, note body), and only for the
 * single item the owner opened. Secrets are SEALED columns (issue #293): the
 * read shows placeholders, so this query is where the app exercises its
 * `reveal` scope — one reveal per open, receipted per item by the vault, the
 * "item usage" audit trail. Carries the item's tags and its favorite star so
 * the detail pane is self-contained. A missing or wrong id returns
 * item:null, never an error.
 */

import { readTags, readStarred } from './items.ts';

interface FullRow {
  item_id: string;
  type: string;
  title: string;
  username?: string | null;
  password?: string | null;
  url?: string | null;
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
  updated_at?: string;
}

type SealedField = 'password' | 'otp_seed' | 'card_number' | 'cvv' | 'content';
const SEALED_FIELDS: SealedField[] = ['password', 'otp_seed', 'card_number', 'cvv', 'content'];

export default async ({ input, ctx }: { input?: Record<string, unknown>; ctx: HandlerCtx }) => {
  const purpose = 'dpv:ServiceProvision';
  const itemId = String(input?.item_id ?? '');
  if (!itemId) return { item: null };
  try {
    const res = await ctx.vault.read({
      entity: 'locker.item',
      where: [{ column: 'item_id', op: 'eq', value: itemId }],
      purpose,
    });
    const row = ((res.rows ?? []) as unknown as FullRow[])[0];
    if (!row) return { item: null };
    // The reveal (issue #293): swap the sealed placeholders for plaintext —
    // consent-checked under the app's `reveal` scope, receipted per open.
    try {
      const revealed = (await ctx.vault.reveal({
        entity: 'locker.item',
        entityId: itemId,
        columns: SEALED_FIELDS,
        purpose,
      })) as { values?: Partial<Record<SealedField, string | null>> };
      for (const field of SEALED_FIELDS) row[field] = revealed.values?.[field] ?? null;
    } catch {
      // No reveal grant: the pane still renders, secrets stay placeholders.
    }
    const [tagsByItem, starredIds] = await Promise.all([
      readTags(ctx, [itemId], purpose),
      readStarred(ctx, [itemId], purpose),
    ]);
    const item = {
      item_id: row.item_id,
      type: row.type,
      title: row.title,
      username: row.username ?? null,
      password: row.password ?? null,
      url: row.url ?? null,
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
      purge_at: row.purge_at ?? null,
      updated_at: row.updated_at,
    };
    return { item };
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return { item: null, vaultDenied: { code: e.code, message: e.message } };
  }
};
