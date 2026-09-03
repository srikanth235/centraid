import { createHash } from "node:crypto";

import { describe, expect, test } from "vitest";

import type { ReplicaDigest } from "./digest.js";
import { canonicalJson, intentPayloadHash } from "./payload-hash.js";

const payload = {
  appId: "photos",
  action: "photos.favorite",
  input: { assetId: "asset-1", favorite: true },
};

const CANONICAL =
  '{"action":"photos.favorite","appId":"photos","input":{"assetId":"asset-1","favorite":true}}';
const EXPECTED_HASH =
  "9fb4ce111fbf05254e7437936d9e5082d6888dd4112fe38c8254c6d1beff844f";

const nodeDigest: ReplicaDigest = (input) =>
  Promise.resolve(createHash("sha256").update(input, "utf8").digest("hex"));

describe("intent payload hash identity across platforms", () => {
  test("canonical JSON sorts keys and is the exact hashed string", () => {
    expect(
      canonicalJson({
        action: payload.action,
        appId: payload.appId,
        input: payload.input,
      })
    ).toBe(CANONICAL);
  });

  test("the WebCrypto default matches the pinned fixture hash", async () => {
    await expect(intentPayloadHash(payload)).resolves.toBe(EXPECTED_HASH);
  });

  test("an injected non-WebCrypto digest produces the identical hash", async () => {
    await expect(intentPayloadHash(payload, nodeDigest)).resolves.toBe(
      EXPECTED_HASH
    );
    await expect(intentPayloadHash(payload, nodeDigest)).resolves.toBe(
      await intentPayloadHash(payload)
    );
  });

  test("key insertion order does not change the hash across implementations", async () => {
    const reordered = {
      appId: "photos",
      action: "photos.favorite",
      input: { favorite: true, assetId: "asset-1" },
    };
    await expect(intentPayloadHash(reordered, nodeDigest)).resolves.toBe(
      EXPECTED_HASH
    );
  });
});
