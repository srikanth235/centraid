export function coerceDelegateAnswer(text: string, json: unknown): unknown {
  const trimmed = text.trim();
  if (!json) return trimmed;
  const fenced = /```(?:json)?\s*(?<body>[\s\S]*?)```/u.exec(trimmed);
  const candidate = fenced?.groups?.body?.trim() ?? trimmed;
  try {
    return JSON.parse(candidate) as unknown;
  } catch (error) {
    throw new Error(
      `ctx.delegate expected JSON but got: ${trimmed.slice(0, 500)} (${error instanceof Error ? error.message : String(error)})`,
      { cause: error }
    );
  }
}
