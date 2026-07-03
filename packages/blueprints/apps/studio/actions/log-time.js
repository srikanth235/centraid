/**
 * Log a work session through the vault's typed command. The duration is a
 * canonical core.activity (kind 'work'); business.time_entry decorates it
 * with billing state. The rate defaults from the client so the entry is
 * invoiceable the moment it lands. Only active projects accept time.
 *
 * @type {import('@centraid/openclaw-plugin').ActionHandler}
 */
export default async ({ body, ctx }) => {
  const input = body ?? {};
  try {
    const outcome = await ctx.vault.invoke({
      command: 'business.log_time',
      input: {
        project_id: String(input.project_id ?? ''),
        started_at: String(input.started_at ?? ''),
        ended_at: String(input.ended_at ?? ''),
        ...(input.billable != null ? { billable: Number(input.billable) } : {}),
        ...(input.rate_minor != null ? { rate_minor: Number(input.rate_minor) } : {}),
        ...(input.note != null ? { note: String(input.note) } : {}),
      },
      purpose: 'dpv:Billing',
    });
    return { status: 200, body: outcome };
  } catch (err) {
    return { status: 200, body: { status: 'denied', reason: err.message, code: err.code } };
  }
};
