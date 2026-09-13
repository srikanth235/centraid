/**
 * Secret-free login metadata for Centraid Companion. This query intentionally
 * returns every live login; the worker applies the versioned PSL origin policy
 * before a page sees suggestions. Sealed values are reduced to an OTP-presence
 * bit and Watchtower derivatives; neither a password nor an OTP seed crosses
 * this handler.
 */

import { readWindow } from "../../_shared/paged-reads.ts";
import { LOCKER_ITEM_COLUMNS } from "./items.ts";

/** How many logins the picker considers. */
const LOGIN_ROWS = 2000;

interface LoginRow {
  item_id: string;
  title: string;
  username?: string | null;
  url?: string | null;
  url_match_policy?: "registrable-domain" | "exact-host" | null;
  /** The projected `otp_seed IS NOT NULL`, as SQLite answers it: 0 or 1. */
  has_totp?: number | boolean | null;
  compromised?: number | boolean | null;
}

export default async function autofillCandidates({
  ctx,
}: {
  input?: Record<string, unknown>;
  ctx: HandlerCtx;
}) {
  try {
    // THE UNLOCK CHECK IS GONE FROM HERE (#996, rulings R13 and W6-D2), and
    // what it protected is worth stating rather than quietly dropping.
    //
    // It read: "without it a paired device could map every login's item_id +
    // url while locked". That was true of a device that had to ASK the gateway
    // to enumerate. A seat holds `vault.db` WHOLE (R1) — titles, addresses and
    // usernames are plaintext there precisely so a locked Locker still lists
    // and searches offline — so the enumeration this gate refused is a local
    // read on the seat now, and refusing it here refuses nothing.
    //
    // The Companion is the caller this still bears on: it is a browser
    // extension, not a seat, and it does not hold the vault. Its candidate
    // list is gated on the Companion's own side, which is where a surface
    // that holds no vault has to be gated. Raised in the wave-6 receipt as an
    // open question rather than settled here.
    const [response, watchtower] = await Promise.all([
      // WALKED, NOT CLAMPED (#1020, R-1020-35). A 2,000-row window asked for
      // as one page came back 500 rows long with a `next` cursor nobody read,
      // so a member past 500 logins had suggestions silently missing.
      readWindow<LoginRow>(
        ctx,
        {
          name: "locker.autofill.logins",
          // PRESENCE, NEVER THE CELL (#1020, D-1020-CL5). `LOCKER_ITEM_COLUMNS`
          // carries no sealed column, so `row.otp_seed` was `undefined` on
          // every row and `has_totp` was FALSE FOR EVERY ITEM IN EVERY VAULT —
          // the Companion was never told an item carries a one-time code.
          // Asking for the column would hand the Companion ciphertext; asking
          // whether it is set hands it a boolean.
          select: `${LOCKER_ITEM_COLUMNS}, otp_seed IS NOT NULL AS has_totp`,
          from: "locker_item",
          where: "type = ? AND deleted_at IS NULL",
          bind: ["login"],
          order: {
            sortColumn: "updated_at",
            pkColumn: "item_id",
            descending: true,
          },
        },
        LOGIN_ROWS
      ),
      ctx.vault.invoke({ command: "locker.watchtower", input: {} }),
    ]);
    const warned = new Set(
      watchtower.status === "executed"
        ? (
            (watchtower.output?.items ?? []) as Array<{
              item_id?: unknown;
              weak?: unknown;
              reused?: unknown;
            }>
          )
            .filter((item) => item.weak === true || item.reused === true)
            .map((item) => String(item.item_id ?? ""))
            .filter(Boolean)
        : []
    );
    const candidates = (response as unknown as LoginRow[])
      .filter((row) => typeof row.url === "string" && row.url.length > 0)
      .map((row) => ({
        item_id: row.item_id,
        title: row.title,
        username: row.username ?? undefined,
        url: row.url!,
        url_match_policy:
          row.url_match_policy === "exact-host"
            ? "exact-host"
            : "registrable-domain",
        has_totp: row.has_totp === 1 || row.has_totp === true,
        compromised: row.compromised === 1 || row.compromised === true,
        warning:
          row.compromised === 1 ||
          row.compromised === true ||
          warned.has(row.item_id),
      }));
    return { candidates };
  } catch (caughtError) {
    const error = caughtError as { code?: string; message?: string };
    return {
      candidates: [],
      vaultDenied: { code: error.code, message: error.message },
    };
  }
}
