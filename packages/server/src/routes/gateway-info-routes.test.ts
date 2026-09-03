import type { IncomingMessage, ServerResponse } from "node:http";

import { describe, expect, test } from "vitest";

import { AUTHED_PLANE_HEADER } from "../engine/http/http-server.js";
import { makeGatewayInfoRouteHandler } from "./gateway-info-routes.js";

const ENDPOINT_ID = "endpoint5n4p7sh3arqf6k2t8wv1yd0cj9mgxzbhu4a";

function call(
  handler: ReturnType<typeof makeGatewayInfoRouteHandler>,
  headers: Record<string, string>
): { status: number; body: Record<string, unknown> } {
  const req = {
    method: "GET",
    url: "/centraid/_gateway/info",
    headers,
  } as unknown as IncomingMessage;
  let status = 0;
  let body: Record<string, unknown> = {};
  const res = {
    setHeader: () => undefined,
    end: (chunk?: string) => {
      body = JSON.parse(chunk ?? "{}") as Record<string, unknown>;
    },
    statusCode: 0,
  };
  Object.defineProperty(res, "statusCode", {
    get: () => status,
    set: (value: number) => {
      status = value;
    },
  });
  void handler(req, res as unknown as ServerResponse);
  return { status, body };
}

describe("gateway-info-routes", () => {
  test("anonymous callers learn the version handshake but not the dial identity (issue #865)", () => {
    const handler = makeGatewayInfoRouteHandler({
      instanceId: "instance-1",
      endpointId: () => ENDPOINT_ID,
      endpointTicket: () => "ticket-bytes",
    });

    const anonymous = call(handler, {});
    expect(anonymous.status).toBe(200);
    expect(anonymous.body.endpointId).toBeUndefined();
    expect(anonymous.body.endpointTicket).toBeUndefined();
    expect(anonymous.body.authenticated).toBe(false);

    const authed = call(handler, { [AUTHED_PLANE_HEADER]: "device" });
    expect(authed.status).toBe(200);
    expect(authed.body.authenticated).toBe(true);
    expect(authed.body.endpointId).toBe(ENDPOINT_ID);
    expect(authed.body.endpointTicket).toBe("ticket-bytes");
  });
});
