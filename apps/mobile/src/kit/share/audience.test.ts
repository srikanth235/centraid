// The mobile grant-roster read (issue #712, P7). Mocks `lib/gateway` the way
// `lib/daily-brief.test.ts` does, so the HTTP shape is exercised without a
// real gateway.
import { describe, expect, it, vi } from "vitest";

import type * as Gateway from "../../lib/gateway";
import { vaultAudience } from "./audience";

const { apiHeaders, fetchJson, requireGatewayBase } = vi.hoisted(() => ({
  apiHeaders: vi.fn<typeof Gateway.apiHeaders>(() => ({})),
  fetchJson: vi.fn<typeof Gateway.fetchJson>(),
  requireGatewayBase: vi.fn<typeof Gateway.requireGatewayBase>(),
}));
vi.mock(
  import("../../lib/gateway"),
  () =>
    ({
      apiHeaders,
      fetchJson,
      requireGatewayBase,
    }) as unknown as typeof Gateway
);

describe(vaultAudience, () => {
  it("keeps only the grants that name the requested vault", async () => {
    requireGatewayBase.mockResolvedValue("https://gw.test");
    fetchJson.mockResolvedValue({
      members: [
        {
          memberId: "m-priya",
          label: "Priya",
          roles: [
            { vaultId: "vault-family", role: "admin" },
            { vaultId: "vault-priya", role: "admin" },
          ],
        },
        {
          memberId: "m-sid",
          label: "Sid",
          roles: [{ vaultId: "vault-family", role: "read" }],
        },
      ],
    });
    await expect(vaultAudience("vault-family")).resolves.toStrictEqual([
      { memberId: "m-priya", name: "Priya", role: "admin" },
      { memberId: "m-sid", name: "Sid", role: "read" },
    ]);
  });

  it("empties out rather than throwing when the gateway has no device plane", async () => {
    requireGatewayBase.mockResolvedValue("https://gw.test");
    fetchJson.mockRejectedValue(new Error("not_found"));
    await expect(vaultAudience("vault-family")).resolves.toStrictEqual([]);
  });

  it("empties out when the gateway cannot be resolved at all", async () => {
    requireGatewayBase.mockRejectedValue(new Error("no gateway"));
    await expect(vaultAudience("vault-family")).resolves.toStrictEqual([]);
  });
});
