import { describe, expect, it } from "vitest";

import {
  applyOutgoingAuthHeaders,
  matchesGateway,
  VAULT_HEADER,
} from "./auth-injector-core.js";
import type { AuthInjectorSnapshot } from "./auth-injector-core.js";

const snap = (
  patch: Partial<AuthInjectorSnapshot> = {}
): AuthInjectorSnapshot => ({
  gatewayOrigin: "https://gw.example",
  gatewayToken: "tok-1",
  gatewayVaultId: "vault-a",
  ...patch,
});

describe(matchesGateway, () => {
  it("matches same origin including path/query differences", () => {
    expect(
      matchesGateway("https://gw.example/centraid/app/", "https://gw.example")
    ).toBe(true);
    expect(
      matchesGateway("https://gw.example:443/x?q=1", "https://gw.example")
    ).toBe(true);
  });

  it("rejects other origins and malformed URLs", () => {
    expect(matchesGateway("https://evil.example/x", "https://gw.example")).toBe(
      false
    );
    expect(matchesGateway("not-a-url", "https://gw.example")).toBe(false);
    expect(matchesGateway("https://gw.example/x", "")).toBe(false);
  });
});

describe(applyOutgoingAuthHeaders, () => {
  it("injects Authorization and vault headers for gateway traffic", () => {
    const out = applyOutgoingAuthHeaders(
      { Accept: "text/html" },
      snap(),
      "https://gw.example/centraid/a/"
    );
    expect(out.Authorization).toBe("Bearer tok-1");
    expect(out[VAULT_HEADER]).toBe("vault-a");
    expect(out.Accept).toBe("text/html");
  });

  it("does not override existing Authorization or vault headers", () => {
    const out = applyOutgoingAuthHeaders(
      {
        authorization: "Bearer already",
        [VAULT_HEADER]: "vault-existing",
      },
      snap(),
      "https://gw.example/"
    );
    expect(out.authorization).toBe("Bearer already");
    expect(out.Authorization).toBeUndefined();
    expect(out[VAULT_HEADER]).toBe("vault-existing");
  });

  it("no-ops without token, without origin, or off-gateway", () => {
    expect(
      applyOutgoingAuthHeaders(
        { Accept: "*/*" },
        snap({ gatewayToken: "" }),
        "https://gw.example/"
      )
    ).toStrictEqual({ Accept: "*/*" });
    expect(
      applyOutgoingAuthHeaders(
        { Accept: "*/*" },
        snap({ gatewayOrigin: "" }),
        "https://gw.example/"
      )
    ).toStrictEqual({ Accept: "*/*" });
    expect(
      applyOutgoingAuthHeaders(
        { Accept: "*/*" },
        snap(),
        "https://other.example/"
      )
    ).toStrictEqual({
      Accept: "*/*",
    });
  });

  it("skips vault header when vault id is empty", () => {
    const out = applyOutgoingAuthHeaders(
      {},
      snap({ gatewayVaultId: "" }),
      "https://gw.example/"
    );
    expect(out.Authorization).toBe("Bearer tok-1");
    expect(out[VAULT_HEADER]).toBeUndefined();
  });
});
