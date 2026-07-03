/**
 * Revise a party's identity fields (display name, sort name, birth date)
 * through core.update_party. Identity lives on the party row itself — the
 * contact card only carries enrichment — so this is the typed command for
 * renaming a person. Only the fields the form provided are sent, and the
 * outcome is passed through verbatim so the UI can narrate what the
 * consent plane decided.
 *
 * @type {import('@centraid/openclaw-plugin').ActionHandler}
 */
export default async ({ body, ctx }) => {
  const input = body ?? {};
  try {
    const outcome = await ctx.vault.invoke({
      command: 'core.update_party',
      input: {
        party_id: String(input.party_id ?? ''),
        ...(input.display_name != null ? { display_name: String(input.display_name) } : {}),
        ...(input.sort_name != null ? { sort_name: String(input.sort_name) } : {}),
        ...(input.birth_date != null ? { birth_date: String(input.birth_date) } : {}),
      },
      purpose: 'dpv:ServiceProvision',
    });
    return { status: 200, body: outcome };
  } catch (err) {
    return { status: 200, body: { status: 'denied', reason: err.message, code: err.code } };
  }
};
