/**
 * Compose a draft through the vault's typed command. The draft lands as a
 * canonical social.message row with delivery='draft' — it never sends by
 * itself; releasing it is social.send_message's job. The outcome is passed
 * through verbatim so the UI can narrate what the consent plane decided.
 *
 * @type {import('@centraid/openclaw-plugin').ActionHandler}
 */
export default async ({ body, ctx }) => {
  const input = body ?? {};
  try {
    const outcome = await ctx.vault.invoke({
      command: 'social.draft_message',
      input: {
        body_text: String(input.body_text ?? ''),
        ...(input.thread_id ? { thread_id: String(input.thread_id) } : {}),
        ...(input.recipient_party_id
          ? { recipient_party_id: String(input.recipient_party_id) }
          : {}),
        ...(input.channel ? { channel: String(input.channel) } : {}),
        ...(input.subject ? { subject: String(input.subject) } : {}),
      },
      purpose: 'dpv:ServiceProvision',
    });
    return { status: 200, body: outcome };
  } catch (err) {
    return { status: 200, body: { status: 'denied', reason: err.message, code: err.code } };
  }
};
