/*
 * THE LINK TO `centraid native-host` (#1020 wave 4 lane extension, D-1020-X4,
 * D-1020-X7).
 *
 * Everything decidable about talking to the host is here, behind an injected
 * port factory and clock, so the whole of it — the retry classification, the
 * fill's clearing, the badge push, the staged capture — is driven by
 * `host-link.test.ts` against a fake port. `worker.ts` is the `chrome.*` surface
 * over it and holds no decisions, for the same reason `desktop`'s `preload.ts`
 * holds none.
 *
 * ## One port, closed when idle — and why that is a change from lane F
 *
 * Lane F's Companion opened a **native port per request**, and the reason was
 * good: *a native port holds a process, and a background page that kept one open
 * would keep `centraid native-host` — and through it a capability token — alive
 * for the life of the browser* (`extension/README.md`). Two facts moved it:
 *
 * 1. the seat's capability token is **single-use** (D-1020-F14), so one port per
 *    request is one token per request, and the shell cannot mint a token per
 *    keystroke;
 * 2. the approval badge is better **pushed** than polled (D-1020-X4), and a push
 *    needs a port that is open when the seat has something to say.
 *
 * So the port is opened on first use and **closed after
 * [`IDLE_CLOSE_MS`] of silence**. The property lane F wanted is kept — no
 * unattended host holding a token — and it is now bounded by USE rather than by
 * request count, which is the honest version of the same rule: a Companion
 * nobody is using holds nothing, and a Companion someone is using holds one.
 *
 * ## The staleness contract the badge now has
 *
 * **Live while the port is open, and at most one minute otherwise.** The alarm
 * is not deleted — it is the fallback, exactly as before — and the push is what
 * makes the common case exact. Both halves are stated in `extension/README.md`
 * because it is a contract a member can notice.
 */

import { clearFillMaterial, clearSavedPassword } from "./credential-gesture.js";
import { HostRefusalError } from "./host-refusal.js";
import { isIdempotent, isMethod, MAX_FRAME_BYTES } from "./methods.js";

/** The host's name, matching `centraid native-host install`'s manifest. */
export const HOST_NAME = "dev.centraid.host";

/** How many times one method is tried. v0's ceiling. */
export const MAX_ATTEMPTS = 3;

/**
 * How long the port stays open with nothing on it.
 *
 * Thirty seconds: long enough that a member clicking through a popup does not
 * respawn the host between clicks, short enough that a tab left open overnight
 * is not a host process holding a capability token. It is also the reveal
 * window, which is not a coincidence — a port with a live fill on it is a port
 * in use.
 */
export const IDLE_CLOSE_MS = 30_000;

/** The minimum shape of a native port, so a test can be one. */
export interface NativePort {
  postMessage: (message: unknown) => void;
  disconnect: () => void;
  onMessage: { addListener: (fn: (message: unknown) => void) => void };
  onDisconnect: { addListener: (fn: () => void) => void };
}

/** What a frame answered. */
export type HostFrame = Record<string, unknown>;

/**
 * The member sentence for a refusal code.
 *
 * One sentence per reason and no raw error text: a member cannot act on
 * "ECONNREFUSED", and each of the host's and seat's codes maps to something they
 * can do. The Locker codes are the seat's own (`LockerCode::as_str`) and the
 * handshake codes are `RefusalCode`'s.
 */
export function memberSentence(code: string, fallback?: string): string {
  switch (code) {
    case "no-capability":
    case "token-missing":
    case "token-unknown":
    case "token-spent":
      return "Open Centraid and allow the browser extension to connect.";
    case "host-missing":
      return "Centraid is not installed on this computer, or its browser connector has not been set up yet.";
    case "foreign-peer":
      return "Centraid is running as a different user account on this computer.";
    case "protocol-mismatch":
    case "unknown-method":
      return "Centraid and this extension are from different versions — update both.";
    case "not-permitted":
      return "Unlock Centraid itself — the browser never takes your passphrase.";
    case "locker-not-enrolled":
      return "Set a Locker passphrase in Centraid on this computer first.";
    case "locker-locked":
      return "Locker is locked — unlock it in Centraid.";
    case "locker-expired":
      return "That took too long — try the fill again.";
    case "locker-origin-mismatch":
      return "This page is not the site that login is for.";
    case "locker-missing":
      return "That login is not in this vault any more.";
    default:
      return (
        fallback ||
        "Centraid could not answer that. Open the app and try again."
      );
  }
}

/** Every code `memberSentence` answers, so the drift test has one list. */
export const KNOWN_CODES = [
  "no-capability",
  "token-missing",
  "token-unknown",
  "token-spent",
  "host-missing",
  "foreign-peer",
  "protocol-mismatch",
  "unknown-method",
  "not-permitted",
  "locker-not-enrolled",
  "locker-locked",
  "locker-expired",
  "locker-origin-mismatch",
  "locker-missing",
] as const;

/**
 * Whether a failed attempt should be retried.
 *
 * v0's rule, carried (`transport-core.ts:33`–`:52`): a refusal the host marked
 * unretryable is never retried, and a method that is not idempotent retries only
 * a **clear connect failure** — because a request that reached the app and then
 * failed may have been taken. The host's own `retryable` flag is preferred over
 * the local table when there is one, because the host is the side that knows
 * whether anything happened.
 */
export function shouldRetry(input: {
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly method: string;
  readonly error: unknown;
}): boolean {
  if (input.attempt >= input.maxAttempts) return false;
  if (input.error instanceof HostRefusalError) {
    // THE HOST ANSWERED, so something reached it. Its own classification wins,
    // and a refusal it called final is final whatever the method is.
    return input.error.retryable;
  }
  // Nothing answered: the port never opened, or it dropped. That is the clear
  // connect failure v0's rule admits for every method.
  return isIdempotent(input.method) || isConnectFailure(input.error);
}

/** A disconnect before anything answered. */
export function isConnectFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("Specified native messaging host not found") ||
    message.includes("host-missing") ||
    message.includes("the port closed")
  );
}

/** What the link needs from its host to be testable. */
export interface LinkEnvironment {
  readonly connect: (name: string) => NativePort;
  readonly now: () => number;
  /** Called whenever the host pushes an unsolicited frame (the badge). */
  readonly onPush?: (frame: HostFrame) => void;
}

/**
 * One long-lived port, with the retry classification and the fill's clearing
 * around it.
 */
export class HostLink {
  #env: LinkEnvironment;
  #port: NativePort | undefined;
  #pending: ((frame: HostFrame) => void)[] = [];
  #lastUsed = 0;
  #closed = false;

  constructor(env: LinkEnvironment) {
    this.#env = env;
  }

  /** Whether a port is currently held. */
  get open(): boolean {
    return this.#port !== undefined;
  }

  /** Whether the port has been idle long enough to close. */
  idleFor(ms = IDLE_CLOSE_MS): boolean {
    return this.open && this.#env.now() - this.#lastUsed >= ms;
  }

  /** Close the port now. Idempotent. */
  close(): void {
    const port = this.#port;
    this.#port = undefined;
    // EVERY WAITER IS ANSWERED. A pending request left unresolved is a popup
    // spinner that never stops, which is worse than a refusal.
    const waiting = this.#pending;
    this.#pending = [];
    for (const resolve of waiting) {
      // `retryable: true` — A CLOSED PORT MEANS NOTHING REACHED THE HOST, which
      // is exactly v0's "clear connect failure", the one failure every method
      // may repeat whatever its idempotency. A refusal the HOST sent carries its
      // own flag and is judged on that instead.
      resolve({
        t: "error",
        code: "host-missing",
        message: "the port closed",
        retryable: true,
      });
    }
    port?.disconnect();
  }

  #ensure(): NativePort {
    if (this.#port) return this.#port;
    this.#closed = false;
    const port = this.#env.connect(HOST_NAME);
    this.#port = port;
    port.onMessage.addListener((message) => {
      const frame = (message ?? {}) as HostFrame;
      const next = this.#pending.shift();
      if (next) {
        next(frame);
        return;
      }
      // AN UNSOLICITED FRAME IS A PUSH (D-1020-X4), not an orphan: the host
      // sends the approval count when the seat's state changes.
      this.#env.onPush?.(frame);
    });
    port.onDisconnect.addListener(() => {
      if (this.#closed) return;
      this.#closed = true;
      this.close();
    });
    return port;
  }

  /**
   * One frame, one answer — no retry, no clearing. The raw turn.
   *
   * Requests are answered in order, which is the native-messaging contract: one
   * port is one stream and the host answers each frame before reading the next.
   */
  async send(frame: Record<string, unknown>): Promise<HostFrame> {
    const port = this.#ensure();
    this.#lastUsed = this.#env.now();
    const encoded = JSON.stringify(frame);
    if (encoded.length > MAX_FRAME_BYTES) {
      // REFUSED HERE, because the browser drops a frame over its ceiling with no
      // error anyone sees — the caller should have staged it.
      throw new HostRefusalError(
        "frame-too-large",
        `a ${encoded.length}-byte frame is over the browser's ceiling — stage it instead`,
        false
      );
    }
    return await new Promise<HostFrame>((resolve) => {
      this.#pending.push(resolve);
      port.postMessage(frame);
    });
  }

  /**
   * One Companion method, with the retry classification around it.
   *
   * Returns the value the host answered. It does **not** clear fill material —
   * [`fillInto`] does, in the order that makes the clearing mean something.
   */
  async ask(
    method: string,
    input: Record<string, unknown> = {}
  ): Promise<unknown> {
    if (!isMethod(method)) {
      throw new HostRefusalError(
        "unknown-method",
        memberSentence("unknown-method"),
        false
      );
    }
    const request: Record<string, unknown> = { t: method, ...input };
    let attempt = 0;
    for (;;) {
      attempt += 1;
      try {
        // A retry is by definition the previous attempt having finished.
        // oxlint-disable-next-line no-await-in-loop
        const frame = await this.send(request);
        return this.#unwrap(request, frame);
      } catch (error) {
        clearSavedPassword(request);
        if (
          !shouldRetry({ attempt, maxAttempts: MAX_ATTEMPTS, method, error })
        ) {
          throw error;
        }
      }
    }
  }

  /**
   * THE FILL, AND ITS CLEARING (census §E seam 4, D-1020-X2).
   *
   * The order is the whole thing, and it is v0's
   * (`apps/extension/src/worker.ts:28`–`:30`):
   *
   * 1. ask the host, which asks the seat, which unwraps `K` behind the member's
   *    unlock and answers a value with a thirty-second life;
   * 2. **hand it on** — `respond` crosses a process boundary and structured-clones
   *    it, so the receiver gets its own copy;
   * 3. **clear this process's copy**, so the credential does not survive the
   *    round trip in the service worker.
   *
   * Step 3 is why `respond` is a parameter rather than this returning the value:
   * a caller that received it could not be made to drop it, and v0's `nothing
   * tests that it happened` is exactly that gap. `host-link.test.ts` drives this
   * with a responder that snapshots, and asserts both halves — the receiver's
   * copy is intact AND the worker's object is empty.
   */
  async fillInto(
    input: Record<string, unknown>,
    respond: (value: unknown) => void
  ): Promise<void> {
    const value = await this.ask("locker:fill", input);
    respond(value);
    clearFillMaterial(value);
  }

  #unwrap(request: Record<string, unknown>, frame: HostFrame): unknown {
    // A SAVE'S PASSWORD GOES WHATEVER HAPPENED, success or refusal.
    clearSavedPassword(request);
    if (frame["t"] === "error") {
      const code =
        typeof frame["code"] === "string" ? frame["code"] : "unknown";
      const detail =
        typeof frame["message"] === "string" ? frame["message"] : undefined;
      throw new HostRefusalError(
        code,
        memberSentence(code, detail),
        frame["retryable"] === true
      );
    }
    if (frame["t"] !== "ok") {
      throw new HostRefusalError(
        "protocol-mismatch",
        memberSentence("protocol-mismatch"),
        false
      );
    }
    return frame["value"];
  }
}

export { HostRefusalError } from "./host-refusal.js";
