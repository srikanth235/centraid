/*
 * The recording ctx and the row fixtures the Locker query-handler suites share
 * (#872, #873). Split out of `queries.test.ts` when that file crossed the
 * 625-line hygiene limit (#930); the suites that read it are
 * `queries.test.ts` (the `items` window and the `item` detail) and
 * `queries-reveal-access.test.ts` (the sealed sidecar reveal and the access
 * history).
 *
 * The mock ctx deliberately does NOT apply `where` — every assertion about
 * narrowing is made against the RECORDED read requests, so a handler that
 * silently stopped filtering fails in those suites rather than passing because
 * the mock was obliging.
 */

export interface ReadCall {
  entity: string;
  where?: Array<{ column: string; op: string; value?: unknown }>;
  orderBy?: { column: string; dir?: string };
  limit?: number;
}

export function ctxOf(
  rowsByEntity: Record<string, unknown[]>,
  options: {
    calls?: ReadCall[];
    invoked?: Record<string, unknown>[];
    reveals?: Record<string, unknown>[];
    revealValues?: Record<string, string | null>;
    outputs?: Record<string, unknown>;
    authenticated?: boolean;
    /**
     * A seat holding a REPLICA rather than a gateway: no verb but read is
     * performable. An invocation the handler declared `optional` settles as a
     * failed outcome; every other effect refuses, exactly as
     * `buildInlineCtxCore` answers on the shell and the phone.
     */
    localSeat?: boolean;
  } = {}
) {
  const calls = options.calls ?? [];
  const invoked = options.invoked ?? [];
  // Reveals are RECORDED, not just answered: #873's whole rule is that one
  // permit buys exactly one reveal, which is a claim about which call was made
  // and not only about what came back.
  const reveals = options.reveals ?? [];
  return {
    calls,
    invoked,
    reveals,
    vault: {
      read: async (request: ReadCall) => {
        calls.push(request);
        return { rows: rowsByEntity[request.entity] ?? [] };
      },
      reveal: async (request: Record<string, unknown>) => {
        reveals.push(request);
        return { values: options.revealValues ?? {} };
      },
      authenticate: async () => {
        if (options.localSeat)
          throw Object.assign(new Error("authenticate is online-only"), {
            code: "ONLINE_ONLY",
          });
        return {
          authenticated: options.authenticated !== false,
          configured: true,
        };
      },
      invoke: async (request: { command: string; optional?: boolean }) => {
        invoked.push(request);
        if (options.localSeat) {
          if (request.optional !== true)
            throw Object.assign(new Error("invoke is online-only"), {
              code: "ONLINE_ONLY",
            });
          return { status: "failed", reason: "invoke is online-only" };
        }
        return {
          status: "executed",
          output: options.outputs?.[request.command] ?? {},
        };
      },
    },
  };
}

export const LIVE_ITEM = {
  item_id: "item-1",
  type: "login",
  title: "Email",
  username: "alex@example.test",
  url: "https://example.test",
  updated_at: "2026-08-01T00:00:00.000Z",
  password_set_at: "2026-01-01T00:00:00.000Z",
};

/*
 * A revision's snapshot carries the item's SEALED cells exactly as the row held
 * them — ciphertext under the item's own additional data, not the `«sealed»`
 * placeholder a read shows. These stand in for it, so an assertion can say the
 * payload never carries one.
 */
export const OLD_CIPHERTEXT = "ct:v1:GdE9-old-password-ciphertext";
export const OLDER_CIPHERTEXT = "ct:v1:Qq70-older-password-ciphertext";
