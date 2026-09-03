import { promises as dns } from "node:dns";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assertPublicPushEndpoint,
  endpointHostIsPublicSync,
} from "./endpoint-guard.js";

const lookup = () => vi.spyOn(dns, "lookup");

describe("assertPublicPushEndpoint (issue #865)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refuses CGNAT, IETF protocol-assignment, and Class E IPv4 literals", async () => {
    await Promise.all(
      [
        "https://100.64.0.1/fcm",
        "https://192.0.0.8/fcm",
        "https://240.0.0.1/fcm",
      ].map(async (endpoint) => {
        await expect(assertPublicPushEndpoint(endpoint)).rejects.toThrow(
          /IP literal/u
        );
      })
    );
  });

  it("accepts a public https endpoint that resolves to public addresses", async () => {
    let lookedUp: unknown;
    lookup().mockImplementation((async (host: string, options: unknown) => {
      lookedUp = [host, options];
      return [
        { address: "93.184.216.34", family: 4 },
        { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
      ];
    }) as never);
    await expect(
      assertPublicPushEndpoint("https://push.example.com/subscribe/abc")
    ).resolves.toBeUndefined();
    expect(lookedUp).toStrictEqual(["push.example.com", { all: true }]);
  });

  it("refuses a hostname that resolves to loopback or RFC1918 space", async () => {
    await Promise.all(
      (
        [
          ["127.0.0.1", "https://evil.example/wake"],
          ["10.1.2.3", "https://evil.example/wake"],
          ["172.16.0.9", "https://evil.example/wake"],
          ["192.168.1.10", "https://evil.example/wake"],
          ["169.254.7.7", "https://evil.example/wake"],
          ["100.64.0.1", "https://evil.example/wake"],
          ["192.0.0.8", "https://evil.example/wake"],
          ["240.0.0.1", "https://evil.example/wake"],
          ["0.0.0.0", "https://evil.example/wake"],
          ["::1", "https://evil.example/wake"],
          ["fd00::5", "https://evil.example/wake"],
          ["fe80::1", "https://evil.example/wake"],
          ["::ffff:127.0.0.1", "https://evil.example/wake"],
        ] as const
      ).map(async ([address, endpoint]) => {
        lookup().mockResolvedValue([
          { address, family: address.includes(":") ? 6 : 4 },
        ] as never);
        await expect(assertPublicPushEndpoint(endpoint)).rejects.toThrow(
          /reserved-range/u
        );
      })
    );
  });

  it("refuses when ANY resolved address is reserved, not just all of them", async () => {
    lookup().mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "192.168.0.1", family: 4 },
    ] as never);
    await expect(
      assertPublicPushEndpoint("https://rebind.example/wake")
    ).rejects.toThrow(/reserved-range/u);
  });

  it("refuses IP-literal hosts in reserved ranges directly, without DNS", async () => {
    const spy = lookup();
    await Promise.all(
      [
        "https://127.0.0.1:8080/fcm",
        "https://[::1]/fcm",
        "https://10.0.0.1/fcm",
        "https://192.168.2.2/fcm",
        "https://[fd12:3456:789a::1]/fcm",
        "https://169.254.169.254/latest/meta-data",
        "https://100.127.255.254/fcm",
        "https://192.0.0.1/fcm",
        "https://255.0.0.1/fcm",
        "https://0.0.0.0/",
        "https://[::ffff:10.0.0.5]/fcm",
      ].map(async (endpoint) => {
        await expect(assertPublicPushEndpoint(endpoint)).rejects.toThrow(
          /IP literal/u
        );
      })
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it("refuses non-https schemes and credentials-in-URL", async () => {
    const spy = lookup();
    await expect(
      assertPublicPushEndpoint("http://push.example.com/wake")
    ).rejects.toThrow(/https/u);
    await expect(
      assertPublicPushEndpoint("https://user:pass@push.example.com/wake")
    ).rejects.toThrow(/credentials/u);
    expect(spy).not.toHaveBeenCalled();
  });

  it("fails closed on resolution failure and malformed URLs", async () => {
    const spy = lookup().mockRejectedValue(new Error("ENOTFOUND"));
    await expect(
      assertPublicPushEndpoint("https://nx.example/wake")
    ).rejects.toThrow(/does not resolve/u);
    spy.mockRestore();
    lookup().mockResolvedValue([] as never);
    await expect(
      assertPublicPushEndpoint("https://empty.example/wake")
    ).rejects.toThrow(/does not resolve/u);
    await expect(assertPublicPushEndpoint("not a url at all")).rejects.toThrow(
      /valid URL/u
    );
  });
});

describe("endpointHostIsPublicSync (issue #865 send-time backstop)", () => {
  it("passes https named hosts and public IP literals", () => {
    expect(endpointHostIsPublicSync("https://push.example.com/x")).toBe(true);
    expect(endpointHostIsPublicSync("https://93.184.216.34/x")).toBe(true);
  });

  it("refuses non-https, credential-bearing, and reserved IP literals", () => {
    expect(endpointHostIsPublicSync("http://push.example.com/x")).toBe(false);
    expect(endpointHostIsPublicSync("https://u:p@push.example.com/x")).toBe(
      false
    );
    expect(endpointHostIsPublicSync("https://127.0.0.1:3000/x")).toBe(false);
    expect(endpointHostIsPublicSync("https://[::1]/x")).toBe(false);
    expect(endpointHostIsPublicSync("https://192.168.1.4/x")).toBe(false);
    expect(endpointHostIsPublicSync("https://100.64.1.1/x")).toBe(false);
    expect(endpointHostIsPublicSync("https://192.0.0.8/x")).toBe(false);
    expect(endpointHostIsPublicSync("https://240.1.2.3/x")).toBe(false);
    expect(endpointHostIsPublicSync("not-a-url")).toBe(false);
  });
});
