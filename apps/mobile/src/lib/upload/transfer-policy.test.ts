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

/** A presigned-looking query, so path/host cases fail on what they are testing. */
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

  // HOSTILE INPUT (#890 follow-up). Everything above drives well-formed URLs
  // that are simply pointed at the wrong place. These are URLs SHAPED to survive
  // the check while meaning something else — the class the original three cases
  // did not reach, and the class that matters, because this function is the only
  // thing standing between a native background PUT and a destination the gateway
  // never authorized.
  //
  // TWO OF THESE WERE ACCEPTED before this change, and both are fixed in
  // transfer-policy.ts rather than pinned as-is:
  //   - percent-encoded traversal, because `new URL()` resolves a literal `../`
  //     before the prefix test sees it but leaves `%2e%2e%2f` untouched;
  //   - embedded credentials, because `origin` omits userinfo, so the host
  //     matched and the credentials rode along to the real provider.
  // A test that asserted the old behaviour would have written the hole down as
  // the specification.
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
      // One decode is one proxy layer. This case is what defeats a check that
      // decodes exactly once and then trusts the result.
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
      // The hole the FIRST version of this fix left open, and the reason the
      // segment split takes both separators. WHATWG URL rewrites a literal `\`
      // to `/` and then normalises it away — but it leaves `%5c` alone, and a
      // `/`-only split never sees `..\..\` as a `..` segment at all.
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
      // Six layers. The first version bounded decoding at four rounds while its
      // comment promised "however many times the far side unescapes", so a
      // deeply-wrapped path walked straight through the check that was supposed
      // to notice.
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
      // The counter-case, and a regression the first version of this fix
      // introduced: `%25` is the correct encoding of a literal `%`, decodes once
      // to `100%done`, and cannot decode again. Treating that second throw as a
      // malformed escape rejected a valid presigned upload and named the wrong
      // cause in the error.
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
      // `%zz` fails on the FIRST decoding round, which means the URL arrived
      // malformed rather than carrying a legitimately encoded `%`. That is the
      // distinction the round counter draws, and the test above
      // ("ACCEPTS a legitimate key containing an encoded percent") is its other
      // half — neither is meaningful without the other.
      await expect(
        assertGatewayMintedUploadUrl(
          "https://provider.example/vault-cas/owners/one/tmp/blobs/%zz" +
            SIGNED,
          scope
        )
      ).rejects.toThrow("outside blob transfer scope");
    });

    test("rejects a host that merely contains the provider's name", async () => {
      // `provider.example.evil.test` and `evilprovider.example` both pass a
      // naive substring or suffix test on the hostname.
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
      // The counterweight. Every case above tightens the check, and a check that
      // rejects everything is not a check — this is the assertion that would go
      // red if one of those tightenings were too broad.
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
