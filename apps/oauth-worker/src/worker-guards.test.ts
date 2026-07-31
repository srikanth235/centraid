/**
 * Fail-closed guard laws for the Assist courier (#656 Layer 3 mutation seed).
 *
 * `index.test.ts` proves the happy path and the headline refusals. What it did
 * not prove is that each guard's BOUNDARY is where the code says it is: a
 * mutant that unanchors the client-id regex, turns `>= 32` into `> 32`, ORs
 * the loopback checks together, accepts a duplicated scope, or lets `every`
 * become `some` in the scope comparison all survived. Those are the exact
 * shapes an attacker probes.
 *
 * Every test drives the real `handleRequest` and asserts the refusal (or
 * acceptance) that the guard is FOR — never an internal call count.
 */
import { describe, expect, test, vi } from "vitest";

import { handleRequest } from "./worker.js";

const NOW = Date.UTC(2026, 6, 23, 10, 0, 0);
const STATE = `w.${"A".repeat(43)}`;
const VERIFIER = "v".repeat(43);
const CODE = "google-authorization-code";
const BROWSER_BINDING = "b".repeat(43);
const PUBLIC_ORIGIN = "https://oauth.centraid.dev";
const DEV_ORIGIN = "http://127.0.0.1:8787";
const CALENDAR = "https://www.googleapis.com/auth/calendar.events";
const CONTACTS = "https://www.googleapis.com/auth/contacts";
const GMAIL = "https://www.googleapis.com/auth/gmail.readonly";

const context = {} as ExecutionContext;

// `Env` is generated from wrangler.jsonc with literal string types, so a
// deliberately-wrong value is not assignable; take the patch untyped.
function environment(patch: Record<string, unknown> = {}): Env {
  return {
    APP_ORIGIN: "https://app.centraid.dev",
    CALLBACK_URL: "https://oauth.centraid.dev/callback",
    CALLBACK_RECEIPT_SECRET: "receipt-secret-with-at-least-thirty-two-bytes",
    EXCHANGE_ENABLED: "true",
    GLOBAL_LIMITER: { limit: async () => ({ success: true }) } as RateLimit,
    GOOGLE_CLIENT_ID: "shared.apps.googleusercontent.com",
    GOOGLE_CLIENT_SECRET: "worker-only-google-secret",
    IP_LIMITER: { limit: async () => ({ success: true }) } as RateLimit,
    METRICS: {
      writeDataPoint: vi.fn<() => void>(),
    } as unknown as AnalyticsEngineDataset,
    RESTRICTED_SCOPES_ENABLED: "false",
    ...patch,
  } as Env;
}

/** Any request that gets past routing — `/start` needs no body or cookie. */
async function probe(env: Env, origin = PUBLIC_ORIGIN): Promise<Response> {
  return handleRequest(new Request(`${origin}/start`), env, context, {
    fetch,
    now: () => NOW,
  });
}

async function bindCookie(env: Env, origin = PUBLIC_ORIGIN): Promise<string> {
  const response = await handleRequest(
    new Request(`${origin}/bind`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": "203.0.113.7",
      },
      body: JSON.stringify({ state: STATE, browser_binding: BROWSER_BINDING }),
    }),
    env,
    context,
    { fetch, now: () => NOW }
  );
  expect(response.status).toBe(204);
  return (response.headers.get("set-cookie") as string).split(
    ";",
    1
  )[0] as string;
}

async function receiptFor(env: Env): Promise<string> {
  const cookie = await bindCookie(env);
  const response = await handleRequest(
    new Request(
      `${PUBLIC_ORIGIN}/callback?state=${encodeURIComponent(STATE)}&code=${encodeURIComponent(CODE)}`,
      { headers: { cookie, "cf-connecting-ip": "203.0.113.7" } }
    ),
    env,
    context,
    { fetch, now: () => NOW }
  );
  expect(response.status).toBe(303);
  const location = new URL(response.headers.get("location") as string);
  return new URLSearchParams(location.hash.slice(1)).get("receipt") as string;
}

interface ExchangeOptions {
  bodyPatch?: Record<string, unknown>;
  upstream?: { status: number; body: unknown };
  env?: Env;
}

/** Run a fully-formed /exchange, stubbing Google's token endpoint. */
async function exchange(options: ExchangeOptions = {}): Promise<{
  status: number;
  json: Record<string, unknown>;
}> {
  const env = options.env ?? environment();
  const receipt = await receiptFor(env);
  const upstream = options.upstream ?? {
    status: 200,
    body: { access_token: "at", token_type: "Bearer", scope: CALENDAR },
  };
  const fetchImpl = vi.fn<() => Promise<Response>>(
    async () =>
      new Response(JSON.stringify(upstream.body), {
        status: upstream.status,
        headers: { "content-type": "application/json" },
      })
  );
  const response = await handleRequest(
    new Request(`${PUBLIC_ORIGIN}/exchange`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": "203.0.113.7",
      },
      body: JSON.stringify({
        provider: "google",
        code: CODE,
        code_verifier: VERIFIER,
        redirect_uri: "https://oauth.centraid.dev/callback",
        state: STATE,
        browser_binding: BROWSER_BINDING,
        scopes: [CALENDAR],
        receipt,
        ...options.bodyPatch,
      }),
    }),
    env,
    context,
    { fetch: fetchImpl as unknown as typeof fetch, now: () => NOW }
  );
  return {
    status: response.status,
    json: (await response.json()) as Record<string, unknown>,
  };
}

describe("environment invariants", () => {
  test("a fully-formed production environment serves", async () => {
    expect((await probe(environment())).status).toBe(200);
  });

  test("the client id must be an exact googleusercontent id, anchored at both ends", async () => {
    const rejected = [
      "shared.apps.googleusercontent.com.evil.test", // suffix must be the END
      "https://evil.test/shared.apps.googleusercontent.com", // and the START
      "ab.apps.googleusercontent.com", // shorter than the 3-char minimum
      "shared.apps.googleusercontent.co",
      "shared apps.googleusercontent.com",
      "",
    ];
    const rejections = await Promise.all(
      rejected.map(async (id) => {
        const response = await probe(environment({ GOOGLE_CLIENT_ID: id }));
        return { id, status: response.status, body: await response.json() };
      })
    );
    for (const { id, status, body } of rejections) {
      expect(status, id).toBe(503);
      expect(body, id).toStrictEqual({ error: "configuration_error" });
    }
    // Exactly three characters ahead of the suffix is the boundary, and it holds.
    expect(
      (
        await probe(
          environment({ GOOGLE_CLIENT_ID: "abc.apps.googleusercontent.com" })
        )
      ).status
    ).toBe(200);
  });

  test("secret-length floors are inclusive, and one byte short fails closed", async () => {
    const floors = [
      ["GOOGLE_CLIENT_SECRET", 16],
      ["CALLBACK_RECEIPT_SECRET", 32],
    ] as const;
    const results = await Promise.all(
      floors.flatMap(([key, floor]) =>
        [
          [floor - 1, 503],
          [floor, 200],
        ].map(async ([length, expected]) => ({
          label: `${key} @ ${length}`,
          expected,
          status: (
            await probe(environment({ [key]: "s".repeat(length as number) }))
          ).status,
        }))
      )
    );
    for (const { label, expected, status } of results) {
      expect(status, label).toBe(expected);
    }
  });

  test("the two feature flags must be the literal strings true or false", async () => {
    const keys = ["EXCHANGE_ENABLED", "RESTRICTED_SCOPES_ENABLED"] as const;
    const cases = keys.flatMap((key) => [
      ...["yes", "1", "TRUE", "", "on"].map(
        (value) => [key, value, 503] as const
      ),
      ...["true", "false"].map((value) => [key, value, 200] as const),
    ]);
    const results = await Promise.all(
      cases.map(async ([key, value, expected]) => ({
        label: `${key}=${value}`,
        expected,
        status: (await probe(environment({ [key]: value }))).status,
      }))
    );
    for (const { label, expected, status } of results) {
      expect(status, label).toBe(expected);
    }
  });

  test("production pins BOTH the app origin and the callback url", async () => {
    expect(
      (await probe(environment({ APP_ORIGIN: "https://evil.test" }))).status
    ).toBe(503);
    expect(
      (
        await probe(
          environment({ CALLBACK_URL: "https://oauth.centraid.dev/other" })
        )
      ).status
    ).toBe(503);
    // Loopback is not an acceptable app origin on the PUBLIC hostname.
    expect(
      (await probe(environment({ APP_ORIGIN: "http://127.0.0.1:3000" }))).status
    ).toBe(503);
  });

  test("development accepts a loopback app origin — and only a bare origin", async () => {
    const dev = (appOrigin: string): Env =>
      environment({
        APP_ORIGIN: appOrigin,
        CALLBACK_URL: `${DEV_ORIGIN}/callback`,
      });
    const cases = [
      ...[
        "http://127.0.0.1:3000",
        "http://localhost:5173",
        "https://localhost:8443",
        "http://[::1]:1234",
      ].map((origin) => [origin, 200] as const),
      ...[
        "http://127.0.0.1:3000/", // a trailing slash is a URL, not an origin
        "http://127.0.0.1:3000/app",
        "http://127.0.0.2:3000", // near-miss loopback address
        "http://evil.test",
        "ftp://127.0.0.1", // only http(s) may be an app origin
        "not a url",
        "",
      ].map((origin) => [origin, 503] as const),
    ];
    const results = await Promise.all(
      cases.map(async ([origin, expected]) => ({
        origin,
        expected,
        status: (await probe(dev(origin), DEV_ORIGIN)).status,
      }))
    );
    for (const { origin, expected, status } of results) {
      expect(status, origin).toBe(expected);
    }
  });

  test("development still pins its own callback url", async () => {
    expect(
      (
        await probe(
          environment({
            APP_ORIGIN: "http://127.0.0.1:3000",
            CALLBACK_URL: "https://oauth.centraid.dev/callback",
          }),
          DEV_ORIGIN
        )
      ).status
    ).toBe(503);
  });

  test("an unknown hostname never reaches the environment check at all", async () => {
    const response = await handleRequest(
      new Request("https://oauth.centraid.test/start"),
      environment(),
      context,
      { fetch, now: () => NOW }
    );
    expect(response.status).toBe(421);
    await expect(response.json()).resolves.toStrictEqual({
      error: "invalid_origin",
    });
  });
});

describe("requested-scope validation", () => {
  test("a well-formed allowlisted request is accepted", async () => {
    expect((await exchange()).status).toBe(200);
  });

  test("the scopes field must be a non-empty array of allowlisted strings", async () => {
    const invalid = [
      undefined,
      null,
      "calendar",
      {},
      [],
      [CALENDAR, 7],
      [CALENDAR, null],
      ["https://www.googleapis.com/auth/calendar"], // near-miss scope
      [`${CALENDAR} `], // trailing space is a different scope
    ];
    const results = await Promise.all(
      invalid.map(async (scopes) => ({
        label: JSON.stringify(scopes) ?? "undefined",
        result: await exchange({ bodyPatch: { scopes } }),
      }))
    );
    for (const { label, result } of results) {
      expect(result.status, label).toBe(400);
      expect(result.json.error, label).toBe("invalid_body");
    }
  });

  test("a duplicated scope is rejected rather than silently deduplicated", async () => {
    const result = await exchange({
      bodyPatch: { scopes: [CALENDAR, CALENDAR] },
    });
    expect(result.status).toBe(400);
    expect(result.json.error).toBe("invalid_body");
  });

  test("more scopes than the allowlist can hold is rejected before any lookup", async () => {
    const tooMany = Array.from({ length: 6 }, (_, i) => `${CALENDAR}#${i}`);
    expect((await exchange({ bodyPatch: { scopes: tooMany } })).status).toBe(
      400
    );
  });

  test("restricted scopes are refused until the flag is on", async () => {
    const refused = await exchange({ bodyPatch: { scopes: [GMAIL] } });
    expect(refused.status).toBe(400);
    expect(refused.json.error).toBe("invalid_body");

    const enabled = environment({ RESTRICTED_SCOPES_ENABLED: "true" });
    const allowed = await exchange({
      env: enabled,
      bodyPatch: { scopes: [GMAIL] },
      upstream: {
        status: 200,
        body: { access_token: "at", token_type: "Bearer", scope: GMAIL },
      },
    });
    expect(allowed.status).toBe(200);
  });

  test("standard scopes keep working while the restricted flag is on", async () => {
    const enabled = environment({ RESTRICTED_SCOPES_ENABLED: "true" });
    const result = await exchange({
      env: enabled,
      bodyPatch: { scopes: [CALENDAR, CONTACTS] },
      upstream: {
        status: 200,
        body: {
          access_token: "at",
          token_type: "Bearer",
          scope: `${CALENDAR} ${CONTACTS}`,
        },
      },
    });
    expect(result.status).toBe(200);
  });
});

describe("granted-scope comparison", () => {
  const granted = async (scope: unknown) =>
    exchange({
      bodyPatch: { scopes: [CALENDAR, CONTACTS] },
      upstream: {
        status: 200,
        body: { access_token: "at", token_type: "Bearer", scope },
      },
    });

  test("order and repeated whitespace do not matter", async () => {
    const spellings = [
      `${CALENDAR} ${CONTACTS}`,
      `${CONTACTS} ${CALENDAR}`,
      `  ${CONTACTS}   ${CALENDAR}  `,
      `${CONTACTS}\t${CALENDAR}`,
    ];
    const results = await Promise.all(
      spellings.map(async (scope) => ({
        scope,
        status: (await granted(scope)).status,
      }))
    );
    for (const { scope, status } of results) expect(status, scope).toBe(200);
  });

  test("a missing, extra, or substituted scope is an upstream failure", async () => {
    const mismatched = [
      CALENDAR, // one short
      `${CALENDAR} ${CONTACTS} ${GMAIL}`, // one extra — the dangerous case
      `${CALENDAR} ${CALENDAR}`, // duplicate standing in for the second
      "",
      "   ",
      42,
      null,
      undefined,
      "x".repeat(4097),
    ];
    const results = await Promise.all(
      mismatched.map(async (scope) => ({
        label: String(scope).slice(0, 40),
        result: await granted(scope),
      }))
    );
    for (const { label, result } of results) {
      expect(result.status, label).toBe(502);
      expect(result.json, label).toStrictEqual({
        error: "invalid_upstream_response",
      });
    }
  });

  test("refresh does not police scopes — it has none to compare against", async () => {
    const env = environment();
    const fetchImpl = vi.fn<() => Promise<Response>>(
      async () =>
        new Response(
          JSON.stringify({ access_token: "at", token_type: "Bearer" }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
    );
    const response = await handleRequest(
      new Request(`${PUBLIC_ORIGIN}/refresh`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-connecting-ip": "203.0.113.7",
        },
        body: JSON.stringify({ provider: "google", refresh_token: "rt" }),
      }),
      env,
      context,
      { fetch: fetchImpl as unknown as typeof fetch, now: () => NOW }
    );
    expect(response.status).toBe(200);
  });
});

describe("bounded string fields", () => {
  test("an empty or over-long access token is not a usable token", async () => {
    const unusable = ["", 0, null, "x".repeat(16 * 1024 + 1)];
    const results = await Promise.all(
      unusable.map(async (accessToken) => ({
        label: String(accessToken).slice(0, 20),
        status: (
          await exchange({
            upstream: {
              status: 200,
              body: {
                access_token: accessToken,
                token_type: "Bearer",
                scope: CALENDAR,
              },
            },
          })
        ).status,
      }))
    );
    for (const { label, status } of results) expect(status, label).toBe(502);
    // Exactly at the ceiling is still fine — the bound is inclusive.
    const atLimit = await exchange({
      upstream: {
        status: 200,
        body: {
          access_token: "x".repeat(16 * 1024),
          token_type: "Bearer",
          scope: CALENDAR,
        },
      },
    });
    expect(atLimit.status).toBe(200);
    expect(atLimit.json.access_token as string).toHaveLength(16 * 1024);
  });

  test("an over-long refresh token is dropped, not forwarded", async () => {
    const result = await exchange({
      upstream: {
        status: 200,
        body: {
          access_token: "at",
          refresh_token: "y".repeat(16 * 1024 + 1),
          token_type: "Bearer",
          scope: CALENDAR,
        },
      },
    });
    expect(result.status).toBe(200);
    expect("refresh_token" in result.json).toBe(false);
  });

  test("request fields are length-bounded before the receipt is even checked", async () => {
    // `code` is bounded at 4096 and `code_verifier` at 128; an empty string is
    // as invalid as an over-long one.
    const patches = [
      { code: "" },
      { code: "c".repeat(4097) },
      { code_verifier: "" },
      { code_verifier: "v".repeat(129) },
      { state: "" },
      { browser_binding: "" },
      { receipt: "" },
      { code: 5 },
    ];
    const results = await Promise.all(
      patches.map(async (bodyPatch) => ({
        label: JSON.stringify(bodyPatch).slice(0, 40),
        result: await exchange({ bodyPatch }),
      }))
    );
    for (const { label, result } of results) {
      expect(result.status, label).toBe(400);
      expect(result.json.error, label).toBe("invalid_body");
    }
  });
});

describe("upstream error passthrough", () => {
  const upstreamError = async (status: number, error: unknown) =>
    exchange({ upstream: { status, body: { error } } });

  test("a snake_case Google error code is passed through verbatim", async () => {
    const result = await upstreamError(400, "invalid_grant");
    expect(result.status).toBe(400);
    expect(result.json).toStrictEqual({ error: "invalid_grant" });
  });

  test("anything that is not a bare snake_case token is replaced", async () => {
    const notCodes = [
      "Invalid Grant",
      "invalid-grant",
      "invalid grant",
      "<script>x</script>",
      "a".repeat(65),
      "",
      42,
      null,
      { code: "invalid_grant" },
    ];
    const results = await Promise.all(
      notCodes.map(async (error) => ({
        label: JSON.stringify(error) ?? "undefined",
        result: await upstreamError(400, error),
      }))
    );
    for (const { label, result } of results) {
      expect(result.json, label).toStrictEqual({
        error: "oauth_upstream_error",
      });
    }
  });

  test("a 429 or 5xx is transient (503); other failures are the caller's (400)", async () => {
    expect((await upstreamError(429, "rate_limited")).status).toBe(503);
    expect((await upstreamError(500, "server_error")).status).toBe(503);
    expect((await upstreamError(503, "server_error")).status).toBe(503);
    expect((await upstreamError(400, "invalid_grant")).status).toBe(400);
    expect((await upstreamError(401, "invalid_client")).status).toBe(400);
  });
});
