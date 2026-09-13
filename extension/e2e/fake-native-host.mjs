/*
 * A FAKE `centraid native-host` (#1020 wave 4 lane extension, D-1020-X6).
 *
 * Speaks the browser's own native-messaging framing — `u32` in the HOST's byte
 * order, then UTF-8 JSON — and answers the eighteen Companion methods and the
 * three staging frames with fixed data. It exists so the Playwright run can
 * exercise the EXTENSION against a real browser-launched native port without a
 * vault, a seat or a key: what that run is about is the browser half — that the
 * manifest loads, that `connectNative` reaches a host, that the fill's material
 * is handed to the page and dropped, that a 3 MB capture arrives in frames that
 * fit.
 *
 * The real host's own half is proven where it belongs:
 * `crates/centraid/tests/native_host.rs` drives the SAME framing against
 * `centraid native-host` and a real `centraid seat`.
 *
 * Every frame it receives is appended to `$CENTRAID_FAKE_HOST_LOG` as one JSON
 * line, which is how the test asserts what the extension actually sent.
 */

import { appendFileSync } from "node:fs";
import os from "node:os";

const LITTLE_ENDIAN = os.endianness() === "LE";
const log = process.env["CENTRAID_FAKE_HOST_LOG"];

/** The one login this fake vault holds. */
const LOGIN = {
  item_id: "item-1",
  title: "Bank",
  username: "someone@example.test",
  url: "https://login.bank.example",
  url_match_policy: "registrable-domain",
  has_totp: false,
  compromised: false,
  warning: false,
};

const staging = new Map();
let minted = 0;

function record(frame) {
  if (!log) return;
  // The chunk payload is not written: a log that carried the bytes would be
  // megabytes per capture and would say nothing the length does not.
  const { bytes_b64: bytes, screenshot, ...rest } = frame;
  appendFileSync(
    log,
    `${JSON.stringify({ ...rest, ...(bytes ? { chunk_bytes: bytes.length } : {}), ...(screenshot ? { screenshot_bytes: screenshot.length } : {}) })}\n`
  );
}

function originOf(raw) {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.origin
      : undefined;
  } catch {
    return undefined;
  }
}

/** The policy, as the real seat applies it — registrable domain, crudely. */
function matches(storedUrl, pageUrl, policy) {
  const stored = originOf(storedUrl);
  const page = originOf(pageUrl);
  if (!stored || !page) return false;
  const host = (origin) => new URL(origin).hostname;
  if (policy === "exact-host") return host(stored) === host(page);
  const registrable = (name) => name.split(".").slice(-2).join(".");
  return (
    new URL(stored).protocol === new URL(page).protocol &&
    registrable(host(stored)) === registrable(host(page))
  );
}

function answer(frame) {
  const ok = (value) => ({ t: "ok", value, retryable: false });
  switch (frame.t) {
    case "ping":
      return {
        t: "pong",
        host: "dev.centraid.host",
        version: "fake",
        attached: true,
      };
    case "status":
    case "pair":
    case "select-vault":
      return ok({
        paired: true,
        product_version: "1.0.0-fake",
        instance: "fake",
      });
    case "unpair":
    case "lock":
      return ok({ ok: true });
    case "unlock":
      return {
        t: "error",
        code: "not-permitted",
        message:
          "Unlock Centraid itself — the browser never takes your passphrase.",
      };
    case "warm":
      return ok({ ok: true });
    case "modules":
      return ok([{ id: "locker", name: "Locker autofill", state: "granted" }]);
    case "blocking-count":
      return ok({ count: 4, capped: false, sources: { outbox: 4 } });
    case "locker:candidates":
      return ok(
        matches(LOGIN.url, frame.pageUrl, LOGIN.url_match_policy) ? [LOGIN] : []
      );
    case "locker:fill":
      if (!matches(LOGIN.url, frame.pageUrl, LOGIN.url_match_policy)) {
        return {
          t: "error",
          code: "locker-origin-mismatch",
          message: "this page is not the site this login is for",
        };
      }
      return ok({
        value: "hunter2-and-more",
        username: LOGIN.username,
        receipt_id: "receipt-7",
        expires_at_ms: 30_000,
        origin: originOf(frame.pageUrl),
      });
    case "locker:save":
    case "capture:task":
    case "capture:note":
    case "capture:document":
    case "agenda:add":
    case "people:add":
      return ok({ status: "COMMITTED", receipt_id: "receipt-8" });
    case "page:capture":
      return ok(null);
    case "stage:begin": {
      minted += 1;
      const id = `stage-${minted}`;
      staging.set(id, { size: frame.byte_size, got: 0, seq: 0 });
      return ok({
        staging_id: id,
        chunk_bytes: 512 * 1024,
        chunks: Math.ceil(frame.byte_size / (512 * 1024)),
      });
    }
    case "stage:chunk": {
      const session = staging.get(frame.staging_id);
      if (!session)
        return { t: "error", code: "stage-refused", message: "no session" };
      if (frame.seq !== session.seq) {
        return { t: "error", code: "stage-refused", message: "out of order" };
      }
      session.seq += 1;
      session.got += Buffer.from(frame.bytes_b64, "base64").length;
      return ok({ received: session.got });
    }
    case "stage:end": {
      const session = staging.get(frame.staging_id);
      staging.delete(frame.staging_id);
      if (!session)
        return { t: "error", code: "stage-refused", message: "no session" };
      return ok({
        sha256: "0".repeat(64),
        byte_size: session.got,
        claimed: false,
        pending: "bytes-door",
      });
    }
    default:
      return {
        t: "error",
        code: "unknown-method",
        method: frame.t,
        message:
          "Centraid and this extension are from different versions — update both.",
      };
  }
}

function write(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  if (LITTLE_ENDIAN) header.writeUInt32LE(body.length, 0);
  else header.writeUInt32BE(body.length, 0);
  process.stdout.write(Buffer.concat([header, body]));
}

let buffer = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    if (buffer.length < 4) return;
    const length = LITTLE_ENDIAN
      ? buffer.readUInt32LE(0)
      : buffer.readUInt32BE(0);
    if (buffer.length < 4 + length) return;
    const frame = JSON.parse(buffer.subarray(4, 4 + length).toString("utf8"));
    buffer = buffer.subarray(4 + length);
    record(frame);
    write(answer(frame));
  }
});
process.stdin.on("end", () => process.exit(0));
