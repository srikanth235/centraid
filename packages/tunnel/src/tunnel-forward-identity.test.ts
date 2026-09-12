/*
 * THE PHONE REACHES THE GATEWAY AS ITSELF (#1015, ruling R-NY-18).
 *
 * The desktop forwarder authenticates a phone at the QUIC layer and then
 * spoke to the loopback gateway AS THE HOST: it deleted every client identity
 * header and stamped only "this hop was forwarded". Loopback is not an
 * identity (#568), so the gateway had nothing left to resolve and fell back
 * to the host's own enrolment — which made a paired phone the owner of the
 * box at every vault door, the Locker key door included.
 *
 * What this file pins is the first half of the repair: the forwarder names
 * the phone it just authenticated, and carries a proof of that naming which
 * the phone itself never sees and so cannot mint for another device.
 */

import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { tempDirSync } from "@centraid/test-kit/temp-dir";

import { createTunnelClient, tunnelRequest } from "./client.js";
import type { TunnelClient } from "./client.js";
import { startDesktopTunnel } from "./desktop-tunnel.js";
import type { DesktopTunnelHandle } from "./desktop-tunnel.js";
import { DeviceStore } from "./device-store.js";
import {
  DEVICE_IDENTITY_HEADER,
  DEVICE_PROOF_HEADER,
  parsePairQrPayload,
  TUNNEL_FORWARDED_HEADER,
} from "./protocol.js";

vi.setConfig({ testTimeout: 30_000 });

const TOKEN = crypto.randomBytes(16).toString("hex");

interface SeenRequest {
  readonly headers: http.IncomingHttpHeaders;
}

function startCapturingUpstream(): Promise<{
  server: http.Server;
  baseUrl: string;
  seen: SeenRequest[];
}> {
  const seen: SeenRequest[] = [];
  const server = http.createServer((req, res) => {
    seen.push({ headers: req.headers });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}`, seen });
    });
  });
}

describe("the desktop forwarder names the phone it authenticated", () => {
  let upstream: Awaited<ReturnType<typeof startCapturingUpstream>>;
  let desktop: DesktopTunnelHandle;
  let store: DeviceStore;
  let phone: TunnelClient;

  beforeAll(async () => {
    upstream = await startCapturingUpstream();
    store = DeviceStore.open(
      path.join(tempDirSync("centraid-forward-identity-"), "devices.json")
    );
    desktop = await startDesktopTunnel({
      upstream: () => ({ baseUrl: upstream.baseUrl, token: TOKEN }),
      deviceStore: store,
      desktopName: "Test Desktop",
      relays: "disabled",
    });
    phone = await createTunnelClient({ relays: "disabled" });
    const pairing = desktop.beginPairing();
    const payload = parsePairQrPayload(pairing.qrPayload);
    if (!payload) throw new Error("the pairing payload did not parse");
    const paired = await phone.pair(payload.ticket, {
      code: payload.code,
      deviceName: "Test iPhone",
      platform: "ios",
    });
    if (!paired.ok) throw new Error("pairing was refused");
  });

  afterAll(async () => {
    await phone.close();
    await desktop.close();
    upstream.server.close();
  });

  it("stamps the phone's own EndpointId and a proof on the forwarded hop", async () => {
    const connection = await phone.connect(desktop.ticket());
    await tunnelRequest(connection, {
      method: "GET",
      target: "/centraid/_vault/seat/locker-key",
    });
    const forwarded = upstream.seen.at(-1);
    expect(forwarded).toBeTruthy();
    const headers = forwarded!.headers;

    // The hop is still marked forwarded: host-ONLY capabilities must keep
    // refusing it (#568). That is not in tension with naming the phone — one
    // says "this is not the host", the other says who it is instead.
    expect(headers[TUNNEL_FORWARDED_HEADER]).toBe("1");

    // …and the gateway now has a principal to resolve.
    expect(headers[DEVICE_IDENTITY_HEADER]).toBe(phone.endpointId);
    expect(String(headers[DEVICE_PROOF_HEADER] ?? "")).not.toBe("");
  });

  it("names the phone the CONNECTION authenticated, never a header the phone sent", async () => {
    const connection = await phone.connect(desktop.ticket());
    await tunnelRequest(connection, {
      method: "GET",
      target: "/centraid/_vault/seat/locker-key",
      headers: {
        // A paired phone trying to be another device — or the host.
        [DEVICE_IDENTITY_HEADER]: "ep-somebody-else",
        [DEVICE_PROOF_HEADER]: "not-a-proof",
      },
    });
    const headers = upstream.seen.at(-1)!.headers;
    expect(headers[DEVICE_IDENTITY_HEADER]).toBe(phone.endpointId);
    expect(headers[DEVICE_PROOF_HEADER]).not.toBe("not-a-proof");
  });
});
