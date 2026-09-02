/*
 * The owner's door onto the enrichment policy cascade (#807).
 *
 * The laws under test are the ones a member's privacy depends on: a rule may
 * be written only for a scope and a capability this build understands; the
 * `effective` read is the ONE resolver's answer rather than a second opinion
 * assembled in the route; and the legacy tier resource keeps its exact
 * pre-#807 request and response shapes, because four client seam laws pin
 * them.
 */
import http from "node:http";

import { afterEach, describe, expect, test } from "vitest";

import { forEachSequentially } from "@centraid/test-kit/sequential";
import { tempDir } from "@centraid/test-kit/temp-dir";

import { openVaultRegistry } from "../serve/vault-registry.js";
import { makeVaultRouteHandler } from "./vault-routes.js";

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const cleanups: Array<() => Promise<void> | void> = [];

describe("vault enrichment cascade routes", () => {
  afterEach(async () => {
    await forEachSequentially(cleanups.splice(0).toReversed(), (cleanup) =>
      cleanup()
    );
  });

  async function setup(): Promise<string> {
    const dir = await tempDir();
    const registry = openVaultRegistry({
      rootDir: dir,
      logger: silentLogger,
      ownerName: "Priya",
    });
    registry.create("Personal");
    cleanups.push(() => registry.stop());
    const handler = makeVaultRouteHandler(registry);
    const server = http.createServer((req, res) => {
      void handler(req, res).then((owned) => {
        if (!owned) {
          res.statusCode = 404;
          res.end("{}");
        }
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        })
    );
    const addr = server.address() as { port: number };
    return `http://127.0.0.1:${addr.port}`;
  }

  const putRule = (base: string, body: unknown) =>
    fetch(`${base}/centraid/_vault/enrich/rules`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  test("writes a scoped rule and reads it back from the vault, not the request", async () => {
    const base = await setup();

    const res = await putRule(base, {
      scope: "domain",
      ref: "photos",
      capability: "ocr",
      trigger: "on-view",
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      rule: {
        scope: { type: "domain", ref: "photos" },
        capability: "ocr",
        // The fields the scope did NOT decide come back as inherit, which is
        // the whole point of a rule stating only its own decision.
        enabled: null,
        profile: null,
        trigger: "on-view",
      },
    });

    const listed = await fetch(`${base}/centraid/_vault/enrich`);
    const body = (await listed.json()) as {
      enrich: Record<string, string>;
      rules: unknown[];
    };
    // Additive: the legacy tiers are exactly where they were.
    expect(body.enrich).toStrictEqual({ photos: "gateway", docs: "gateway" });
    expect(body.rules).toHaveLength(1);
  });

  test("refuses a rule that decides nothing, naming the way out", async () => {
    const base = await setup();

    const res = await putRule(base, {
      scope: "vault",
      capability: "ocr",
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: "bad_request",
      message: expect.stringContaining("must decide something") as unknown,
    });
  });

  test.each([
    [{ scope: "album", ref: "a1", capability: "ocr", enabled: true }, "scope"],
    [{ scope: "vault", ref: "nope", capability: "ocr", enabled: true }, "ref"],
    [
      { scope: "domain", ref: "tally", capability: "ocr", enabled: true },
      "domain",
    ],
    [{ scope: "vault", capability: "invented", enabled: true }, "capability"],
    [{ scope: "vault", capability: "ocr", trigger: "whenever" }, "trigger"],
  ])("refuses %j", async (body, mentions) => {
    const base = await setup();
    const res = await putRule(base, body);
    expect(res.status).toBe(400);
    const answer = (await res.json()) as { message: string };
    expect(answer.message).toContain(mentions);
  });

  test("a delete makes the scope stop deciding, so the level above is inherited again", async () => {
    const base = await setup();
    await putRule(base, {
      scope: "collection",
      ref: "album-1",
      capability: "ocr",
      enabled: false,
    });

    const before = await fetch(
      `${base}/centraid/_vault/enrich/effective?domain=photos&capability=ocr&scope=collection:album-1`
    );
    await expect(before.json()).resolves.toMatchObject({
      effective: { enabled: false },
    });

    const deleted = await fetch(
      `${base}/centraid/_vault/enrich/rules?scope=collection&ref=album-1&capability=ocr`,
      { method: "DELETE" }
    );
    expect(deleted.status).toBe(200);

    const after = await fetch(
      `${base}/centraid/_vault/enrich/effective?domain=photos&capability=ocr&scope=collection:album-1`
    );
    await expect(after.json()).resolves.toMatchObject({
      effective: { enabled: true },
      rules: [],
    });
  });

  test("the effective read is the resolver's fold — ceiling from the tier, fields from the deepest rule", async () => {
    const base = await setup();
    await fetch(`${base}/centraid/_vault/enrich`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ photos: "device" }),
    });
    await putRule(base, {
      scope: "vault",
      capability: "ocr",
      profile: "vault-choice",
      trigger: "on-ingest",
    });
    await putRule(base, {
      scope: "item",
      ref: "asset-9",
      capability: "ocr",
      profile: "item-choice",
    });

    const res = await fetch(
      `${base}/centraid/_vault/enrich/effective?domain=photos&capability=ocr&scope=item:asset-9`
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      tier: "device",
      effective: {
        capability: "ocr",
        enabled: true,
        profileId: "item-choice",
        trigger: "on-ingest",
        // The item picked an engine; it could not move the ceiling.
        egressCeiling: "on-device",
      },
    });
  });

  const postConsent = (base: string, body: unknown) =>
    fetch(`${base}/centraid/_vault/enrich/consent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  test("records an answer through the vault's one writer and reads it back", async () => {
    const base = await setup();

    const empty = await fetch(`${base}/centraid/_vault/enrich/consent`);
    expect(empty.status).toBe(200);
    await expect(empty.json()).resolves.toStrictEqual({ consent: [] });

    const recorded = await postConsent(base, {
      capability: "faces",
      egress: "provider",
      decision: "granted",
    });
    expect(recorded.status).toBe(200);
    await expect(recorded.json()).resolves.toMatchObject({
      consent: {
        capability: "faces",
        egress: "provider",
        scopeRef: "",
        decision: "granted",
      },
    });

    // A decline is a RECORD, not a deletion — the ledger keeps the answer.
    const declined = await postConsent(base, {
      capability: "faces",
      egress: "provider",
      decision: "declined",
    });
    expect(declined.status).toBe(200);
    const listed = await fetch(`${base}/centraid/_vault/enrich/consent`);
    const body = (await listed.json()) as {
      consent: { decision: string; decidedAt: string }[];
    };
    expect(body.consent).toHaveLength(1);
    expect(body.consent[0]?.decision).toBe("declined");
    expect(body.consent[0]?.decidedAt).toStrictEqual(expect.any(String));
  });

  test("refuses an answer to a question this build cannot ask", async () => {
    const base = await setup();

    await forEachSequentially(
      [
        { capability: "invented", egress: "provider", decision: "granted" },
        { capability: "faces", egress: "the-moon", decision: "granted" },
        { capability: "faces", egress: "provider", decision: "maybe" },
      ],
      async (body) => {
        const res = await postConsent(base, body);
        expect(res.status).toBe(400);
      }
    );
    const listed = await fetch(`${base}/centraid/_vault/enrich/consent`);
    await expect(listed.json()).resolves.toStrictEqual({ consent: [] });
  });

  test("an unknown domain or capability is a 400, never an empty answer", async () => {
    const base = await setup();

    const domain = await fetch(
      `${base}/centraid/_vault/enrich/effective?domain=tally&capability=ocr`
    );
    expect(domain.status).toBe(400);

    const capability = await fetch(
      `${base}/centraid/_vault/enrich/effective?domain=photos&capability=invented`
    );
    expect(capability.status).toBe(400);
  });
});
