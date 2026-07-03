/**
 * Add an owned item through the vault's typed command — the home domain's
 * first write path. The vault assigns the id; coverage is a separate concern
 * recorded through add-warranty.
 *
 * @type {import('@centraid/openclaw-plugin').ActionHandler}
 */
export default async ({ body, ctx }) => {
  const input = body ?? {};
  try {
    const outcome = await ctx.vault.invoke({
      command: 'home.add_item',
      input: {
        name: String(input.name ?? ''),
        ...(input.acquired_on != null ? { acquired_on: String(input.acquired_on) } : {}),
        ...(input.serial_no != null ? { serial_no: String(input.serial_no) } : {}),
      },
      purpose: 'dpv:ServiceProvision',
    });
    return { status: 200, body: outcome };
  } catch (err) {
    return { status: 200, body: { status: 'denied', reason: err.message, code: err.code } };
  }
};
