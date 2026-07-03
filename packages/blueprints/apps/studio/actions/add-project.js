/**
 * Open a project under a client through the vault's typed command. Project
 * names are unique per client — a duplicate is a receipted refusal, not a
 * constraint error.
 *
 * @type {import('@centraid/openclaw-plugin').ActionHandler}
 */
export default async ({ body, ctx }) => {
  const input = body ?? {};
  try {
    const outcome = await ctx.vault.invoke({
      command: 'business.add_project',
      input: {
        client_id: String(input.client_id ?? ''),
        name: String(input.name ?? ''),
        ...(input.status != null ? { status: String(input.status) } : {}),
        ...(input.starts_on != null ? { starts_on: String(input.starts_on) } : {}),
        ...(input.budget_minor != null ? { budget_minor: Number(input.budget_minor) } : {}),
      },
      purpose: 'dpv:Billing',
    });
    return { status: 200, body: outcome };
  } catch (err) {
    return { status: 200, body: { status: 'denied', reason: err.message, code: err.code } };
  }
};
