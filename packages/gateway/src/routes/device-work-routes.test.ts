import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { AUTHED_DEVICE_HEADER } from "@centraid/app-engine";
import { forEachSequentially } from "@centraid/test-kit/sequential";
import { tempDir } from "@centraid/test-kit/temp-dir";
import { queueDeviceEnrichmentRequest } from "@centraid/vault";

import { EnrollmentStore } from "../serve/enrollment-store.js";
import { openVaultPlane } from "../serve/vault-plane.js";
import type { VaultRegistry } from "../serve/vault-registry.js";
import { makeBlobRouteHandler } from "./blob-routes.js";
import { makeDeviceWorkRouteHandler } from "./device-work-routes.js";

const cleanups: Array<() => Promise<void> | void> = [];
const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64"
);

describe("device-work-routes", () => {
  afterEach(async () => {
    await forEachSequentially(cleanups.splice(0).toReversed(), (cleanup) =>
      cleanup()
    );
  });

  async function fixture(
    options: { capability?: "poster" | "pdfText" } = {}
  ): Promise<{
    base: string;
    vaultId: string;
    deviceKey: string;
    contribute: () => Promise<Response>;
    derivativeText: (variant: string) => string | null;
  }> {
    const capability = options.capability ?? "poster";
    // The two rungs the DEVICE lane still leases after issue #724's split: a
    // poster frame off a video, and text out of a PDF. Both are format
    // conversion, which is why they stayed on the device.
    const variant = capability === "poster" ? "poster" : "text";
    const sourceMediaType =
      capability === "poster" ? "video/mp4" : "application/pdf";
    const dir = await tempDir(`device-work-${crypto.randomUUID()}-`);
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
    const plane = openVaultPlane({
      bootstrap: true,
      dir: path.join(dir, "vault"),
      logger: silentLogger,
      ownerName: "Priya",
    });
    cleanups.push(() => plane.stop());
    const vaultId = plane.boot.vaultId;
    const deviceKey = "http:worker-device";
    const enrollments = EnrollmentStore.open(path.join(dir, "gateway.db"));
    const enrolled = enrollments.enroll({
      endpointId: deviceKey,
      vaultId,
      label: "Worker",
    });
    enrollments.setCompute(enrolled.enrollmentId, {
      contributeWhileCharging: true,
      capabilities: {
        previews: true,
        poster: true,
        pdfText: true,
        ocr: false,
        embedding: false,
        transcript: false,
        edgeSeal: true,
        backgroundTransfer: false,
      },
    });
    const sourceSha = "a".repeat(64);
    plane.db.vault
      .prepare(
        `INSERT INTO core_content_item
         (content_id, media_type, content_uri, sha256, byte_size, created_at)
       VALUES ('content-1', ?, 'blob:source', ?, 10, '2026-07-15T00:00:00.000Z')`
      )
      .run(sourceMediaType, sourceSha);
    queueDeviceEnrichmentRequest(plane.db.vault, {
      requestId: `${capability}-job`,
      entityType: "core.content_item",
      entityId: "content-1",
      detail: JSON.stringify({
        contentId: "content-1",
        sha256: sourceSha,
        mediaType: sourceMediaType,
      }),
      capability,
      contributionVariant: variant,
    });
    const vaults = {
      get: (id: string) => (id === vaultId ? plane : undefined),
      planesList: () => [plane],
    } as unknown as VaultRegistry;
    const handler = makeDeviceWorkRouteHandler({ vaults, enrollments });
    const blobs = makeBlobRouteHandler({ current: () => plane });
    const server = http.createServer((req, res) => {
      void (async () => {
        if (await handler(req, res)) return;
        if (await blobs(req, res)) return;
        if (!res.headersSent) {
          res.statusCode = 404;
          res.end();
        }
      })();
    });
    cleanups.push(() => {
      server.close();
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;
    return {
      base,
      vaultId,
      deviceKey,
      contribute: () =>
        fetch(
          `${base}/centraid/_vault/blobs?variant=${variant}&variant_of=${sourceSha}&media_type=${capability === "poster" ? "image/png" : "text/plain"}`,
          {
            method: "POST",
            headers: {
              "content-type":
                capability === "poster" ? "image/png" : "text/plain",
            },
            body:
              capability === "poster"
                ? new Uint8Array(PNG_BYTES)
                : "the speaker confirms the starlight rendezvous",
          }
        ),
      derivativeText: (wanted) =>
        (
          plane.db.vault
            .prepare(
              `SELECT text_content FROM core_content_derivative
                WHERE content_id = 'content-1' AND variant = ?`
            )
            .get(wanted) as { text_content: string } | undefined
        )?.text_content ?? null,
    };
  }

  function post(
    base: string,
    pathName: string,
    deviceKey: string,
    body: Record<string, unknown>
  ): Promise<Response> {
    return fetch(`${base}/centraid/_gateway/device-work/${pathName}`, {
      method: "POST",
      headers: {
        [AUTHED_DEVICE_HEADER]: deviceKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  }

  test("eligible device leases and completes a compatible derivative job", async () => {
    const f = await fixture();
    const leased = await post(f.base, "lease", f.deviceKey, {
      vaultId: f.vaultId,
      capabilities: ["poster", "ocr"],
      charging: true,
      unmetered: true,
    });
    expect(leased.status).toBe(200);
    const { lease } = (await leased.json()) as {
      lease: { requestId: string; token: string; capability: string };
    };
    expect(lease).toMatchObject({
      requestId: "poster-job",
      capability: "poster",
    });

    const status = await fetch(
      `${f.base}/centraid/_gateway/device-work/status`,
      {
        headers: { [AUTHED_DEVICE_HEADER]: f.deviceKey },
      }
    );
    expect((await status.json()) as unknown).toMatchObject({
      vaults: [{ total: 1, available: 0, leased: 1 }],
    });

    expect((await f.contribute()).status).toBe(200);
    const completed = await post(f.base, "complete", f.deviceKey, {
      vaultId: f.vaultId,
      requestId: lease.requestId,
      token: lease.token,
    });
    expect(completed.status).toBe(200);
    expect((await completed.json()) as unknown).toStrictEqual({
      completed: true,
    });
  });

  test("lease refuses a device that is not both charging and unmetered", async () => {
    const f = await fixture();
    const response = await post(f.base, "lease", f.deviceKey, {
      vaultId: f.vaultId,
      capabilities: ["poster"],
      charging: false,
      unmetered: true,
    });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toBe(
      "device_not_eligible"
    );
  });

  test("completion without the promised derivative releases the job and returns conflict", async () => {
    const f = await fixture();
    const leased = await post(f.base, "lease", f.deviceKey, {
      vaultId: f.vaultId,
      capabilities: ["poster"],
      charging: true,
      unmetered: true,
    });
    const { lease } = (await leased.json()) as {
      lease: { requestId: string; token: string };
    };
    const refused = await post(f.base, "complete", f.deviceKey, {
      vaultId: f.vaultId,
      requestId: lease.requestId,
      token: lease.token,
    });
    expect(refused.status).toBe(409);
    expect((await refused.json()) as unknown).toStrictEqual({
      completed: false,
    });

    const retry = await post(f.base, "lease", f.deviceKey, {
      vaultId: f.vaultId,
      capabilities: ["poster"],
      charging: true,
      unmetered: true,
    });
    expect(
      ((await retry.json()) as { lease: { attempt: number } }).lease.attempt
    ).toBe(2);
  });

  test("a device contributing extracted PDF text makes it searchable before completion", async () => {
    const f = await fixture({ capability: "pdfText" });
    const leased = await post(f.base, "lease", f.deviceKey, {
      vaultId: f.vaultId,
      // `transcript` is asked for and ignored: it left the device lane in
      // issue #724, so a client that still advertises it leases only pdfText.
      capabilities: ["pdfText", "transcript"],
      charging: true,
      unmetered: true,
    });
    expect(leased.status).toBe(200);
    const { lease } = (await leased.json()) as {
      lease: { requestId: string; token: string; capability: string };
    };
    expect(lease).toMatchObject({
      requestId: "pdfText-job",
      capability: "pdfText",
    });

    expect((await f.contribute()).status).toBe(200);
    const completed = await post(f.base, "complete", f.deviceKey, {
      vaultId: f.vaultId,
      requestId: lease.requestId,
      token: lease.token,
    });
    expect(completed.status).toBe(200);
    await expect(completed.json()).resolves.toStrictEqual({ completed: true });
    // The rung the member actually gets: the PDF's text layer, on the item.
    expect(f.derivativeText("text")).toContain("starlight");
  });
});
