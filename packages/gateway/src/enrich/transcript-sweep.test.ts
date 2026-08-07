// The capability sweep driven through the transcript spec (issue #724 W6):
// behaviour, not mechanism — what a pass writes, what it stamps, that the
// ORIGINAL bytes (not a derivative) are what reaches the service, and that a
// recording with nothing recognizable is an honest empty.
//
// Every case runs against the FAKE ENRICHMENT SERVICE over a real socket —
// same reasoning as `capability-sweep.test.ts`.

import { describe, expect, test } from "vitest";

import { forEachSequentially } from "@centraid/test-kit/sequential";
import {
  bootstrapVault,
  createGateway,
  openVaultDb,
  registerEnrichCommands,
  registerMediaCommands,
  stampedModel,
} from "@centraid/vault";
import type { Credential, VaultDb } from "@centraid/vault";

import { runCapabilitySweep } from "./capability-sweep.js";
import { startFakeEnrichService } from "./fake-enrich-service.test-fixtures.js";
import type { FakeEnrichService } from "./fake-enrich-service.test-fixtures.js";
import { createTranscriptSweepSpec } from "./transcript-sweep.js";

const MODEL = "fake-asr@1";

interface Fixture {
  db: VaultDb;
  owner: Credential;
  gw: ReturnType<typeof createGateway>;
  /** Add a bare audio/video content item with the given original bytes. */
  addRecording: (
    mediaType: "audio/mpeg" | "video/mp4",
    bytes: Buffer
  ) => string;
}

function fixture(tier: "off" | "device" | "gateway" = "gateway"): Fixture {
  const db = openVaultDb();
  const boot = bootstrapVault(db, { ownerName: "Priya" });
  const gw = createGateway(db);
  registerMediaCommands(gw);
  registerEnrichCommands(gw);
  const owner: Credential = {
    kind: "device",
    deviceId: boot.deviceId,
    deviceKey: boot.deviceKey,
  };
  db.vault
    .prepare("UPDATE enrich_policy SET tier = ? WHERE domain = 'docs'")
    .run(tier);

  const addRecording = (
    mediaType: "audio/mpeg" | "video/mp4",
    bytes: Buffer
  ): string => {
    const outcome = gw.invoke(owner, {
      command: "media.add_asset",
      input: {
        kind: mediaType.startsWith("audio/") ? "audio" : "video",
        data_uri: `data:${mediaType};base64,${bytes.toString("base64")}`,
      },
      purpose: "dpv:ServiceProvision",
    });
    expect(outcome.status).toBe("executed");
    return (outcome as { status: "executed"; output: { content_id: string } })
      .output.content_id;
  };

  return { db, owner, gw, addRecording };
}

async function sweep(
  f: Fixture,
  service: FakeEnrichService | null,
  options: { batchSize?: number } = {}
): ReturnType<typeof runCapabilitySweep> {
  return runCapabilitySweep(f.db, createTranscriptSweepSpec(f.gw, f.owner), {
    config: service?.config ?? null,
    call: { timeoutMs: 2_000 },
    ...options,
  });
}

function extractedTextOf(db: VaultDb, contentId: string): string | null {
  const row = db.vault
    .prepare(
      `SELECT text_content FROM core_content_derivative WHERE content_id = ? AND variant = 'transcript'`
    )
    .get(contentId) as { text_content: string } | undefined;
  return row?.text_content ?? null;
}

function stampOf(db: VaultDb, contentId: string): string | null {
  return stampedModel(db.vault, {
    targetType: "content_item",
    targetId: contentId,
    variant: "transcript",
  });
}

describe("capability-sweep (transcripts)", () => {
  test("the ORIGINAL bytes, not a derivative, reach the service", async () => {
    const f = fixture();
    const original = Buffer.from("a whole recording's worth of bytes");
    const service = await startFakeEnrichService({
      capabilities: {
        transcript: {
          result: () => ({ text: "hello world", confidence: 0.8 }),
        },
      },
    });
    const contentId = f.addRecording("audio/mpeg", original);

    const result = await sweep(f, service);

    expect(result.derived).toBe(1);
    const sent = Buffer.from(
      String(service.calls[0]?.items[0]?.["bytes"]),
      "base64"
    );
    expect(sent.equals(original)).toBe(true);
    expect(extractedTextOf(f.db, contentId)).toBe("hello world");
    expect(stampOf(f.db, contentId)).toBe(MODEL);
    const stamp = f.db.vault
      .prepare(
        "SELECT capability, payload_json FROM enrich_derivation WHERE target_id = ?"
      )
      .get(contentId) as { capability: string; payload_json: string };
    expect(stamp.capability).toBe("transcript");
    expect(JSON.parse(stamp.payload_json)).toStrictEqual({ confidence: 0.8 });

    await service.close();
    f.db.close();
  });

  test("a video content item is picked up the same as audio", async () => {
    const f = fixture();
    const service = await startFakeEnrichService({
      capabilities: {
        transcript: { result: () => ({ text: "video words" }) },
      },
    });
    const contentId = f.addRecording("video/mp4", Buffer.from([1, 2, 3, 4]));
    const result = await sweep(f, service);
    expect(result.derived).toBe(1);
    expect(extractedTextOf(f.db, contentId)).toBe("video words");
    await service.close();
    f.db.close();
  });

  test("an empty transcript stamps so the backfill does not loop, but writes no derivative", async () => {
    const f = fixture();
    const service = await startFakeEnrichService({
      capabilities: { transcript: { result: () => ({ text: "" }) } },
    });
    const contentId = f.addRecording("audio/mpeg", Buffer.from([1, 1, 1, 1]));

    const first = await sweep(f, service);
    expect(first.derived).toBe(1);
    expect(extractedTextOf(f.db, contentId)).toBeNull();
    expect(stampOf(f.db, contentId)).toBe(MODEL);

    const second = await sweep(f, service);
    expect(second.derived).toBe(0);
    expect(second.scanned).toBe(0);

    await service.close();
    f.db.close();
  });

  test("a recording past the byte ceiling is skipped, never truncated", async () => {
    const f = fixture();
    const service = await startFakeEnrichService();
    const contentId = f.addRecording("audio/mpeg", Buffer.from([1, 2, 3, 4]));
    // Force the row's declared size past the ceiling without allocating a
    // 200MB buffer in the test itself.
    f.db.vault
      .prepare(
        "UPDATE core_content_item SET byte_size = ? WHERE content_id = ?"
      )
      .run(300 * 1024 * 1024, contentId);

    const result = await sweep(f, service);
    expect(result.skipped).toBe(1);
    expect(result.derived).toBe(0);
    expect(service.calls).toHaveLength(0);

    await service.close();
    f.db.close();
  });

  test("nothing runs — and nothing is asked — while docs enrichment is not at the gateway tier", async () => {
    await forEachSequentially(["off", "device"] as const, async (tier) => {
      const f = fixture(tier);
      const service = await startFakeEnrichService();
      f.addRecording("audio/mpeg", Buffer.from([1, 2, 3, 4]));
      const result = await sweep(f, service);
      expect(result.status).toBe("policy");
      expect(result.derived).toBe(0);
      expect(service.probes()).toBe(0);
      expect(service.calls).toHaveLength(0);
      await service.close();
      f.db.close();
    });
  });

  test("a model version bump re-derives the library and re-stamps the provenance", async () => {
    const f = fixture();
    const first = await startFakeEnrichService({
      capabilities: { transcript: { result: () => ({ text: "v1" }) } },
    });
    const contentId = f.addRecording("audio/mpeg", Buffer.from([7, 7, 7, 7]));
    await sweep(f, first);
    await first.close();
    expect(stampOf(f.db, contentId)).toBe("fake-asr@1");

    const upgraded = await startFakeEnrichService({
      capabilities: {
        transcript: { model: "fake-asr@2", result: () => ({ text: "v2" }) },
      },
    });
    const result = await sweep(f, upgraded);
    expect(result.derived).toBe(1);
    expect(stampOf(f.db, contentId)).toBe("fake-asr@2");
    expect(extractedTextOf(f.db, contentId)).toBe("v2");
    await upgraded.close();
    f.db.close();
  });

  test("one recording the service refuses does not sink the batch", async () => {
    const f = fixture();
    const service = await startFakeEnrichService({
      capabilities: {
        transcript: {
          result: (_item, index) =>
            index === 0 ? { error: "unrecognized codec" } : { text: "ok" },
        },
      },
    });
    const bad = f.addRecording("audio/mpeg", Buffer.from([1, 1, 1, 1]));
    const good = f.addRecording("audio/mpeg", Buffer.from([2, 2, 2, 2]));
    const failures: string[] = [];
    const result = await runCapabilitySweep(
      f.db,
      createTranscriptSweepSpec(f.gw, f.owner),
      {
        config: service.config,
        call: { timeoutMs: 2_000 },
        onFailure: (id) => failures.push(id),
      }
    );
    expect(result.failed).toBe(1);
    expect(result.derived).toBe(1);
    expect(failures).toStrictEqual([bad]);
    expect(extractedTextOf(f.db, good)).toBe("ok");
    await service.close();
    f.db.close();
  });
});
