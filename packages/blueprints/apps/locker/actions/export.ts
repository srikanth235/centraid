/**
 * Plaintext export (README-Locker §1 `locker/export`, GAPS §3.3 #7). Thin: it
 * forwards the confirm to `locker.export` and hands the payload back.
 *
 * The WRITING of the file happens on the device; this is the data door. Three
 * things are deliberate here and stated where they are decided rather than
 * discovered at commit:
 *  - it is an ACTION over a command, not a query, because only a command can
 *    unseal and write the receipt a mass reveal owes (queries are read-only by
 *    directive, and a replica read sees placeholders);
 *  - it is ONLINE-ONLY (`writes.ts`), because the payload is nothing but
 *    secrets and a secret never enters the durable offline queue;
 *  - `confirm` is required by the command's own schema, and the command parks
 *    for the owner on any device that is not theirs.
 */

export default async function exportLocker({ body, ctx }: HandlerArgs) {
  const input = (body ?? {}) as Record<string, unknown>;
  try {
    const outcome = await ctx.vault.invoke({
      command: "locker.export",
      input: {
        confirm: input.confirm === true,
        ...(input.include_trashed === true ? { include_trashed: true } : {}),
        ...(input.include_history === true ? { include_history: true } : {}),
      },
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
