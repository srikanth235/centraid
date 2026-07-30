/** Publish one reviewed OCR receipt, its canonical bytes, lines, and allocations. */
export default async function addReceiptExpense({ body, ctx }: HandlerArgs) {
  try {
    const outcome = await ctx.vault.invoke({
      command: "tally.add_receipt_expense",
      input: (body ?? {}) as Record<string, unknown>,
      purpose: "dpv:ServiceProvision",
    });
    return { status: 200, body: outcome };
  } catch (error) {
    const value = error as { code?: string; message?: string };
    return {
      status: 200,
      body: {
        status: "denied",
        reason: value.message,
        code: value.code,
      },
    };
  }
}
