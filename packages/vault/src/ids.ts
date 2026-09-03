import { createHash } from "node:crypto";

export { v7 as uuidv7 } from "uuid";

export function nowIso(): string {
  return new Date().toISOString();
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
