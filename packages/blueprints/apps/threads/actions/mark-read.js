/**
 * Stamp the owner's read cursor on a thread through the vault's typed
 * command. social.mark_thread_read is risk=low and idempotent — opening a
 * thread re-marks with a newer instant every time, and the vault inserts a
 * silent owner participant row when the owner never spoke in the thread.
 * The outcome passes through verbatim; the UI treats it as fire-and-forget
 * (read cursors are silent — no toast, no confirmation).
 *
 * @type {import('@centraid/openclaw-plugin').ActionHandler}
 */
export default async ({ body, ctx }) => {
  const input = body ?? {};
  try {
    const outcome = await ctx.vault.invoke({
      command: 'social.mark_thread_read',
      input: {
        thread_id: String(input.thread_id ?? ''),
        read_at: String(input.read_at ?? ''),
      },
      purpose: 'dpv:ServiceProvision',
    });
    return { status: 200, body: outcome };
  } catch (err) {
    return { status: 200, body: { status: 'denied', reason: err.message, code: err.code } };
  }
};
