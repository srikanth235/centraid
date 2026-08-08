// The DEVICE lane (issue #414 D11, narrowed by #724): what a browser may
// lease is previews/poster/pdfText. Model-shaped work — OCR, transcription,
// embedding — is the gateway enrichment service's and never appears here.

import { beforeEach, describe, expect, test } from "vitest";

import { promoteStagedBlob } from "../blob/promote.js";
import { stageBlobBytes } from "../blob/staging.js";
import { openVaultDb } from "../db.js";
import type { VaultDb } from "../db.js";
import {
  completeEnrichmentLease,
  enrichmentQueueDepth,
  leaseNextEnrichmentRequest,
  queueDeviceEnrichmentRequest,
  queueMissingDeviceEnrichmentBacklog,
  releaseEnrichmentLease,
  releaseExpiredEnrichmentLeases,
} from "./leases.js";
import type { EnrichmentCapability } from "./leases.js";

let db: VaultDb;
const T0 = "2026-07-15T00:00:00.000Z";

describe("leases", () => {
  beforeEach(() => {
    db = openVaultDb();
    queueDeviceEnrichmentRequest(db.vault, {
      requestId: "poster-1",
      entityType: "core.content_item",
      entityId: "video-1",
      capability: "poster",
      contributionVariant: "poster",
      requestedAt: T0,
    });
    queueDeviceEnrichmentRequest(db.vault, {
      requestId: "pdf-text-1",
      entityType: "core.content_item",
      entityId: "doc-1",
      capability: "pdfText",
      contributionVariant: "text",
      requestedAt: "2026-07-15T00:00:01.000Z",
    });
  });

  test("capability matching leases only compatible work and reports queue depth", () => {
    expect(enrichmentQueueDepth(db.vault, T0)).toStrictEqual({
      total: 2,
      available: 2,
      leased: 0,
    });
    const pdfText = leaseNextEnrichmentRequest(db.vault, {
      deviceId: "phone",
      capabilities: ["pdfText"],
      now: T0,
      ttlMs: 60_000,
      token: "phone-token",
    });
    expect(pdfText).toMatchObject({
      requestId: "pdf-text-1",
      capability: "pdfText",
      deviceId: "phone",
      token: "phone-token",
      attempt: 1,
    });
    expect(enrichmentQueueDepth(db.vault, T0)).toStrictEqual({
      total: 2,
      available: 1,
      leased: 1,
    });
    // A device asking for work this lane no longer leases gets nothing, and
    // learns it by getting nothing — never by being handed model work.
    expect(
      leaseNextEnrichmentRequest(db.vault, {
        deviceId: "browser",
        capabilities: ["transcript"] as unknown as EnrichmentCapability[],
        now: T0,
        token: "unused",
      })
    ).toBeNull();
  });

  test("one atomic claim excludes a second device until TTL, then expired work re-enters", () => {
    const first = leaseNextEnrichmentRequest(db.vault, {
      deviceId: "laptop-a",
      capabilities: ["poster"],
      now: T0,
      ttlMs: 30_000,
      token: "token-a",
    });
    expect(first?.requestId).toBe("poster-1");
    expect(
      leaseNextEnrichmentRequest(db.vault, {
        deviceId: "laptop-b",
        capabilities: ["poster"],
        now: "2026-07-15T00:00:29.999Z",
        token: "token-b-early",
      })
    ).toBeNull();

    const reclaimed = leaseNextEnrichmentRequest(db.vault, {
      deviceId: "laptop-b",
      capabilities: ["poster"],
      now: "2026-07-15T00:00:30.000Z",
      ttlMs: 30_000,
      token: "token-b",
    });
    expect(reclaimed).toMatchObject({
      requestId: "poster-1",
      deviceId: "laptop-b",
      token: "token-b",
      attempt: 2,
    });
  });

  test("completion is device/token/TTL bound and duplicate completion is a no-op", () => {
    const lease = leaseNextEnrichmentRequest(db.vault, {
      deviceId: "phone",
      capabilities: ["pdfText"],
      now: T0,
      ttlMs: 60_000,
      token: "right-token",
    })!;
    expect(
      completeEnrichmentLease(db.vault, {
        requestId: lease.requestId,
        deviceId: "phone",
        token: "wrong-token",
        now: "2026-07-15T00:00:20.000Z",
      })
    ).toBe(false);
    db.vault
      .prepare(
        `INSERT INTO core_content_item
         (content_id, media_type, content_uri, sha256, byte_size, created_at)
       VALUES ('doc-1', 'application/pdf', 'blob:doc', ?, 10, ?)`
      )
      .run("c".repeat(64), T0);
    db.vault
      .prepare(
        `INSERT INTO core_content_derivative
         (derivative_id, content_id, variant, media_type, byte_size, text_content, created_at)
       VALUES ('text-row', 'doc-1', 'text', 'text/plain', 5, 'hello', ?)`
      )
      .run(T0);
    expect(
      completeEnrichmentLease(db.vault, {
        requestId: lease.requestId,
        deviceId: "phone",
        token: "right-token",
        now: "2026-07-15T00:00:20.000Z",
      })
    ).toBe(true);
    expect(
      completeEnrichmentLease(db.vault, {
        requestId: lease.requestId,
        deviceId: "phone",
        token: "right-token",
        now: "2026-07-15T00:00:21.000Z",
      })
    ).toBe(false);
    expect(enrichmentQueueDepth(db.vault, T0)).toStrictEqual({
      total: 1,
      available: 1,
      leased: 0,
    });
  });

  test("completion without the promised derivative releases the buggy client lease", () => {
    const lease = leaseNextEnrichmentRequest(db.vault, {
      deviceId: "buggy-phone",
      capabilities: ["poster"],
      now: T0,
      ttlMs: 60_000,
      token: "buggy-token",
    })!;
    expect(
      completeEnrichmentLease(db.vault, {
        requestId: lease.requestId,
        deviceId: "buggy-phone",
        token: "buggy-token",
        now: "2026-07-15T00:00:10.000Z",
      })
    ).toBe(false);
    expect(
      (
        db.vault
          .prepare(
            "SELECT lease_device_id FROM enrich_request WHERE request_id = ?"
          )
          .get(lease.requestId) as { lease_device_id: string | null }
      ).lease_device_id
    ).toBeNull();
  });

  test("voluntary release and expiry cleanup make backstop-visible NULL leases", () => {
    const lease = leaseNextEnrichmentRequest(db.vault, {
      deviceId: "desktop",
      capabilities: ["poster"],
      now: T0,
      ttlMs: 30_000,
      token: "desktop-token",
    })!;
    expect(
      releaseEnrichmentLease(db.vault, {
        requestId: lease.requestId,
        deviceId: "desktop",
        token: "desktop-token",
      })
    ).toBe(true);
    expect(
      (
        db.vault
          .prepare(
            "SELECT lease_device_id FROM enrich_request WHERE request_id = ?"
          )
          .get(lease.requestId) as { lease_device_id: string | null }
      ).lease_device_id
    ).toBeNull();

    leaseNextEnrichmentRequest(db.vault, {
      deviceId: "desktop",
      capabilities: ["poster"],
      now: T0,
      ttlMs: 30_000,
      token: "second-token",
    });
    expect(
      releaseExpiredEnrichmentLeases(db.vault, "2026-07-15T00:00:30.000Z")
    ).toBe(1);
    expect(
      enrichmentQueueDepth(db.vault, "2026-07-15T00:00:30.000Z")
    ).toStrictEqual({
      total: 2,
      available: 2,
      leased: 0,
    });
  });

  test("claiming video queues its missing poster, and nothing model-shaped", () => {
    const vault = openVaultDb();
    const staged = stageBlobBytes(vault, {
      bytes: Buffer.from("video bytes"),
      mediaType: "video/mp4",
      filename: "clip.mp4",
    });
    let id = 0;
    const promoted = promoteStagedBlob(
      {
        vault: vault.vault,
        now: T0,
        newId: () => `generated-${++id}`,
        wrote: () => undefined,
        creatorPartyId: null,
      },
      staged.sha256
    );
    const rows = vault.vault
      .prepare(
        `SELECT required_capability, contribution_variant, detail
         FROM enrich_request ORDER BY required_capability`
      )
      .all() as {
      required_capability: string;
      contribution_variant: string;
      detail: string;
    }[];
    expect(
      rows.map((row) => [row.required_capability, row.contribution_variant])
    ).toStrictEqual([["poster", "poster"]]);
    expect(JSON.parse(rows[0]!.detail)).toStrictEqual({
      contentId: promoted.contentId,
      sha256: staged.sha256,
      mediaType: "video/mp4",
    });
  });

  test("standing backfill discovers an old video and vanished ownership returns at TTL", () => {
    const vault = openVaultDb();
    const oldSha = "b".repeat(64);
    vault.vault
      .prepare(
        `INSERT INTO core_content_item
         (content_id, media_type, content_uri, sha256, byte_size, created_at)
       VALUES ('old-video', 'video/webm', ?, ?, 42, ?)`
      )
      .run(`blob:sha256:${oldSha}`, oldSha, T0);
    let id = 0;
    const queued = queueMissingDeviceEnrichmentBacklog(vault.vault, {
      newId: () => `backfill-${++id}`,
      requestedAt: T0,
    });
    expect(queued).toHaveLength(1);
    const first = leaseNextEnrichmentRequest(vault.vault, {
      deviceId: "vanished-phone",
      capabilities: ["poster"],
      now: T0,
      ttlMs: 30_000,
      token: "vanished-token",
    });
    expect(first?.requestId).toBe("backfill-1");
    expect(
      leaseNextEnrichmentRequest(vault.vault, {
        deviceId: "night-laptop",
        capabilities: ["poster"],
        now: "2026-07-15T00:00:30.000Z",
        token: "replacement-token",
      })
    ).toMatchObject({
      requestId: "backfill-1",
      deviceId: "night-laptop",
      attempt: 2,
    });
  });

  test("bounded backfill skips satisfied rows instead of starving later content", () => {
    const vault = openVaultDb();
    const insertContent = vault.vault.prepare(
      `INSERT INTO core_content_item
       (content_id, media_type, content_uri, sha256, byte_size, created_at)
     VALUES (?, 'video/mp4', ?, ?, 42, ?)`
    );
    insertContent.run(
      "a-satisfied",
      `blob:sha256:${"a".repeat(64)}`,
      "a".repeat(64),
      T0
    );
    insertContent.run(
      "b-missing",
      `blob:sha256:${"b".repeat(64)}`,
      "b".repeat(64),
      T0
    );
    const derivative = vault.vault.prepare(
      `INSERT INTO core_content_derivative
       (derivative_id, content_id, variant, sha256, media_type, byte_size, text_content, created_at)
     VALUES (?, 'a-satisfied', ?, ?, ?, 1, ?, ?)`
    );
    derivative.run(
      "done-poster",
      "poster",
      "c".repeat(64),
      "image/png",
      null,
      T0
    );

    let id = 0;
    expect(
      queueMissingDeviceEnrichmentBacklog(vault.vault, {
        newId: () => `fair-${++id}`,
        requestedAt: T0,
        limit: 1,
      })
    ).toStrictEqual(["fair-1"]);
    // node:sqlite hands back null-prototype rows; spreading compares the column
    // data (which is the contract) without asserting the driver's prototype.
    expect(
      vault.vault
        .prepare(
          "SELECT DISTINCT target_id FROM enrich_request ORDER BY target_id"
        )
        .all()
        .map((row) => ({ ...row }))
    ).toStrictEqual([{ target_id: "b-missing" }]);
  });
});
