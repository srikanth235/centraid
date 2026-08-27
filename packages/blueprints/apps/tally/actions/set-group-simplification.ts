/**
 * tally.set_group_simplification — see app.json for the contract. Consent denials and precondition
 * refusals come back as first-class outcomes the app narrates.
 * Writes the OPT-IN FLAG only; the proposal itself is derived at read time.
 */
const KEYS = ["group_id", "simplify"];
export default async function setGroupSimplification({
  body,
  ctx,
}: HandlerArgs) {
  const input = (body ?? {}) as Record<string, unknown>;
  const cmdInput: Record<string, unknown> = {};
  for (const k of KEYS)
    if (input[k] !== undefined && input[k] !== null) cmdInput[k] = input[k];
  try {
    const outcome = await ctx.vault.invoke({
      command: "tally.set_group_simplification",
      input: cmdInput,
      purpose: "dpv:ServiceProvision",
    });
    return { status: 200, body: outcome };
  } catch (error) {
    const e = error as { code?: string; message?: string };
    return {
      status: 200,
      body: { status: "denied", reason: e.message, code: e.code },
    };
  }
}
