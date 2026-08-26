/*
 * The gateway's read of the vault's egress-consent ledger (#807).
 *
 * Two laws are under test, and both are about the DIRECTION consent travels: a
 * specific scope's answer beats the vault-wide one, and a "no" nearby is never
 * fallen through in search of a "yes" further out.
 */
import { beforeEach, describe, expect, test } from "vitest";

import { openVaultDb, recordEnrichConsent } from "@centraid/vault";
import type { EnrichScope, VaultDb } from "@centraid/vault";

import { readEnrichConsentForChain } from "./egress-consent-lookup.js";

const CHAIN: EnrichScope[] = [
  { type: "vault", ref: "" },
  { type: "domain", ref: "photos" },
  { type: "collection", ref: "album-7" },
];

describe(readEnrichConsentForChain, () => {
  let db: VaultDb;
  beforeEach(() => {
    db = openVaultDb();
  });

  test("is null when the question was never asked anywhere on the chain", () => {
    expect(
      readEnrichConsentForChain(db.vault, {
        capability: "faces",
        egress: "provider",
        scopeChain: CHAIN,
      })
    ).toBeNull();
  });

  test("falls back to the vault-wide answer the member gave for everything", () => {
    recordEnrichConsent(db.vault, {
      capability: "faces",
      egress: "provider",
      decision: "granted",
    });

    expect(
      readEnrichConsentForChain(db.vault, {
        capability: "faces",
        egress: "provider",
        scopeChain: CHAIN,
      })?.decision
    ).toBe("granted");
  });

  test("the nearest answer wins, and a nearby no is not fallen through", () => {
    recordEnrichConsent(db.vault, {
      capability: "faces",
      egress: "provider",
      decision: "granted",
    });
    recordEnrichConsent(db.vault, {
      capability: "faces",
      egress: "provider",
      scopeRef: "album-7",
      decision: "declined",
    });

    const record = readEnrichConsentForChain(db.vault, {
      capability: "faces",
      egress: "provider",
      scopeChain: CHAIN,
    });
    expect(record?.scopeRef).toBe("album-7");
    expect(record?.decision).toBe("declined");
  });

  test("an answer for one egress class says nothing about another", () => {
    recordEnrichConsent(db.vault, {
      capability: "faces",
      egress: "gateway",
      decision: "granted",
    });

    expect(
      readEnrichConsentForChain(db.vault, {
        capability: "faces",
        egress: "provider",
        scopeChain: CHAIN,
      })
    ).toBeNull();
  });
});
