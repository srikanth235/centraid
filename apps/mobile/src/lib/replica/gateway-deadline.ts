export const GATEWAY_REPLY_DEADLINE_MS = 20_000;

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
