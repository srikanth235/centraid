import { describe, expect, test } from "vitest";

import { webGatewayId } from "./web-state.js";
import type { WebConnection } from "./web-state.js";

const base: WebConnection = {
  label: "Gateway",
  displayName: "Gateway",
  avatarColor: "#123456",
};

describe("web gateway identity", () => {
  test("uses only the sovereign gateway EndpointId", () => {
    expect(
      webGatewayId({
        ...base,
        endpointTicket: "refreshable-ticket",
        endpointId: "gateway-endpoint",
      })
    ).toBe("gateway-endpoint");
  });

  test("refuses to derive identity from dial cache", () => {
    expect(
      webGatewayId({ ...base, endpointTicket: "refreshable-ticket" })
    ).toBeUndefined();
  });
});
