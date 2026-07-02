/**
 * Upsert a party's contact card through the vault's typed command. The card
 * is enrichment only — identity stays in core.party — and the command
 * COALESCEs omitted fields, so this sends only what the form provided. The
 * outcome is passed through verbatim — `executed`, `parked` (awaiting owner
 * confirmation), `denied`, or `failed` (a precondition such as the
 * party-exists check) — so the UI can narrate what the consent plane decided.
 *
 * @type {import('@centraid/openclaw-plugin').ActionHandler}
 */
export default async ({ body, ctx }) => {
  const input = body ?? {};
  try {
    const outcome = await ctx.vault.invoke({
      command: 'social.update_card',
      input: {
        party_id: String(input.party_id ?? ''),
        ...(input.nickname != null ? { nickname: String(input.nickname) } : {}),
        ...(input.note != null ? { note: String(input.note) } : {}),
        ...(input.favorite != null ? { favorite: Number(input.favorite) } : {}),
      },
      purpose: 'dpv:ServiceProvision',
    });
    return { status: 200, body: outcome };
  } catch (err) {
    return { status: 200, body: { status: 'denied', reason: err.message, code: err.code } };
  }
};
