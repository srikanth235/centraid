/**
 * Matrix cell web.durability (#535): relay refreshes preserve identity.
 */
import { describe, expect, test } from "vitest";

import { webGatewayId } from "./web-state.js";
import type { WebConnection } from "./web-state.js";

const base: WebConnection = {
  endpointId: "gw-sovereign",
  label: "Gateway",
  displayName: "Gateway",
  avatarColor: "#123456",
};

describe("webGatewayId durability", () => {
  test("changing or losing the relay ticket does not change identity", () => {
    expect(webGatewayId({ ...base, endpointTicket: "ticket-a" })).toBe(
      "gw-sovereign"
    );
    expect(webGatewayId({ ...base, endpointTicket: "ticket-b" })).toBe(
      "gw-sovereign"
    );
    expect(webGatewayId(base)).toBe("gw-sovereign");
  });
});
