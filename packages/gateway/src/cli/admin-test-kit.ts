/** A `fail` that throws (the CLI exits via `process.exit`); tests assert on it. */
export class CliFailError extends Error {
  constructor(
    message: string,
    readonly code: number
  ) {
    super(message);
    this.name = "CliFailError";
  }
}

export const fail = (message: string, code = 1): never => {
  throw new CliFailError(message, code);
};

/** Capture what a command writes to stdout for the duration of `fn`. */
export async function capture(fn: () => Promise<void> | void): Promise<string> {
  const original = process.stdout.write.bind(process.stdout);
  const chunks: string[] = [];
  process.stdout.write = ((chunk: unknown): boolean => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    await fn();
  } finally {
    process.stdout.write = original;
  }
  const joined = chunks.join("");
  return joined;
}

export function lastJson(text: string): Record<string, unknown> {
  const lines = text.trim().split("\n").filter(Boolean);
  return JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
}
