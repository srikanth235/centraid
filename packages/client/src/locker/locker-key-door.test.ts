// FETCHING `K` (#996, R13): the seat's half of the key door. What matters
// here is the refusals — a seat that treats "revoked" as a network blip, or
// decrypts under a construction it does not implement, fails silently, and a
// silent failure over key material is the one failure mode this plane exists
// to remove.
import { describe, expect, test } from "vitest";

import { ROUTES } from "@centraid/core/protocol";

import { fetchLockerVaultKey, LockerKeyDoorError } from "./locker-key-door.js";

const KEY = new Uint8Array(32).fill(7);
const BASE64 = Buffer.from(KEY).toString("base64");

function door(
  status: number,
  body: unknown
): { fetch: typeof globalThis.fetch; calls: Request[] } {
  const calls: Request[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(new Request(String(input), init));
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;
  return { fetch: fetchImpl, calls };
}

describe("locker-key-door", () => {
  test("asks the declared route and decodes the key", async () => {
    const { fetch, calls } = door(200, {
      vaultId: "v-1",
      keyId: "k-1",
      key: BASE64,
      algorithm: "aes-256-gcm",
    });
    const answer = await fetchLockerVaultKey({
      baseUrl: "https://home.example",
      headers: { "x-centraid-device": "seat-1" },
      fetch,
    });
    expect(answer).toStrictEqual({ vaultId: "v-1", keyId: "k-1", key: KEY });
    expect(new URL(calls[0]!.url).pathname).toBe(ROUTES.vaultSeatLockerKey);
    expect(calls[0]!.headers.get("x-centraid-device")).toBe("seat-1");
  });

  test("a revoked device gets the door's reason, not a generic failure", async () => {
    const { fetch } = door(403, {
      error: "replica_device_not_enrolled",
      message: "the authenticated device is not enrolled for this vault",
    });
    await expect(
      fetchLockerVaultKey({ baseUrl: "https://home.example", fetch })
    ).rejects.toThrow(
      expect.objectContaining({
        name: "LockerKeyDoorError",
        status: 403,
        code: "replica_device_not_enrolled",
      })
    );
  });

  test("an unknown algorithm is refused rather than guessed at", async () => {
    // Decrypting under the wrong construction is silent; refusing is loud.
    const { fetch } = door(200, {
      vaultId: "v-1",
      keyId: "k-1",
      key: BASE64,
      algorithm: "xchacha20-poly1305",
    });
    await expect(
      fetchLockerVaultKey({ baseUrl: "https://home.example", fetch })
    ).rejects.toThrow(
      expect.objectContaining({ code: "seat_locker_key_algorithm" })
    );
  });

  test("a key that is not 32 bytes is refused", async () => {
    const { fetch } = door(200, {
      vaultId: "v-1",
      keyId: "k-1",
      key: Buffer.alloc(16).toString("base64"),
      algorithm: "aes-256-gcm",
    });
    await expect(
      fetchLockerVaultKey({ baseUrl: "https://home.example", fetch })
    ).rejects.toThrow(
      expect.objectContaining({ code: "seat_locker_key_length" })
    );
  });

  test("the module keeps nothing — every ask is a fresh request", async () => {
    // A module-level cache of `K` would be a copy of the key that no lock
    // covers and no revocation reaches.
    const { fetch, calls } = door(200, {
      vaultId: "v-1",
      keyId: "k-1",
      key: BASE64,
      algorithm: "aes-256-gcm",
    });
    await fetchLockerVaultKey({ baseUrl: "https://home.example", fetch });
    await fetchLockerVaultKey({ baseUrl: "https://home.example", fetch });
    expect(calls).toHaveLength(2);
    expect(LockerKeyDoorError.name).toBe("LockerKeyDoorError");
  });
});
