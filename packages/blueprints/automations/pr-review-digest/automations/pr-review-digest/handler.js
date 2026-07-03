/**
 * Automation handler — runs on the cron schedule in automation.json.
 *
 * Available on `ctx`:
 *   ctx.vault.read/invoke  — consent-checked canon access (this automation's
 *                            enrolled agent; every call is receipted)
 *   ctx.vault.parked       — this agent's invocations awaiting the owner
 *   ctx.tool(name, args)   — call an MCP tool
 *   ctx.agent({ prompt })  — one constrained model turn
 *   ctx.state.get/set/del  — cross-run key/value persistence
 *   ctx.runs.last/list     — this automation's prior runs
 *
 * Return `{ summary?, output? }` — `summary` shows in the run list.
 */
export default async ({ ctx, log }) => {
  log.info('automation fired');
  return { summary: 'ok' };
};
