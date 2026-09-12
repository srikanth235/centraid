/*
 * A PHONE REACHES THE GATEWAY AS ITSELF (#1015, ruling R-NY-18).
 *
 * The companion file `embedded-device-identity.test.ts` pins what must be
 * refused. This one pins what must be RESOLVED: a request the desktop tunnel
 * forwards for phone P is answered as P — P's own enrolment, P's own
 * revocation tombstone — and never as the host whose loopback socket carried
 * it. The Locker key door is the sharpest case, because what it hands back is
 * the key to every secret in the vault.
 *
 * The stamp is derived from the host bearer the forwarder already holds and
 * the phone never sees, so a paired phone cannot mint one for another device,
 * and neither can anything else that reaches 127.0.0.1 without the bearer.
 */

import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import http from "node:http";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { ROUTES } from "@centraid/core/protocol";
import { forEachSequentially } from "@centraid/test-kit/sequential";
import { tempDir } from "@centraid/test-kit/temp-dir";
import {
  DEVICE_PROOF_HEADER,
  forwardIdentityHeaders,
  PHONE_LINK_PATH,
} from "@centraid/tunnel";

import { buildGateway } from "./build-gateway.js";
import type { BuiltGateway } from "./build-gateway.js";

const HOST_ENDPOINT = "host-endpoint-1015";
const PHONE = "ep-phone-1015";
const OTHER_PHONE = "ep-other-phone-1015";

const cleanups: Array<() => Promise<void>> = [];

async function mount(
  gateway: BuiltGateway
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    void gateway.composedHandler(req, res).then((handled) => {
      if (handled) return;
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not_found" }));
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("no bound address");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

interface Fixture {
  readonly url: string;
  readonly token: string;
  /** The desktop's own vouch call, as `phone-link.ts` makes it. */
  readonly vouch: (
    body: Record<string, unknown>
  ) => Promise<{ status: number; body: Record<string, unknown> }>;
  readonly asPhone: (
    route: string,
    endpointId?: string
  ) => Promise<{ status: number; body: Record<string, unknown> }>;
  readonly asHost: (
    route: string
  ) => Promise<{ status: number; body: Record<string, unknown> }>;
}

async function fixture(): Promise<Fixture> {
  const token = crypto.randomBytes(32).toString("hex");
  const dataDir = await tempDir(`tunnelled-phone-${crypto.randomUUID()}-`);
  const gateway = await buildGateway({
    paths: { vaultDir: path.join(dataDir, "vault") },
    hostDeviceEndpointId: HOST_ENDPOINT,
    token,
  });
  const mounted = await mount(gateway);
  cleanups.push(async () => {
    await mounted.close();
    await gateway.stop().catch(() => undefined);
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const read = async (
    response: Response
  ): Promise<{ status: number; body: Record<string, unknown> }> => ({
    status: response.status,
    body: (await response.json().catch(() => ({}))) as Record<string, unknown>,
  });
  return {
    url: mounted.url,
    token,
    vouch: async (body) =>
      read(
        await fetch(`${mounted.url}${PHONE_LINK_PATH}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        })
      ),
    asPhone: async (route, endpointId = PHONE) =>
      read(
        await fetch(`${mounted.url}${route}`, {
          headers: forwardIdentityHeaders(token, endpointId),
        })
      ),
    asHost: async (route) => read(await fetch(`${mounted.url}${route}`)),
  };
}

describe("a tunnelled phone is its own principal", () => {
  afterEach(async () => {
    await forEachSequentially(cleanups.splice(0).toReversed(), (cleanup) =>
      cleanup()
    );
  });

  test("the host vouches for a paired phone, and the phone then opens the key door as itself", async () => {
    const gateway = await fixture();

    // Before the desktop vouches, the phone is nobody: pairing at the QUIC
    // layer is not an enrolment, and the gateway says so rather than falling
    // back to the host.
    const stranger = await gateway.asPhone(ROUTES.vaultSeatLockerKey);
    expect(stranger.status).toBe(403);
    expect(stranger.body["key"]).toBeUndefined();

    const vouched = await gateway.vouch({
      action: "enrol",
      endpointId: PHONE,
      label: "Test iPhone",
      platform: "ios",
    });
    expect(vouched.status).toBe(200);

    const answer = await gateway.asPhone(ROUTES.vaultSeatLockerKey);
    expect(answer.status).toBe(200);
    expect(answer.body["key"]).toBeTypeOf("string");

    // The host's own direct request is unchanged by any of this.
    const host = await gateway.asHost(ROUTES.vaultSeatLockerKey);
    expect(host.status).toBe(200);
    expect(host.body["key"]).toStrictEqual(answer.body["key"]);
  }, 30_000);

  test("revoking the phone shuts every replica door for it, and only for it", async () => {
    const gateway = await fixture();
    await gateway.vouch({ action: "enrol", endpointId: PHONE, label: "Phone" });
    expect((await gateway.asPhone(ROUTES.vaultSeatLockerKey)).status).toBe(200);

    const revoked = await gateway.vouch({
      action: "revoke",
      endpointId: PHONE,
    });
    expect(revoked.status).toBe(200);

    const routes = [
      ROUTES.vaultSeatLockerKey,
      ROUTES.vaultSeatSnapshot,
    ] as const;
    const refusals = await Promise.all(
      routes.map(async (route) => ({
        route,
        answer: await gateway.asPhone(route),
      }))
    );
    for (const { route, answer } of refusals) {
      expect(answer.status, route).toBe(403);
      expect(answer.body["key"], route).toBeUndefined();
    }

    // The host still owns its own box.
    expect((await gateway.asHost(ROUTES.vaultSeatLockerKey)).status).toBe(200);
  }, 30_000);

  test("the stamp is bound to the phone it names, and to the host bearer", async () => {
    const gateway = await fixture();
    await gateway.vouch({ action: "enrol", endpointId: PHONE, label: "Phone" });

    // A stamp minted for another device, replayed under this phone's name.
    const replayed = await fetch(`${gateway.url}${ROUTES.vaultSeatLockerKey}`, {
      headers: {
        ...forwardIdentityHeaders(gateway.token, OTHER_PHONE),
        "x-centraid-device": PHONE,
      },
    });
    expect(replayed.status).toBe(403);

    // A stamp minted without the host bearer.
    const forged = await fetch(`${gateway.url}${ROUTES.vaultSeatLockerKey}`, {
      headers: {
        ...forwardIdentityHeaders(gateway.token, PHONE),
        [DEVICE_PROOF_HEADER]: crypto.randomBytes(32).toString("hex"),
      },
    });
    expect(forged.status).toBe(403);

    // …and the honest stamp still works, so the two refusals above are about
    // the proof rather than about the route.
    expect((await gateway.asPhone(ROUTES.vaultSeatLockerKey)).status).toBe(200);
  }, 30_000);

  test("the vouch plane is host custody only", async () => {
    const gateway = await fixture();
    const forwarded = await fetch(`${gateway.url}${PHONE_LINK_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...forwardIdentityHeaders(gateway.token, PHONE),
      },
      body: JSON.stringify({
        action: "enrol",
        endpointId: OTHER_PHONE,
        label: "Smuggled",
      }),
    });
    expect(forwarded.status).not.toBe(200);

    // Nothing was written: the smuggled endpoint is still nobody.
    const smuggled = await gateway.asPhone(
      ROUTES.vaultSeatLockerKey,
      OTHER_PHONE
    );
    expect(smuggled.status).toBe(403);
  }, 30_000);
});
