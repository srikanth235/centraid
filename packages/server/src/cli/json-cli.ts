export type Fail = (message: string, code?: number) => never;

export class CliJsonError extends Error {
  constructor(
    message: string,
    readonly code: number
  ) {
    super(message);
    this.name = "CliJsonError";
  }
}

export function jsonFail(json: boolean, fail: Fail): Fail {
  if (!json) return fail;
  return (message: string, code = 1): never => {
    throw new CliJsonError(message, code);
  };
}

export async function runJson(
  json: boolean,
  realFail: Fail,
  body: () => Promise<void> | void
): Promise<void> {
  if (!json) {
    await body();
    return;
  }
  try {
    await body();
  } catch (error) {
    const code = error instanceof CliJsonError ? error.code : 1;
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(
      `${JSON.stringify({ ok: false, error: code === 2 ? "usage" : "error", message })}\n`
    );
    realFail(message, code);
  }
}
