/**
 * Add an owned item through the vault's typed command — the home domain's
 * first write path. The vault assigns the id; coverage is a separate concern
 * recorded through add-warranty. A room travels as place_id (the vault
 * checks it names a real core.place) and a purchase price as minor units
 * plus its 3-letter currency (the vault refuses a price with no currency).
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
        ...(input.place_id != null ? { place_id: String(input.place_id) } : {}),
        ...(input.purchase_price_minor != null
          ? { purchase_price_minor: Number(input.purchase_price_minor) }
          : {}),
        ...(input.purchase_currency != null
          ? { purchase_currency: String(input.purchase_currency).toUpperCase() }
          : {}),
      },
      purpose: 'dpv:ServiceProvision',
    });
    return { status: 200, body: outcome };
  } catch (err) {
    return { status: 200, body: { status: 'denied', reason: err.message, code: err.code } };
  }
};
