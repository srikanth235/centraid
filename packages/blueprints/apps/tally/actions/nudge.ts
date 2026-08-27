/**
 * tally.nudge — see app.json for the contract. Consent denials and precondition
 * refusals come back as first-class outcomes the app narrates.
 * The command carries `confirm: true`, so this ALWAYS parks for the owner's
 * confirmation — an app is a non-owner caller. Nothing is ever sent.
 */
const KEYS = ["party_id", "group_id", "as_of_minor", "note"];
export default async function nudge({ body, ctx }: HandlerArgs) {
  const input = (body ?? {}) as Record<string, unknown>;
  const cmdInput: Record<string, unknown> = {};
  for (const k of KEYS)
    if (input[k] !== undefined && input[k] !== null) cmdInput[k] = input[k];
  try {
    const outcome = await ctx.vault.invoke({
      command: "tally.nudge",
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
