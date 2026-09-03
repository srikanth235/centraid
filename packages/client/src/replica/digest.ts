export type ReplicaDigest = (input: string) => Promise<string>;

export type ReplicaIdFactory = () => string;

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export const webCryptoDigest: ReplicaDigest = async (input) =>
  hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input)));

export const webCryptoIdFactory: ReplicaIdFactory = () => crypto.randomUUID();
