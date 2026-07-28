import { describe, expect, test } from "vitest";

import { callProviderRoute } from "./wire-client.js";

describe("provider wire client", () => {
  test("honors a rate-limit Retry-After value before retrying", async () => {
    let attempts = 0;
    const fetchImpl: typeof fetch = async () => {
      attempts++;
      if (attempts === 1)
        return new Response(
          JSON.stringify({ error: { code: "rate_limited" } }),
          {
            status: 429,
            headers: { "retry-after": "0" },
          }
        );
      return Response.json({ data: { accepted: true } });
    };

    await expect(
      callProviderRoute<{ accepted: boolean }>(
        {
          baseUrl: "https://provider.example.test",
          apiKey: "api-key",
          fetchImpl,
          retry: {
            rateLimit: {
              maxAttempts: 2,
              baseDelayMs: 100,
              maxDelayMs: 100,
              maxTotalWaitMs: 100,
            },
          },
        },
        "GET",
        "/v1/storage/test"
      )
    ).resolves.toStrictEqual({ accepted: true });

    expect(attempts).toBe(2);
  });

  test("retries a transient non-JSON server failure before returning its data envelope", async () => {
    const delays: number[] = [];
    const requests: RequestInit[] = [];
    let attempts = 0;
    const fetchImpl: typeof fetch = async (_input, init) => {
      attempts++;
      requests.push(init ?? {});
      if (attempts === 1)
        return new Response("temporarily overloaded", { status: 503 });
      return Response.json({ data: { accepted: true } });
    };

    await expect(
      callProviderRoute<{ accepted: boolean }>(
        {
          baseUrl: "https://provider.example.test/",
          apiKey: "api-key",
          fetchImpl,
          retry: {
            serverError: {
              maxAttempts: 2,
              baseDelayMs: 100,
              maxDelayMs: 100,
              maxTotalWaitMs: 100,
            },
            sleep: async (milliseconds) => {
              delays.push(milliseconds);
            },
            random: () => 0.5,
          },
        },
        "POST",
        "/v1/storage/test",
        { label: "backup" }
      )
    ).resolves.toStrictEqual({ accepted: true });

    expect(delays).toStrictEqual([50]);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      headers: {
        authorization: "Bearer api-key",
        "content-type": "application/json",
      },
      body: JSON.stringify({ label: "backup" }),
    });
  });
});
