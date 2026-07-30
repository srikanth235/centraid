import { beforeEach, describe, expect, test } from "vitest";

import { openVaultDb } from "../db.js";
import type { VaultDb } from "../db.js";
import {
  LOCKER_PRIMARY_CREDENTIAL_ID,
  LockerAuthentication,
} from "./locker-auth.js";

let db: VaultDb;
let now: number;
let auth: LockerAuthentication;

describe("Locker user-presence authentication", () => {
  beforeEach(() => {
    db = openVaultDb();
    now = Date.parse("2026-07-29T00:00:00.000Z");
    auth = new LockerAuthentication(db, () => now);
  });

  test("boots unconfigured, creates a vault-key-peppered verifier, and never stores the passphrase", () => {
    expect(auth.handle({ operation: "status" })).toMatchObject({
      ok: true,
      configured: false,
      authenticated: false,
    });
    const configured = auth.handle({
      operation: "configure",
      secret: "correct horse battery staple",
    });
    expect(configured).toMatchObject({
      ok: true,
      configured: true,
      authenticated: true,
    });
    const row = db.vault
      .prepare(
        `SELECT credential_id, salt, verifier
           FROM locker_auth_credential WHERE credential_id = ?`
      )
      .get(LOCKER_PRIMARY_CREDENTIAL_ID) as {
      credential_id: string;
      salt: Uint8Array;
      verifier: Uint8Array;
    };
    expect(row.credential_id).toBe(LOCKER_PRIMARY_CREDENTIAL_ID);
    expect(Buffer.from(row.salt)).toHaveLength(16);
    expect(Buffer.from(row.verifier)).toHaveLength(32);
    expect(Buffer.from(row.verifier).toString("utf8")).not.toContain(
      "correct horse"
    );
    const receiptText = JSON.stringify(
      db.journal.prepare(`SELECT * FROM consent_receipt`).all()
    );
    expect(receiptText).not.toContain("correct horse");
  });

  test("rate limits repeated failures without disclosing whether a credential id exists", () => {
    auth.handle({
      operation: "configure",
      secret: "correct horse battery staple",
    });
    expect(
      auth.handle({ operation: "unlock", secret: "wrong-passphrase" })
    ).toMatchObject({ ok: false, code: "INVALID_CREDENTIAL" });
    auth.handle({ operation: "unlock", secret: "wrong-passphrase" });
    const third = auth.handle({
      operation: "unlock",
      secret: "wrong-passphrase",
    });
    expect(third).toMatchObject({
      ok: false,
      code: "INVALID_CREDENTIAL",
      retryAfterMs: 1000,
    });
    expect(
      auth.handle({
        operation: "unlock",
        credentialId: "not-a-credential",
        secret: "wrong-passphrase",
      })
    ).toMatchObject({ ok: false, code: "INVALID_CREDENTIAL" });
    expect(
      auth.handle({
        operation: "unlock",
        secret: "correct horse battery staple",
      })
    ).toMatchObject({ ok: false, code: "RATE_LIMITED" });
    now += 1001;
    expect(
      auth.handle({
        operation: "unlock",
        secret: "correct horse battery staple",
      })
    ).toMatchObject({ ok: true, authenticated: true });
  });

  test("sessions expire on inactivity and item permits are bound, short-lived, and one-time", () => {
    const configured = auth.handle({
      operation: "configure",
      secret: "correct horse battery staple",
    });
    const sessionToken = configured.sessionToken!;
    const permit = auth.handle({
      operation: "authorize-item",
      sessionToken,
      secret: "correct horse battery staple",
      itemId: "item-a",
    });
    expect(permit.itemToken).toBeTypeOf("string");
    expect(() =>
      auth.consumeItemPermit(
        { sessionToken, itemToken: permit.itemToken },
        "item-b"
      )
    ).toThrow(/item authorization expired/u);

    const second = auth.handle({
      operation: "authorize-item",
      sessionToken,
      secret: "correct horse battery staple",
      itemId: "item-a",
    });
    expect(() =>
      auth.consumeItemPermit(
        { sessionToken, itemToken: second.itemToken },
        "item-a"
      )
    ).not.toThrow();
    expect(() =>
      auth.consumeItemPermit(
        { sessionToken, itemToken: second.itemToken },
        "item-a"
      )
    ).toThrow(/authorization expired/u);

    now += 5 * 60 * 1000 + 1;
    expect(auth.handle({ operation: "status", sessionToken })).toMatchObject({
      authenticated: false,
    });
  });

  test("explicit lock invalidates its session and all outstanding item permits", () => {
    const configured = auth.handle({
      operation: "configure",
      secret: "correct horse battery staple",
    });
    const sessionToken = configured.sessionToken!;
    const permit = auth.handle({
      operation: "authorize-item",
      sessionToken,
      secret: "correct horse battery staple",
      itemId: "item-a",
    });
    auth.handle({ operation: "lock", sessionToken });
    expect(() =>
      auth.consumeItemPermit(
        { sessionToken, itemToken: permit.itemToken },
        "item-a"
      )
    ).toThrow(/locked/u);
  });

  test("authorizeReveal gates UI permits and fill sessions only after configure", () => {
    expect(auth.isConfigured()).toBe(false);
    expect(auth.isUnlocked()).toBe(false);
    // Unconfigured: both arms are open (opt-in presence).
    expect(() => auth.authorizeReveal(undefined, "item-a", "ui")).not.toThrow();
    expect(() =>
      auth.authorizeReveal(undefined, "item-a", "fill")
    ).not.toThrow();

    const configured = auth.handle({
      operation: "configure",
      secret: "correct horse battery staple",
    });
    expect(auth.isConfigured()).toBe(true);
    expect(auth.isUnlocked()).toBe(true);
    expect(configured.sessionToken).toBeTypeOf("string");

    expect(() => auth.authorizeReveal(undefined, "item-a", "ui")).toThrow(
      /locked/u
    );
    // Fill only needs any live unlock session, not an item permit.
    expect(() =>
      auth.authorizeReveal(undefined, "item-a", "fill")
    ).not.toThrow();

    auth.handle({ operation: "lock" }); // lock all sessions
    expect(auth.isUnlocked()).toBe(false);
    expect(() => auth.authorizeReveal(undefined, "item-a", "fill")).toThrow(
      /locked/u
    );

    const unlocked = auth.handle({
      operation: "unlock",
      secret: "correct horse battery staple",
    });
    const permit = auth.handle({
      operation: "authorize-item",
      sessionToken: unlocked.sessionToken!,
      secret: "correct horse battery staple",
      itemId: "item-a",
    });
    expect(() =>
      auth.authorizeReveal(
        { sessionToken: unlocked.sessionToken, itemToken: permit.itemToken },
        "item-a",
        "ui"
      )
    ).not.toThrow();
  });

  test("enroll-device and revoke-device cover session and primary guards", () => {
    const configured = auth.handle({
      operation: "configure",
      secret: "correct horse battery staple",
    });
    const sessionToken = configured.sessionToken!;
    const deviceSecret = "d".repeat(32);

    expect(
      auth.handle({
        operation: "enroll-device",
        sessionToken: "dead-session",
        secret: deviceSecret,
        label: "Phone",
      })
    ).toMatchObject({ ok: false, code: "SESSION_EXPIRED" });

    expect(
      auth.handle({
        operation: "enroll-device",
        sessionToken,
        secret: "too-short",
        label: "Phone",
      })
    ).toMatchObject({ ok: false, code: "WEAK_DEVICE_SECRET" });

    const enrolled = auth.handle({
      operation: "enroll-device",
      sessionToken,
      secret: deviceSecret,
      label: "  ",
    });
    expect(enrolled).toMatchObject({
      ok: true,
      credentialId: expect.any(String),
    });
    const deviceId = enrolled.credentialId!;

    expect(
      auth.handle({
        operation: "revoke-device",
        sessionToken: "dead-session",
        credentialId: deviceId,
      })
    ).toMatchObject({ ok: false, code: "SESSION_EXPIRED" });

    expect(
      auth.handle({
        operation: "revoke-device",
        sessionToken,
        credentialId: LOCKER_PRIMARY_CREDENTIAL_ID,
      })
    ).toMatchObject({ ok: false, code: "PRIMARY_CREDENTIAL" });

    expect(
      auth.handle({
        operation: "revoke-device",
        sessionToken,
        credentialId: deviceId,
      })
    ).toMatchObject({ ok: true, authenticated: true });

    // Device credential unlock path after enroll (before revoke above we
    // already revoked — re-enroll and unlock with device secret).
    const again = auth.handle({
      operation: "enroll-device",
      sessionToken,
      secret: deviceSecret,
      label: "Watch",
    });
    const unlocked = auth.handle({
      operation: "unlock",
      secret: deviceSecret,
      credentialId: again.credentialId,
    });
    expect(unlocked).toMatchObject({ ok: true, authenticated: true });
  });
});
