/*
 * ENROL THIS PHONE (#1015, ruling R-NY-19).
 *
 * `K` is the key to every secret in the vault, so what this file pins is not
 * "does the happy path work" but the four ways it must refuse and the two
 * places the key is allowed to land. A regression here does not throw — it
 * quietly writes a vault key somewhere nothing revokes, or over a channel
 * whose other end the member never scanned.
 */

import { describe, expect, it, vi } from "vitest";

import { LockerKeyDoorError } from "@centraid/client/locker";

import { enrolThisPhoneInLocker } from "./locker-enrol";
import {
  ENROL_NEEDS_TUNNEL,
  ENROL_NO_DOOR,
  ENROL_NOT_ALLOWED,
  ENROL_WRONG_VAULT,
} from "./locker-seat-copy";

// Every live dependency is INJECTED below, so the module graph only has to
// load. Stubbing the three React-Native-bound siblings keeps this a pure unit
// of the enrolment rule rather than a test of Expo's module registry.
vi.mock(import("./locker-device-auth") as Promise<unknown>, () => ({
  storeLockerVaultKey: vi.fn<() => Promise<void>>(),
}));

const VAULT = "vault-1";
const KEY = new Uint8Array(32).fill(7);

function infoFetch(seatLockerKey: boolean): typeof globalThis.fetch {
  return (() =>
    Promise.resolve(
      new Response(JSON.stringify({ capabilities: { seatLockerKey } }), {
        status: 200,
      })
    )) as unknown as typeof globalThis.fetch;
}

function deps(
  overrides: Partial<Parameters<typeof enrolThisPhoneInLocker>[1]> = {}
): Parameters<typeof enrolThisPhoneInLocker>[1] {
  return {
    tunnel: () => Promise.resolve({ baseUrl: "http://127.0.0.1:5555" }),
    doFetch: infoFetch(true),
    headers: () => Promise.resolve({ "x-centraid-vault": VAULT }),
    fetchKey: () =>
      Promise.resolve({
        vaultId: VAULT,
        keyId: "key-1",
        key: Uint8Array.from(KEY),
      }),
    storeKey: () => Promise.resolve(),
    ...overrides,
  };
}

describe(enrolThisPhoneInLocker, () => {
  it("stores the key it was handed, base64, under the vault it asked about", async () => {
    const storeKey = vi.fn<() => Promise<void>>(() => Promise.resolve());
    const answer = await enrolThisPhoneInLocker(VAULT, deps({ storeKey }));
    expect(answer).toStrictEqual({ ok: true, keyId: "key-1" });
    expect(storeKey).toHaveBeenCalledWith(VAULT, {
      keyId: "key-1",
      key: Buffer.from(KEY).toString("base64"),
    });
  });

  it("zeroes the bytes the door handed over", async () => {
    const handed = Uint8Array.from(KEY);
    await enrolThisPhoneInLocker(
      VAULT,
      deps({
        fetchKey: () =>
          Promise.resolve({ vaultId: VAULT, keyId: "key-1", key: handed }),
      })
    );
    expect([...handed]).toStrictEqual([...new Uint8Array(32)]);
  });

  it("refuses without the desktop link, and asks for nothing first", async () => {
    const doFetch = vi.fn<typeof globalThis.fetch>(infoFetch(true));
    const fetchKey = vi.fn<() => never>();
    const answer = await enrolThisPhoneInLocker(
      VAULT,
      deps({ tunnel: () => Promise.resolve(undefined), doFetch, fetchKey })
    );
    expect(answer).toStrictEqual({
      ok: false,
      reason: "no_tunnel",
      message: ENROL_NEEDS_TUNNEL,
    });
    // The manual-URL lane is a dev convenience with a bearer in this phone's
    // own settings. `K` travels the tunnel or it does not travel.
    expect(doFetch).not.toHaveBeenCalled();
    expect(fetchKey).not.toHaveBeenCalled();
  });

  it("refuses a gateway that does not advertise the door", async () => {
    const fetchKey = vi.fn<() => never>();
    const answer = await enrolThisPhoneInLocker(
      VAULT,
      deps({ doFetch: infoFetch(false), fetchKey })
    );
    expect(answer).toStrictEqual({
      ok: false,
      reason: "no_door",
      message: ENROL_NO_DOOR,
    });
    expect(fetchKey).not.toHaveBeenCalled();
  });

  it("stores nothing when the door refuses this phone", async () => {
    const storeKey = vi.fn<() => Promise<void>>(() => Promise.resolve());
    const answer = await enrolThisPhoneInLocker(
      VAULT,
      deps({
        fetchKey: () =>
          Promise.reject(
            new LockerKeyDoorError(
              403,
              "replica_device_not_enrolled",
              "the authenticated device is not enrolled for this vault"
            )
          ),
        storeKey,
      })
    );
    expect(answer).toStrictEqual({
      ok: false,
      reason: "not_allowed",
      message: ENROL_NOT_ALLOWED,
    });
    expect(storeKey).not.toHaveBeenCalled();
  });

  it("stores nothing when the answer names another vault", async () => {
    const storeKey = vi.fn<() => Promise<void>>(() => Promise.resolve());
    const handed = Uint8Array.from(KEY);
    const answer = await enrolThisPhoneInLocker(
      VAULT,
      deps({
        fetchKey: () =>
          Promise.resolve({
            vaultId: "some-other-vault",
            keyId: "key-1",
            key: handed,
          }),
        storeKey,
      })
    );
    expect(answer).toStrictEqual({
      ok: false,
      reason: "wrong_vault",
      message: ENROL_WRONG_VAULT,
    });
    expect(storeKey).not.toHaveBeenCalled();
    expect([...handed]).toStrictEqual([...new Uint8Array(32)]);
  });

  it("never logs the door's answer", async () => {
    const log = vi.spyOn(console, "log").mockReturnValue(undefined);
    const warn = vi.spyOn(console, "warn").mockReturnValue(undefined);
    const error = vi.spyOn(console, "error").mockReturnValue(undefined);
    await enrolThisPhoneInLocker(VAULT, deps());
    await enrolThisPhoneInLocker(
      VAULT,
      deps({
        fetchKey: () => Promise.reject(new Error("boom: key=AAAA keyId=key-1")),
      })
    );
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    log.mockRestore();
    warn.mockRestore();
    error.mockRestore();
  });
});
