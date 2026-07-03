/**
 * Compose a draft to a party through the vault's typed command. Drafting is
 * deliberately split from sending: this creates (or reuses) a thread and
 * stores the body as a deduped content item, but delivery stays 'draft'
 * until social.send_message — the high-risk command that parks for owner
 * confirmation — releases it. draft_message itself is risk medium, so under
 * an app's default low risk ceiling this parks too; the outcome passes
 * through verbatim so the UI narrates it instead of treating it as failure.
 *
 * @type {import('@centraid/openclaw-plugin').ActionHandler}
 */
export default async ({ body, ctx }) => {
  const input = body ?? {};
  try {
    const outcome = await ctx.vault.invoke({
      command: 'social.draft_message',
      input: {
        recipient_party_id: String(input.recipient_party_id ?? ''),
        body_text: String(input.body_text ?? ''),
        ...(input.channel != null ? { channel: String(input.channel) } : {}),
        ...(input.subject != null ? { subject: String(input.subject) } : {}),
      },
      purpose: 'dpv:ServiceProvision',
    });
    return { status: 200, body: outcome };
  } catch (err) {
    return { status: 200, body: { status: 'denied', reason: err.message, code: err.code } };
  }
};
