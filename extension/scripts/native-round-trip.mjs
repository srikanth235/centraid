/*
 * Speak the browser's native-messaging framing to `centraid native-host` and
 * print what comes back (#1020, D-1020-F6).
 *
 * This is the demonstration the lane owes: the host is launched the way a
 * browser launches it — stdin and stdout, `u32` in the HOST's byte order, then
 * UTF-8 JSON — and a `ping` round-trips. Chrome's own framing is the trap
 * (`crates/centraid/src/cmd/native_host.rs`: the product's wire is `u32BE` and
 * this one is native-endian), so the script writes it from the same helper the
 * extension's tests use rather than from a second copy.
 *
 *     node extension/scripts/native-round-trip.mjs [--binary <path>]
 *
 * Exits 0 and prints the reply on success; exits 1 with a reason otherwise.
 * `crates/centraid/tests/no_listener.rs` asserts the same round trip from Rust,
 * so this script is the human-readable half rather than the only proof.
 */

import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const LITTLE_ENDIAN = os.endianness() === "LE";

function flag(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : fallback;
}

const binary = flag(
  "binary",
  path.join(
    process.env.CARGO_TARGET_DIR ??
      path.join(import.meta.dirname, "../../target"),
    "debug",
    "centraid"
  )
);

function frame(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  if (LITTLE_ENDIAN) header.writeUInt32LE(body.length, 0);
  else header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

function unframe(bytes) {
  if (bytes.length < 4) return undefined;
  const length = LITTLE_ENDIAN ? bytes.readUInt32LE(0) : bytes.readUInt32BE(0);
  if (bytes.length < 4 + length) return undefined;
  return JSON.parse(bytes.subarray(4, 4 + length).toString("utf8"));
}

const host = spawn(binary, ["native-host"], {
  stdio: ["pipe", "pipe", "inherit"],
});
const chunks = [];
host.stdout.on("data", (chunk) => chunks.push(chunk));
host.stdin.write(frame({ t: "ping" }));
host.stdin.end();

const code = await new Promise((resolve) => {
  host.on("exit", resolve);
});
const reply = unframe(Buffer.concat(chunks));
if (code !== 0 || !reply) {
  process.stderr.write(`the host exited ${code} with no framed reply\n`);
  process.exit(1);
}
process.stdout.write(`${JSON.stringify(reply, null, 2)}\n`);
if (reply.t !== "pong") {
  process.stderr.write(`expected a pong, got ${String(reply.t)}\n`);
  process.exit(1);
}
