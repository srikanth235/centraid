// A request that never answers is not one in progress: the tunnel listener
// keeps accepting after its peer is gone (docs/traps/unreachable-vault.md).

/** Time to first byte, not to the last: a streaming vault is reachable. */
export const GATEWAY_REPLY_DEADLINE_MS = 20_000;

/**
 * One gateway request, aborted if the response has not begun. `caller` still
 * aborts at any time, including while the body streams.
 */
export async function fetchWithinReplyDeadline(
  run: (signal: AbortSignal) => Promise<Response>,
  caller?: AbortSignal,
  deadlineMs: number = GATEWAY_REPLY_DEADLINE_MS
): Promise<Response> {
  const controller = new AbortController();
  if (caller?.aborted) controller.abort();
  else
    caller?.addEventListener("abort", () => controller.abort(), { once: true });
  const timer = setTimeout(() => controller.abort(), deadlineMs);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}
