/**
 * Release a draft for delivery through social.send_message. That command is
 * risk=high — above every app's risk ceiling — so when this app invokes it
 * the outcome is `parked`, not `executed`: the invocation waits for the
 * owner's explicit confirmation in the host's vault UI. The parked outcome
 * (with its invocationId) is passed through verbatim so the UI can show a
 * waiting-for-owner state instead of pretending the message left.
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
