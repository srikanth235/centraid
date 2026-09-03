import { afterEach, describe, expect, test } from "vitest";

import { startFakeProviderServer } from "@centraid/backup/dist/testing/fake-provider-server.js";
import { forEachSequentially } from "@centraid/test-kit/sequential";
import { tempDir } from "@centraid/test-kit/temp-dir";

import { openStorageConnectionStore } from "./storage-connections.js";
import { ensureProviderCasTarget } from "./storage-credentials.js";

const cleanups: Array<() => Promise<void> | void> = [];
describe("storage-credentials", () => {
  afterEach(async () => {
    await forEachSequentially(cleanups.splice(0).toReversed(), (cleanup) =>
      cleanup()
    );
  });
  test("ensureProviderCasTarget stamps the declared storage-class list (issue #425 Wave 3)", async () => {
    const provider = await startFakeProviderServer();
    cleanups.push(() => provider.close());
    const store = await openStorageConnectionStore(await tempDir());
    const connection = await store.create({
      kind: "provider",
      name: "Clawgnition",
      baseUrl: provider.url,
      apiKey: provider.apiKey,
    });

    const target = await ensureProviderCasTarget(store, connection.id);

    expect(target.supportedStorageClasses).toStrictEqual([
      "STANDARD",
      "STANDARD_IA",
    ]);
    expect(target.derivedPrefix).toBeTruthy();
    expect(target.bucket).toBeTruthy();
    expect(target.prefix).toBeTruthy();
  });
});
