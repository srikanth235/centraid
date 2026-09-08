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

  test("boots unconfigured, creates a vault-key-peppered verifier, and never stores the passphrase", async () => {
    await expect(auth.handle({ operation: "status" })).resolves.toMatchObject({
      ok: true,
      configured: false,
      authenticated: false,
    });
    const configured = await auth.handle({
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
      db.audit.prepare(`SELECT * FROM access_receipt`).all()
    );
    expect(receiptText).not.toContain("correct horse");
  });

  test("rate limits repeated failures without disclosing whether a credential id exists", async () => {
    await auth.handle({
      operation: "configure",
      secret: "correct horse battery staple",
    });
    await expect(
      auth.handle({ operation: "unlock", secret: "wrong-passphrase" })
    ).resolves.toMatchObject({ ok: false, code: "INVALID_CREDENTIAL" });
    await auth.handle({ operation: "unlock", secret: "wrong-passphrase" });
    const third = await auth.handle({
      operation: "unlock",
      secret: "wrong-passphrase",
    });
    expect(third).toMatchObject({
      ok: false,
      code: "INVALID_CREDENTIAL",
      retryAfterMs: 1000,
    });
    await expect(
      auth.handle({
        operation: "unlock",
        credentialId: "not-a-credential",
        secret: "wrong-passphrase",
      })
    ).resolves.toMatchObject({ ok: false, code: "INVALID_CREDENTIAL" });
    await expect(
      auth.handle({
        operation: "unlock",
        secret: "correct horse battery staple",
      })
    ).resolves.toMatchObject({ ok: false, code: "RATE_LIMITED" });
    now += 1001;
    await expect(
      auth.handle({
        operation: "unlock",
        secret: "correct horse battery staple",
      })
    ).resolves.toMatchObject({ ok: true, authenticated: true });
  });

  test("sessions expire on inactivity and item permits are bound, short-lived, and one-time", async () => {
    const configured = await auth.handle({
      operation: "configure",
      secret: "correct horse battery staple",
    });
    const sessionToken = configured.sessionToken!;
    const permit = await auth.handle({
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

    const second = await auth.handle({
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
    await expect(
      auth.handle({ operation: "status", sessionToken })
    ).resolves.toMatchObject({
      authenticated: false,
    });
  });

  test("explicit lock invalidates its session and all outstanding item permits", async () => {
    const configured = await auth.handle({
      operation: "configure",
      secret: "correct horse battery staple",
    });
    const sessionToken = configured.sessionToken!;
    const permit = await auth.handle({
      operation: "authorize-item",
      sessionToken,
      secret: "correct horse battery staple",
      itemId: "item-a",
    });
    await auth.handle({ operation: "lock", sessionToken });
    expect(() =>
      auth.consumeItemPermit(
        { sessionToken, itemToken: permit.itemToken },
        "item-a"
      )
    ).toThrow(/locked/u);
  });

  test("authorizeReveal gates UI permits and fill sessions only after configure", async () => {
    expect(auth.isConfigured()).toBe(false);
    expect(auth.isUnlocked()).toBe(false);
    // Unconfigured: both arms are open (opt-in presence).
    expect(() => auth.authorizeReveal(undefined, "item-a", "ui")).not.toThrow();
    expect(() =>
      auth.authorizeReveal(undefined, "item-a", "fill")
    ).not.toThrow();

    const configured = await auth.handle({
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

    await auth.handle({ operation: "lock" }); // lock all sessions
    expect(auth.isUnlocked()).toBe(false);
    expect(() => auth.authorizeReveal(undefined, "item-a", "fill")).toThrow(
      /locked/u
    );

    const unlocked = await auth.handle({
      operation: "unlock",
      secret: "correct horse battery staple",
    });
    const permit = await auth.handle({
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

  test("enroll-device and revoke-device cover session and primary guards", async () => {
    const configured = await auth.handle({
      operation: "configure",
      secret: "correct horse battery staple",
    });
    const sessionToken = configured.sessionToken!;
    const deviceSecret = "d".repeat(32);

    await expect(
      auth.handle({
        operation: "enroll-device",
        sessionToken: "dead-session",
        secret: deviceSecret,
        label: "Phone",
      })
    ).resolves.toMatchObject({ ok: false, code: "SESSION_EXPIRED" });

    await expect(
      auth.handle({
        operation: "enroll-device",
        sessionToken,
        secret: "too-short",
        label: "Phone",
      })
    ).resolves.toMatchObject({ ok: false, code: "WEAK_DEVICE_SECRET" });

    const enrolled = await auth.handle({
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

    await expect(
      auth.handle({
        operation: "revoke-device",
        sessionToken: "dead-session",
        credentialId: deviceId,
      })
    ).resolves.toMatchObject({ ok: false, code: "SESSION_EXPIRED" });

    await expect(
      auth.handle({
        operation: "revoke-device",
        sessionToken,
        credentialId: LOCKER_PRIMARY_CREDENTIAL_ID,
      })
    ).resolves.toMatchObject({ ok: false, code: "PRIMARY_CREDENTIAL" });

    await expect(
      auth.handle({
        operation: "revoke-device",
        sessionToken,
        credentialId: deviceId,
      })
    ).resolves.toMatchObject({ ok: true, authenticated: true });

    // Device credential unlock path after enroll (before revoke above we
    // already revoked — re-enroll and unlock with device secret).
    const again = await auth.handle({
      operation: "enroll-device",
      sessionToken,
      secret: deviceSecret,
      label: "Watch",
    });
    const unlocked = await auth.handle({
      operation: "unlock",
      secret: deviceSecret,
      credentialId: again.credentialId,
    });
    expect(unlocked).toMatchObject({ ok: true, authenticated: true });
  });

  // ── issue #659 G11: the KDF runs off the event loop ───────────────────

  test("an unlock leaves the event loop free while its scrypt runs", async () => {
    await auth.handle({
      operation: "configure",
      secret: "correct horse battery staple",
    });

    // A timer chain that can only advance if the loop is being serviced. With
    // the old `scryptSync` the whole ~100 ms derivation ran inside one tick,
    // so this counter could not move at all while the unlock was in flight.
    let ticks = 0;
    let ticking = true;
    const tick = (): void => {
      if (!ticking) return;
      ticks += 1;
      setTimeout(tick, 1);
    };
    setTimeout(tick, 1);

    const before = ticks;
    const started = performance.now();
    const unlocked = await auth.handle({
      operation: "unlock",
      secret: "correct horse battery staple",
    });
    const elapsedMs = performance.now() - started;
    const during = ticks - before;
    ticking = false;

    expect(unlocked).toMatchObject({ ok: true, authenticated: true });
    // The derivation is deliberately expensive, so a serviced loop turns over
    // many times inside it. `scryptSync` yielded only at the handful of await
    // boundaries around it, which is why the floor is well above 1 — a
    // regression to the sync KDF cannot satisfy this.
    expect(elapsedMs).toBeGreaterThan(20);
    expect(during).toBeGreaterThan(10);
  });

  test("a wrong passphrase still pays the full derivation before it is refused", async () => {
    await auth.handle({
      operation: "configure",
      secret: "correct horse battery staple",
    });
    // The enumeration guard is only a guard if the fake derivation is
    // AWAITED: an unknown credential id and a known one must both cost a real
    // scrypt, so the refusal timing tells an attacker nothing.
    const startUnknown = performance.now();
    const unknown = await auth.handle({
      operation: "unlock",
      credentialId: "not-a-credential",
      secret: "wrong-passphrase",
    });
    const unknownMs = performance.now() - startUnknown;

    now += 60_000; // clear the failure backoff the refusal just recorded
    const startKnown = performance.now();
    const known = await auth.handle({
      operation: "unlock",
      secret: "wrong-passphrase",
    });
    const knownMs = performance.now() - startKnown;

    expect(unknown).toMatchObject({ ok: false, code: "INVALID_CREDENTIAL" });
    expect(known).toMatchObject({ ok: false, code: "INVALID_CREDENTIAL" });
    // Both paths did real KDF work — neither returned on a fast path.
    expect(unknownMs).toBeGreaterThan(1);
    expect(knownMs).toBeGreaterThan(1);
  });
});
