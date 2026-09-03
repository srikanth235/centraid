import { describe, expect, test, vi } from "vitest";

import { assertGatewayMintedUploadUrl } from "./transfer-policy";

const scope = {
  gatewayBaseUrl: "http://127.0.0.1:18789",
  fetchImpl: vi.fn<typeof fetch>(async () =>
    Response.json({
      blob_store: {
        kind: "s3",
        endpoint: "https://provider.example",
        allowedUploadPrefix: "/vault-cas/owners/one/tmp/blobs/",
      },
    })
  ),
};

const SIGNED = "?partNumber=1&X-Amz-Expires=600&X-Amz-Signature=abc";

describe("native background transfer policy", () => {
  test("accepts only gateway-presigned temporary objects on the configured provider", async () => {
    const accepted = await assertGatewayMintedUploadUrl(
      "https://provider.example/vault-cas/owners/one/tmp/blobs/direct-one" +
        "?partNumber=1&X-Amz-Expires=600&X-Amz-Signature=abc",
      scope
    );
    expect(accepted.hostname).toBe("provider.example");
  });

  test("rejects arbitrary app-selected HTTPS destinations and non-transfer paths", async () => {
    await expect(
      assertGatewayMintedUploadUrl(
        "https://evil.example/collect?X-Amz-Expires=600&X-Amz-Signature=abc",
        scope
      )
    ).rejects.toThrow("not the active provider");
    await expect(
      assertGatewayMintedUploadUrl(
        "https://provider.example/vault-cas/owners/one/blobs/sha256/secret" +
          "?X-Amz-Expires=600&X-Amz-Signature=abc",
        scope
      )
    ).rejects.toThrow("outside blob transfer scope");
  });

  test("rejects path traversal, unsigned, and cleartext provider URLs", async () => {
    await expect(
      assertGatewayMintedUploadUrl(
        "https://provider.example/vault-cas/owners/one/tmp/blobs/../../blobs/sha256/secret" +
          "?partNumber=1&X-Amz-Expires=600&X-Amz-Signature=abc",
        scope
      )
    ).rejects.toThrow("outside blob transfer scope");
    await expect(
      assertGatewayMintedUploadUrl(
        "https://provider.example/vault-cas/owners/one/tmp/blobs/direct-one" +
          "?partNumber=1&X-Amz-Expires=600",
        scope
      )
    ).rejects.toThrow("not a gateway-presigned capability");
    const cleartext = {
      ...scope,
      fetchImpl: vi.fn<typeof fetch>(async () =>
        Response.json({
          blob_store: {
            kind: "s3",
            endpoint: "http://provider.example",
            allowedUploadPrefix: "/vault-cas/owners/one/tmp/blobs/",
          },
        })
      ),
    };
    await expect(
      assertGatewayMintedUploadUrl(
        "http://provider.example/vault-cas/owners/one/tmp/blobs/direct-one" +
          "?X-Amz-Expires=600&X-Amz-Signature=abc",
        cleartext
      )
    ).rejects.toThrow("not HTTPS");
  });

  describe("hostile input", () => {
    test("rejects percent-encoded traversal that survives URL normalization", async () => {
      await expect(
        assertGatewayMintedUploadUrl(
          "https://provider.example/vault-cas/owners/one/tmp/blobs/" +
            "%2e%2e%2f%2e%2e%2fblobs/sha256/secret" +
            SIGNED,
          scope
        )
      ).rejects.toThrow("outside blob transfer scope");
    });

    test("rejects double-encoded traversal", async () => {
      await expect(
        assertGatewayMintedUploadUrl(
          "https://provider.example/vault-cas/owners/one/tmp/blobs/" +
            "%252e%252e%252f%252e%252e%252fblobs/sha256/secret" +
            SIGNED,
          scope
        )
      ).rejects.toThrow("outside blob transfer scope");
    });

    test("rejects backslash traversal, encoded so URL parsing cannot see it", async () => {
      await expect(
        assertGatewayMintedUploadUrl(
          "https://provider.example/vault-cas/owners/one/tmp/blobs/" +
            "..%5c..%5cblobs/sha256/secret" +
            SIGNED,
          scope
        )
      ).rejects.toThrow("outside blob transfer scope");
      await expect(
        assertGatewayMintedUploadUrl(
          "https://provider.example/vault-cas/owners/one/tmp/blobs/" +
            "%2e%2e%5c%2e%2e%5csecret" +
            SIGNED,
          scope
        )
      ).rejects.toThrow("outside blob transfer scope");
    });

    test("rejects traversal buried under many encoding layers", async () => {
      await expect(
        assertGatewayMintedUploadUrl(
          "https://provider.example/vault-cas/owners/one/tmp/blobs/" +
            "%252525252e%252525252e%252525252fsecret" +
            SIGNED,
          scope
        )
      ).rejects.toThrow("outside blob transfer scope");
    });

    test("ACCEPTS a legitimate key containing an encoded percent", async () => {
      const accepted = await assertGatewayMintedUploadUrl(
        "https://provider.example/vault-cas/owners/one/tmp/blobs/100%25done" +
          SIGNED,
        scope
      );
      expect(accepted.pathname).toBe(
        "/vault-cas/owners/one/tmp/blobs/100%25done"
      );
    });

    test("rejects credentials embedded in the URL", async () => {
      await expect(
        assertGatewayMintedUploadUrl(
          "https://evil:pw@provider.example/vault-cas/owners/one/tmp/blobs/x" +
            SIGNED,
          scope
        )
      ).rejects.toThrow("embedded credentials");
    });

    test("rejects a malformed percent escape in the URL as minted", async () => {
      await expect(
        assertGatewayMintedUploadUrl(
          "https://provider.example/vault-cas/owners/one/tmp/blobs/%zz" +
            SIGNED,
          scope
        )
      ).rejects.toThrow("outside blob transfer scope");
    });

    test("rejects a host that merely contains the provider's name", async () => {
      await expect(
        assertGatewayMintedUploadUrl(
          "https://provider.example.evil.test/vault-cas/owners/one/tmp/blobs/x" +
            SIGNED,
          scope
        )
      ).rejects.toThrow("not the active provider");
      await expect(
        assertGatewayMintedUploadUrl(
          "https://evilprovider.example/vault-cas/owners/one/tmp/blobs/x" +
            SIGNED,
          scope
        )
      ).rejects.toThrow("not the active provider");
    });

    test("rejects the right host on the wrong port", async () => {
      await expect(
        assertGatewayMintedUploadUrl(
          "https://provider.example:8443/vault-cas/owners/one/tmp/blobs/x" +
            SIGNED,
          scope
        )
      ).rejects.toThrow("not the active provider");
    });

    test("rejects the allowed prefix appearing below the root", async () => {
      await expect(
        assertGatewayMintedUploadUrl(
          "https://provider.example/other/vault-cas/owners/one/tmp/blobs/x" +
            SIGNED,
          scope
        )
      ).rejects.toThrow("outside blob transfer scope");
    });

    test("still accepts an ordinary presigned object after all of the above", async () => {
      const accepted = await assertGatewayMintedUploadUrl(
        "https://provider.example/vault-cas/owners/one/tmp/blobs/" +
          "9f2a1c-part-1" +
          SIGNED,
        scope
      );
      expect(accepted.pathname).toBe(
        "/vault-cas/owners/one/tmp/blobs/9f2a1c-part-1"
      );
    });
  });
});
