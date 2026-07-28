import { tempDir } from "@centraid/test-kit/temp-dir";
import { describe, expect, test } from "vitest";

import { GatewayDatabase } from "../serve/gateway-db.js";
import { RecoveryKitStateStore } from "./recovery-kit-state.js";

describe("recovery-kit-state scenarios", () => {
  test("beginning a kit records its fingerprint and leaves it unconfirmed", async () => {
    const database = GatewayDatabase.open(await tempDir("recovery-kit-state-"));
    try {
      const store = new RecoveryKitStateStore(database);
      await store.begin("ordinary-fingerprint");

      await expect(store.status()).resolves.toStrictEqual({
        confirmedAt: null,
        kitFingerprint: "ordinary-fingerprint",
      });
    } finally {
      database.close();
    }
  });

  test("only the exact fingerprint verifies, and a new kit resets confirmation", async () => {
    const database = GatewayDatabase.open(
      await tempDir("recovery-kit-verify-")
    );
    try {
      const store = new RecoveryKitStateStore(
        database,
        () => 1_752_235_200_000
      );
      await store.begin("first-fingerprint");

      await expect(store.verify("wrong-fingerprint")).resolves.toBeUndefined();
      await expect(store.status()).resolves.toMatchObject({
        confirmedAt: null,
      });
      await expect(store.verify("first-fingerprint")).resolves.toStrictEqual({
        confirmedAt: 1_752_235_200,
        kitFingerprint: "first-fingerprint",
      });
      await expect(store.status()).resolves.toStrictEqual({
        confirmedAt: 1_752_235_200,
        kitFingerprint: "first-fingerprint",
      });

      // Exporting a NEW kit supersedes the confirmed one: the operator has to
      // retain and verify the kit they now hold, not the one they replaced.
      await store.begin("second-fingerprint");
      await expect(store.status()).resolves.toStrictEqual({
        confirmedAt: null,
        kitFingerprint: "second-fingerprint",
      });
    } finally {
      database.close();
    }
  });
});
