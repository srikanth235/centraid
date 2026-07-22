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
  url_match_policy?: 'registrable-domain' | 'exact-host' | null;
  otp_seed?: string | null;
  compromised?: number | boolean | null;
}

export default async ({ ctx }: { ctx: HandlerCtx }) => {
  const purpose = 'dpv:ServiceProvision';
  try {
    const [response, watchtower] = await Promise.all([
      ctx.vault.read({
        entity: 'locker.item',
        where: [
          { column: 'type', op: 'eq', value: 'login' },
          { column: 'deleted_at', op: 'is-null' },
        ],
        orderBy: { column: 'updated_at', dir: 'desc' },
        limit: 2000,
        purpose,
      }),
      ctx.vault.invoke({ command: 'locker.watchtower', input: {}, purpose }),
    ]);
    const warned = new Set(
      watchtower.status === 'executed'
        ? (
            (watchtower.output?.items ?? []) as Array<{
              item_id?: unknown;
              weak?: unknown;
              reused?: unknown;
            }>
          )
            .filter((item) => item.weak === true || item.reused === true)
            .map((item) => String(item.item_id ?? ''))
            .filter(Boolean)
        : [],
    );
    const candidates = ((response.rows ?? []) as unknown as LoginRow[])
      .filter((row) => typeof row.url === 'string' && row.url.length > 0)
      .map((row) => ({
        item_id: row.item_id,
        title: row.title,
        username: row.username ?? undefined,
        url: row.url!,
        url_match_policy:
          row.url_match_policy === 'exact-host' ? 'exact-host' : 'registrable-domain',
        has_totp: row.otp_seed != null,
        compromised: row.compromised === 1 || row.compromised === true,
        warning: row.compromised === 1 || row.compromised === true || warned.has(row.item_id),
      }));
    return { candidates };
  } catch (err) {
    const error = err as { code?: string; message?: string };
    return { candidates: [], vaultDenied: { code: error.code, message: error.message } };
  }
};
