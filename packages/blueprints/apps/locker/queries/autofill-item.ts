/**
 * One explicit-gesture fill. Only password is revealed; TOTP is requested as
 * a derivative from locker.totp_code, so the OTP seed never leaves the sealed
 * command boundary. The page origin is normalized and attached to the reveal
 * receipt for the Approvals/audit surface.
 */

interface LoginRow {
  item_id: string;
  type: string;
  username?: string | null;
  otp_seed?: string | null;
  deleted_at?: string | null;
}

function pageOrigin(raw: unknown): string | undefined {
  try {
    const url = new URL(String(raw ?? ''));
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== raw) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

export default async ({ input, ctx }: { input?: Record<string, unknown>; ctx: HandlerCtx }) => {
  const purpose = 'dpv:ServiceProvision';
  const itemId = String(input?.item_id ?? '');
  const origin = pageOrigin(input?.page_origin);
  if (!itemId || !origin)
    return { fill: null, reason: 'A login id and normalized page origin are required.' };
  try {
    const response = await ctx.vault.read({
      entity: 'locker.item',
      where: [
        { column: 'item_id', op: 'eq', value: itemId },
        { column: 'type', op: 'eq', value: 'login' },
        { column: 'deleted_at', op: 'is-null' },
      ],
      limit: 1,
      purpose,
    });
    const row = ((response.rows ?? []) as unknown as LoginRow[])[0];
    if (!row) return { fill: null };
    const revealed = (await ctx.vault.reveal({
      entity: 'locker.item',
      entityId: itemId,
      columns: ['password'],
      context: { kind: 'fill', origin },
      purpose,
    })) as { values?: { password?: string | null }; receiptId?: string };
    let totp: string | undefined;
    if (row.otp_seed != null) {
      const outcome = await ctx.vault.invoke({
        command: 'locker.totp_code',
        input: { item_id: itemId },
        purpose,
      });
      if (outcome.status === 'executed') {
        const code = outcome.output?.code;
        if (typeof code === 'string') totp = code;
      }
    }
    return {
      fill: {
        username: row.username ?? undefined,
        password: revealed.values?.password ?? undefined,
        ...(totp ? { totp } : {}),
        receipt_id: revealed.receiptId,
      },
    };
  } catch (err) {
    const error = err as { code?: string; message?: string };
    return { fill: null, vaultDenied: { code: error.code, message: error.message } };
  }
};
