import { existsSync, promises as fs, writeFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { tempDir } from "@centraid/test-kit/temp-dir";

import { GatewayDatabase } from "./gateway-db.js";
import { ShareEffectsStore } from "./share-effects.js";

const cleanups: Array<() => void | Promise<void>> = [];

describe(ShareEffectsStore, () => {
  afterEach(async () => {
    await Promise.all(
      cleanups
        .splice(0)
        .toReversed()
        .map((cleanup) => cleanup())
    );
  });

  async function open(): Promise<{
    database: GatewayDatabase;
    effects: ShareEffectsStore;
    dir: string;
  }> {
    const dir = await tempDir("share-effects-");
    const database = GatewayDatabase.open(dir);
    cleanups.push(async () => {
      database.close();
      await fs.rm(dir, { recursive: true, force: true });
    });
    return { database, effects: new ShareEffectsStore(database), dir };
  }

  test("one typed queue deduplicates effects and refuses malformed payloads", async () => {
    const { effects } = await open();
    const input = {
      edgeId: "edge-1",
      kind: "notify-refusal" as const,
      localVaultId: "vault-local",
      peerVaultId: "vault-peer",
      payload: { linkId: "link-1" },
    };
    expect(effects.enqueue(input).effectId).toBe(
      effects.enqueue(input).effectId
    );
    expect(effects.list()).toHaveLength(1);
    expect(() =>
      effects.enqueue({ ...input, payload: { linkId: "" } })
    ).toThrow(/non-empty string/u);
    const effectId = effects.list()[0]!.effectId;
    effects.transition(effectId, "executed");
    expect(() => effects.transition(effectId, "running")).toThrow(
      /illegal share effect transition executed -> running/u
    );
  });

  test("cancelling releases resumable CAS state and terminal history is bounded", async () => {
    const { effects, dir } = await open();
    const tmpPath = path.join(dir, "pull.tmp");
    writeFileSync(tmpPath, "partial");
    const pull = effects.enqueue({
      edgeId: "edge-pull",
      kind: "pull-blob",
      localVaultId: "vault-local",
      peerVaultId: "vault-peer",
      payload: {
        linkId: "link-1",
        sha256: "a".repeat(64),
        size: 100,
        tmpPath,
      },
    });
    effects.cancelEdge("edge-pull");
    expect(existsSync(tmpPath)).toBe(false);
    expect(effects.get(pull.effectId)?.state).toBe("cancelled");

    for (let index = 0; index < 4; index += 1) {
      const effect = effects.enqueue({
        edgeId: `edge-${index}`,
        kind: "notify-refusal",
        localVaultId: "vault-local",
        peerVaultId: "vault-peer",
        payload: { linkId: `link-${index}` },
        now: () => index,
      });
      effects.transition(effect.effectId, "executed", { now: () => index });
    }
    expect(effects.prune({ olderThan: 10, keepNewest: 2 })).toBeGreaterThan(0);
    expect(effects.list()).toHaveLength(2);
  });
});
