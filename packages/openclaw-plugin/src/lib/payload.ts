/**
 * Helpers for parsing the cron-webhook ingest payload from OpenClaw.
 *
 * The agent's webhook envelope shape isn't fully documented and varies by
 * delivery mode, so we accept several plausible places where the "final
 * message text" might live and fall back to passing the raw body through.
 */

export function extractAgentFinalText(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const p = payload as Record<string, unknown>;
  if (typeof p.text === 'string') return p.text;
  if (typeof p.finalText === 'string') return p.finalText;
  if (typeof p.summary === 'string') return p.summary;
  if (p.message && typeof p.message === 'object') {
    const m = p.message as Record<string, unknown>;
    if (typeof m.text === 'string') return m.text;
  }
  return undefined;
}

export function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
