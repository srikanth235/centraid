/*
 * Shared `--json` error contract for the admin CLI (issue #382).
 *
 * Every `fail(message, code)` call in this package writes to stderr and
 * calls `process.exit` immediately — right for a human terminal, wrong for
 * a caller (the desktop's SSH-driven admin flow) that needs to parse a
 * structured failure. `--json` commands swap in `jsonFail`, which THROWS a
 * catchable `CliJsonError` instead of exiting; `runJson` wraps the command
 * body, catches that throw, and prints `{ok:false, error, message}` before
 * exiting with the same code. Human mode (`json: false`) is byte-identical
 * to before — `jsonFail` hands back the real `fail`, and `runJson` just
 * awaits the body with no try/catch in the way.
 */

export type Fail = (message: string, code?: number) => never;

export class CliJsonError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
    this.name = 'CliJsonError';
  }
}

/** Human mode passes `fail` through unchanged; `--json` mode makes it throw. */
export function jsonFail(json: boolean, fail: Fail): Fail {
  if (!json) return fail;
  return (message: string, code = 1): never => {
    throw new CliJsonError(message, code);
  };
}

/**
 * Run `body`. In human mode this is a plain `await body()` — any `fail()`
 * call inside already exited the process, so there is nothing to catch.
 * In `--json` mode, a thrown `CliJsonError` (or any other error) becomes
 * one JSON line on stdout — `error` is a coarse code derived from the exit
 * code (`2` is a usage error, everything else is a runtime error), never
 * the raw message, so scripts can switch on it without string-matching —
 * then hands off to `realFail` (the ORIGINAL `fail` the command was given,
 * not the `jsonFail`-wrapped one `body` used internally) so the actual
 * exit — `process.exit` in production, a throw in tests — happens exactly
 * the same way a human-mode failure would.
 */
export async function runJson(
  json: boolean,
  realFail: Fail,
  body: () => Promise<void> | void,
): Promise<void> {
  if (!json) {
    await body();
    return;
  }
  try {
    await body();
  } catch (err) {
    const code = err instanceof CliJsonError ? err.code : 1;
    const message = err instanceof Error ? err.message : String(err);
    process.stdout.write(
      `${JSON.stringify({ ok: false, error: code === 2 ? 'usage' : 'error', message })}\n`,
    );
    realFail(message, code);
  }
}
