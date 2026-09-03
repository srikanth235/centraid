// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";

import { useFakeClock } from "@centraid/test-kit/fake-clock";
import type { FakeClock } from "@centraid/test-kit/fake-clock";

import {
  CLIPBOARD_CLEAR_SECONDS,
  COPY_UNAVAILABLE,
  clearSecretClipboard,
  copyMetadata,
  copySecret,
} from "./clipboard.ts";
import {
  SECRET_BEARING_KEYS,
  SESSION_IDLE_MS,
  afterStatus,
  afterUnlock,
  bootSession,
  emptySecretBag,
  isExpired,
  isOpen,
  lock,
  locksOnVisibility,
  refusalText,
  remainingIdleMs,
  touch,
  wipeSecretState,
} from "./session.ts";
import type { SecretBag } from "./session.ts";

const T0 = 1_700_000_000_000;

describe("the session boots locked", () => {
  it("has no phase that opens without an answer", () => {
    const session = bootSession(T0);
    expect(session.phase).toBe("unknown");
    expect(session.token).toBeNull();
    expect(isOpen(session)).toBe(false);
  });

  it("resolves to first run when no passphrase exists", () => {
    const session = afterStatus(bootSession(T0), { configured: false }, T0);
    expect(session.phase).toBe("setup");
    expect(isOpen(session)).toBe(false);
  });

  it("resolves to locked when a passphrase exists but no session does", () => {
    const session = afterStatus(
      bootSession(T0),
      { ok: true, configured: true, authenticated: false },
      T0
    );
    expect(session.phase).toBe("locked");
    expect(session.token).toBeNull();
  });

  it("resumes only a host session that arrives with its token", () => {
    const resumed = afterStatus(
      bootSession(T0),
      { ok: true, configured: true, authenticated: true, sessionToken: "s1" },
      T0
    );
    expect(resumed.phase).toBe("open");
    expect(resumed.token).toBe("s1");

    const claimed = afterStatus(
      bootSession(T0),
      { ok: true, configured: true, authenticated: true },
      T0
    );
    expect(claimed.phase).toBe("locked");
    expect(claimed.token).toBeNull();
  });

  it("keeps first run passed once a configure succeeds", () => {
    const created = afterUnlock(
      afterStatus(bootSession(T0), { configured: false }, T0),
      { ok: true, sessionToken: "s1" },
      T0
    );
    expect(created.phase).toBe("open");
    expect(created.configured).toBe(true);
    expect(lock(created, T0).phase).toBe("locked");
  });
});

describe("five minutes, sliding", () => {
  const open = afterUnlock(
    bootSession(T0),
    { ok: true, sessionToken: "s1" },
    T0
  );

  it("expires exactly at the window, not before", () => {
    expect(isExpired(open, T0 + SESSION_IDLE_MS - 1)).toBe(false);
    expect(isExpired(open, T0 + SESSION_IDLE_MS)).toBe(true);
  });

  it("restarts the window from the activity, rather than extending it", () => {
    const later = touch(open, T0 + 4 * 60 * 1000);
    expect(remainingIdleMs(later, T0 + 4 * 60 * 1000)).toBe(SESSION_IDLE_MS);
    expect(isExpired(later, T0 + SESSION_IDLE_MS + 1)).toBe(false);
    expect(isExpired(later, T0 + 4 * 60 * 1000 + SESSION_IDLE_MS)).toBe(true);
  });

  it("does not slide a session that is not open", () => {
    const locked = lock(open, T0);
    expect(touch(locked, T0 + 1000)).toStrictEqual(locked);
    expect(isExpired(locked, T0 + SESSION_IDLE_MS * 10)).toBe(false);
  });
});

describe("hiding ends it", () => {
  it("locks on hidden and on nothing else", () => {
    expect(locksOnVisibility("hidden")).toBe(true);
    expect(locksOnVisibility("visible")).toBe(false);
    expect(locksOnVisibility("prerender")).toBe(false);
  });
});

describe("a refusal keeps its own words", () => {
  it("prefers the host's message, then a backoff, then the plain fact", () => {
    expect(refusalText({ message: "Device credential revoked." })).toBe(
      "Device credential revoked."
    );
    expect(refusalText({ retryAfterMs: 30_000 })).toBe(
      "Try again in 30 seconds."
    );
    expect(refusalText({})).toBe("The passphrase was not accepted.");
  });

  it("leaves a refused unlock locked, holding no token", () => {
    const refused = afterUnlock(
      afterStatus(bootSession(T0), { configured: true }, T0),
      { ok: false, configured: true, message: "No." },
      T0
    );
    expect(refused.phase).toBe("locked");
    expect(refused.token).toBeNull();
    expect(refused.error).toBe("No.");
  });
});

describe("a lock takes every secret-bearing field with it", () => {
  function loaded(): SecretBag {
    return {
      sessionToken: "session-token",
      detail: {
        item_id: "l1",
        type: "login",
        title: "GitHub",
        password: "k7Q-vn2-Rme",
      },
      revealed: { password: "k7Q-vn2-Rme" },
      revealedAt: { password: T0 },
      permit: {
        itemId: "l1",
        field: "password",
        token: "item-token",
        expiresAt: T0 + 30_000,
      },
      permitRequest: { itemId: "l1", field: "password" },
      editSeed: {
        mode: "edit",
        type: "login",
        title: "GitHub",
        tags: "work",
        alias: "",
        urlMatchPolicy: "registrable-domain",
        fields: { password: "half-typed" },
      },
      generated: "k7QvnRme84xzP1td",
      searchTerm: "git",
      searchResults: [{ item_id: "l1", type: "login", title: "GitHub" }],
      trashRows: [{ item_id: "z1", type: "login", title: "Old agent" }],
      sidecarDraft: {
        field: {
          section: "Recovery",
          label: "Recovery code",
          kind: "sealed",
          value: "8fj2-half-typed",
        },
        addresses: [
          { url: "https://example.test", matchPolicy: "registrable-domain" },
        ],
        passkey: {
          rpId: "example.test",
          userHandle: "ana",
          displayName: "Ana",
          credentialId: "cred-1",
          algorithm: "ES256",
          privateKey: "half-pasted-key",
        },
      },
      accessEntries: [
        {
          receipt_id: "r1",
          kind: "reveal",
          action: "reveal",
          decision: "allow",
          item_id: "l1",
          occurred_at: "2026-01-15T09:12:00Z",
        },
      ],
      importRows: [
        {
          seq: 1,
          entityType: "locker.item",
          externalId: "row-1",
          disposition: "create",
          mapping: "title → title",
        },
      ],
    };
  }

  it("empties exactly the declared list", () => {
    const bag = loaded();
    for (const key of SECRET_BEARING_KEYS) {
      expect(bag[key], `${key} was not loaded for the test`).not.toStrictEqual(
        emptySecretBag()[key]
      );
    }
    wipeSecretState(bag);
    expect(bag).toStrictEqual(emptySecretBag());
  });

  it("mutates in place, because the orchestrator's closures hold the bag", () => {
    const bag = loaded();
    const held = bag;
    wipeSecretState(bag);
    expect(held).toBe(bag);
    expect(held.sessionToken).toBeNull();
  });

  it("names every field the empty bag has, and no more", () => {
    expect(Object.keys(emptySecretBag()).toSorted()).toStrictEqual(
      [...SECRET_BEARING_KEYS].toSorted()
    );
  });
});

describe("the clipboard clears itself", () => {
  let written: string[];
  let held: string;
  let clock: FakeClock;

  beforeEach(() => {
    clock = useFakeClock(T0);
    written = [];
    held = "";
    Object.defineProperty(globalThis.navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: (text: string) => {
          written.push(text);
          held = text;
          return Promise.resolve();
        },
        readText: () => Promise.resolve(held),
      },
    });
  });

  it("says the clear window on a secret, and wipes at it", async () => {
    const outcome = await copySecret("k7Q-vn2-Rme", "Password");
    expect(outcome.ok).toBe(true);
    expect(outcome.text).toBe(
      `Password copied · the clipboard clears itself in ${CLIPBOARD_CLEAR_SECONDS} seconds`
    );
    expect(held).toBe("k7Q-vn2-Rme");

    await clock.advance(CLIPBOARD_CLEAR_SECONDS * 1000);
    expect(held).toBe("");
    expect(written.at(-1)).toBe("");
  });

  it("compares before it clears, so a later copy is never clobbered", async () => {
    await copySecret("the-secret", "Password");
    held = "something the member copied since";
    await clock.advance(CLIPBOARD_CLEAR_SECONDS * 1000);
    expect(held).toBe("something the member copied since");
  });

  it("wipes the exact secret at lock time", async () => {
    await copySecret("the-secret", "Password");
    clearSecretClipboard();
    await clock.advance(0);
    expect(held).toBe("");
  });

  it("wipes nothing at lock time when the clipboard moved on", async () => {
    await copySecret("the-secret", "Password");
    held = "a shopping list";
    clearSecretClipboard();
    await clock.advance(0);
    expect(held).toBe("a shopping list");
  });

  it("arms no timer for metadata, and claims none", async () => {
    const outcome = await copyMetadata("ana@example.test", "Username");
    expect(outcome.text).toBe("Username copied");
    await clock.advance(CLIPBOARD_CLEAR_SECONDS * 1000);
    expect(held).toBe("ana@example.test");
  });

  it("says so where the seat cannot copy at all", async () => {
    Object.defineProperty(globalThis.navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });
    await expect(copySecret("x", "Password")).resolves.toStrictEqual({
      ok: false,
      text: COPY_UNAVAILABLE,
    });
  });
});
