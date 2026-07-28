import { describe, expect, test } from "vitest";

import { requestCasGrant, requestDerivedGrant } from "./cas-grant.js";

const grant = {
  endpoint: "https://storage.example.test",
  region: "auto",
  bucket: "centraid",
  prefix: "vault/",
  accessKeyId: "access-key",
  secretAccessKey: "secret-key",
  expiresAt: 1_700_000_000,
  mode: "read-write" as const,
};

describe("standalone storage grants", () => {
  test("issues the fixed cas and derived store grants without a backup provider", async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      requests.push({ url: String(input), init });
      const body = JSON.parse(String(init?.body)) as {
        store: "cas" | "derived";
      };
      return Response.json({ data: { ...grant, store: body.store } });
    };
    const options = {
      baseUrl: "https://provider.example.test/",
      apiKey: "api-key",
      targetId: "vault/one",
      mode: "read-write" as const,
      fetchImpl,
    };

    await expect(requestCasGrant(options)).resolves.toStrictEqual({
      ...grant,
      store: "cas",
    });
    await expect(requestDerivedGrant(options)).resolves.toStrictEqual({
      ...grant,
      store: "derived",
    });

    expect(requests.map(({ url }) => url)).toStrictEqual([
      "https://provider.example.test/v1/storage/vaults/vault%2Fone/credentials",
      "https://provider.example.test/v1/storage/vaults/vault%2Fone/credentials",
    ]);
    expect(requests.map(({ init }) => init?.body)).toStrictEqual([
      JSON.stringify({ ttlSeconds: 3600, mode: "read-write", store: "cas" }),
      JSON.stringify({
        ttlSeconds: 3600,
        mode: "read-write",
        store: "derived",
      }),
    ]);
  });
});
