import { describe, expect, it } from "vitest";

import { healthLineFor } from "../../kit/components/health-line";
import type { ConnectionEntry } from "../../lib/connections";
import {
  FULL_AT,
  connectorRow,
  connectorsHealth,
  countSentence,
  expiryPhrase,
  filterChips,
  matchesFilter,
  opsStateFor,
  statusWord,
  subLine,
} from "./connectors-model";

const NOW = Date.parse("2026-08-13T12:00:00.000Z");
const DAY = 86_400_000;

function entry(over: Partial<ConnectionEntry> = {}): ConnectionEntry {
  return {
    allowedHosts: null,
    authNote: null,
    connectionId: "c-gmail",
    createdAt: "2026-01-04T09:00:00.000Z",
    credKind: "oauth2",
    hasRefreshToken: true,
    kind: "gmail",
    label: "Gmail",
    lastRunAt: "2026-08-13T11:56:00.000Z",
    oauthMode: "assist",
    principal: "alex@pemberton.example",
    provider: "google",
    scopes: null,
    status: "active",
    tokenExpiresAt: null,
    trust: "staged",
    ...over,
  };
}

describe("connector rows", () => {
  it("words a healthy connection as identity, credential and last run", () => {
    expect(subLine(entry(), NOW)).toBe(
      "alex@pemberton.example · OAuth · last worked 4 minutes ago"
    );
    expect(statusWord(entry(), NOW)).toBe("Fine");
  });

  it("names a token that is close to lapsing without waiting for it to", () => {
    const soon = entry({
      tokenExpiresAt: new Date(NOW + 6 * DAY).toISOString(),
    });
    expect(expiryPhrase(soon, NOW)).toBe("token expires in 6 days");
    expect(statusWord(soon, NOW)).toBe("Expiring");
    const later = entry({
      tokenExpiresAt: new Date(NOW + 90 * DAY).toISOString(),
    });
    expect(expiryPhrase(later, NOW)).toBeUndefined();
    expect(statusWord(later, NOW)).toBe("Fine");
  });

  it("gives a lapsed connection net metadata and the re-authorize verb", () => {
    const row = connectorRow(
      entry({
        authNote: "The refresh token was revoked on 9 August",
        status: "needs-auth",
      }),
      NOW
    );
    expect(row.meta).toBe("Needs re-auth");
    expect(row.net).toBe(true);
    expect(row.action).toBe("Re-authorize");
    expect(row.act).toBe("reauthorize");
    expect(row.sub).toContain("The refresh token was revoked on 9 August");
  });

  it("leaves a paused connection un-alarmed and offers to resume it", () => {
    const row = connectorRow(entry({ status: "paused" }), NOW);
    expect(row.meta).toBe("Paused");
    expect(row.net).toBe(false);
    expect(row.action).toBe("Resume");
  });

  it("offers pause on a working row — the one write mobile actually serves", () => {
    expect(connectorRow(entry(), NOW).action).toBe("Pause");
    expect(connectorRow(entry({ status: "failing" }), NOW).net).toBe(true);
  });

  it("says a connection has never run rather than inventing a time", () => {
    expect(subLine(entry({ lastRunAt: null }), NOW)).toBe(
      "alex@pemberton.example · OAuth · never run"
    );
    expect(
      subLine(entry({ credKind: null, principal: null, lastRunAt: null }), NOW)
    ).toBe("no account · no credential · never run");
  });
});

describe("counts and filters", () => {
  it("counts the list the way the reference's meta sentence does", () => {
    expect(
      countSentence([
        entry({ connectionId: "a" }),
        entry({ connectionId: "b", status: "needs-auth" }),
        entry({ connectionId: "c", status: "paused" }),
      ])
    ).toBe("3 connections · 1 needs re-authorization · 1 paused");
    expect(countSentence([entry()])).toBe("1 connection");
  });

  it("narrows to one status at a time, with All first and on by default", () => {
    const chips = filterChips("all");
    expect(chips.map((c) => c.label)).toStrictEqual([
      "All",
      "Failing",
      "Needs re-auth",
      "Paused",
    ]);
    expect(chips[0]?.on).toBe(true);
    expect(matchesFilter(entry({ status: "paused" }), "paused")).toBe(true);
    expect(matchesFilter(entry({ status: "paused" }), "needs-auth")).toBe(
      false
    );
    expect(matchesFilter(entry({ status: "paused" }), "all")).toBe(true);
  });
});

describe("the five states", () => {
  it("reads empty, ready and full off the row count", () => {
    expect(opsStateFor("loading", 0)).toBe("loading");
    expect(opsStateFor("error", 5)).toBe("error");
    expect(opsStateFor("ready", 0)).toBe("empty");
    expect(opsStateFor("ready", FULL_AT - 1)).toBe("ready");
    expect(opsStateFor("ready", FULL_AT)).toBe("full");
  });
});

describe("the standing line", () => {
  it("leads with the connection that needs the member, and offers the verb", () => {
    const copy = connectorsHealth(
      [
        entry(),
        entry({
          authNote: "Its token expired on 9 August.",
          connectionId: "c-drive",
          label: "Drive",
          status: "needs-auth",
        }),
      ],
      NOW
    );
    expect(copy.label).toBe("Drive needs re-authorization");
    expect(copy.detail).toBe("Its token expired on 9 August.");
    const ready = healthLineFor("ready", copy);
    expect(ready.text).toBe(
      "Drive needs re-authorization · Its token expired on 9 August."
    );
    expect(ready.action).toBe("Re-authorize");
  });

  it("says the ordinary thing when nothing is wrong", () => {
    const copy = connectorsHealth([entry(), entry({ connectionId: "b" })], NOW);
    expect(copy.label).toBe("2 connections are working");
    expect(copy.detail).toBe("Nothing needs re-authorization.");
    expect(copy.action).toBeUndefined();
  });

  it("withholds the inline verb outside ready and full", () => {
    const copy = connectorsHealth([entry({ status: "needs-auth" })], NOW);
    expect(healthLineFor("loading", copy)).toStrictEqual({
      text: "Reading from the gateway",
    });
    expect(healthLineFor("empty", copy).action).toBeUndefined();
    expect(healthLineFor("error", copy).text).toBe("This page could not load");
    expect(healthLineFor("full", copy).action).toBe("Re-authorize");
  });
});
