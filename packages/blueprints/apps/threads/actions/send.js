/**
 * Release a draft for delivery — the consent model's showcase. The command
 * is risk=high, so for an app the outcome is virtually always `parked`:
 * nothing moves until the owner confirms it from the vault's parked queue.
 * `executed` means the owner acted (or already confirmed); `failed` means a
 * precondition refused (only drafts send).
 *
 * @type {import('@centraid/openclaw-plugin').ActionHandler}
 */
export default async ({ body, ctx }) => {
  const input = body ?? {};
  try {
    const outcome = await ctx.vault.invoke({
      command: 'social.send_message',
      input: { message_id: String(input.message_id ?? '') },
      purpose: 'dpv:ServiceProvision',
    });
    return { status: 200, body: outcome };
  } catch (err) {
    return { status: 200, body: { status: 'denied', reason: err.message, code: err.code } };
  }
};
