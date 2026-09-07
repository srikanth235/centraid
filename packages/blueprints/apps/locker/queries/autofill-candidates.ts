/**
 * Secret-free login metadata for Centraid Companion. This query intentionally
 * returns every live login; the worker applies the versioned PSL origin policy
 * before a page sees suggestions. Sealed values are reduced to an OTP-presence
 * bit and Watchtower derivatives; neither a password nor an OTP seed crosses
 * this handler.
 */

interface LoginRow {
  item_id: string;
  title: string;
  username?: string | null;
  url?: string | null;
  url_match_policy?: "registrable-domain" | "exact-host" | null;
  otp_seed?: string | null;
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
      ctx.vault.read({
        entity: "locker.item",
        where: [
          { column: "type", op: "eq", value: "login" },
          { column: "deleted_at", op: "is-null" },
        ],
        orderBy: { column: "updated_at", dir: "desc" },
        limit: 2000,
      }),
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
    const candidates = ((response.rows ?? []) as unknown as LoginRow[])
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
        has_totp: row.otp_seed != null,
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
