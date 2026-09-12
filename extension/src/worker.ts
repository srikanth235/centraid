/*
 * The Companion's service worker: one native port, no network (#1020,
 * D-1020-F6).
 *
 * v0's worker starts a WASM iroh endpoint and dials the gateway
 * (`apps/extension/src/transport.ts`). This one does neither. It opens a
 * native-messaging port to `dev.centraid.host` — `centraid native-host`, the
 * same binary the desktop runs — and that host connects to the seat socket as
 * any other local client, passing the same peer check. The extension therefore
 * has **no** `host_permissions` and nothing to reach: if Centraid is not
 * running on this machine, the Companion says so and does nothing.
 *
 * Everything decidable is in `host-core.ts`; this file is the `chrome.*`
 * surface, kept as thin as the desktop's `preload.ts` and for the same reason.
 */

import { HOST_NAME, memberSentence, shouldRetry } from "./host-core.js";
import type { KNOWN_CODES } from "./host-core.js";

type Answer = { ok: true; value: unknown } | { ok: false; message: string };

declare const chrome: {
  runtime: {
    connectNative: (name: string) => {
      postMessage: (message: unknown) => void;
      disconnect: () => void;
      onMessage: { addListener: (fn: (message: unknown) => void) => void };
      onDisconnect: { addListener: (fn: () => void) => void };
    };
    lastError?: { message?: string };
    onMessage: {
      addListener: (
        fn: (
          message: unknown,
          sender: unknown,
          respond: (answer: Answer) => void
        ) => boolean | undefined
      ) => void;
    };
  };
};

/** How many times one verb is tried. v0's ceiling. */
const MAX_ATTEMPTS = 3;

/**
 * One request over a fresh port.
 *
 * A PORT PER REQUEST, not a long-lived one: a native port holds a process, and
 * a background page that kept one open would keep `centraid native-host` (and
 * through it a capability token) alive for the life of the browser. MV3's
 * worker is evicted anyway, so a long-lived port is a lifetime nobody controls.
 */
async function askOnce(message: Record<string, unknown>): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    let port: ReturnType<typeof chrome.runtime.connectNative>;
    try {
      port = chrome.runtime.connectNative(HOST_NAME);
    } catch (error) {
      reject(new Error(memberSentence("host-missing"), { cause: error }));
      return;
    }
    let settled = false;
    const settle = (outcome: { value?: unknown; error?: Error }): void => {
      if (settled) return;
      settled = true;
      port.disconnect();
      if (outcome.error) reject(outcome.error);
      else resolve(outcome.value);
    };
    port.onMessage.addListener((reply) => {
      const shape = reply as { t?: string; code?: string };
      if (shape.t === "error") {
        // The HOST's code, mapped to the member's sentence here — the raw
        // reason never reaches a person.
        const code = shape.code ?? "unknown";
        const error = new Error(memberSentence(code));
        (error as Error & { code?: string }).code = code;
        settle({ error });
        return;
      }
      settle({ value: reply });
    });
    port.onDisconnect.addListener(() => {
      const reason = chrome.runtime.lastError?.message ?? "host-missing";
      settle({ error: new Error(reason) });
    });
    port.postMessage(message);
  });
}

/** One request, with v0's retry classification around it. */
export async function ask(
  verb: string,
  message: Record<string, unknown>
): Promise<unknown> {
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      // A retry is by definition the previous attempt having finished: there
      // is nothing here to run in parallel, and a port per attempt is the
      // point (see `askOnce`).
      // oxlint-disable-next-line no-await-in-loop
      return await askOnce({ t: verb, ...message });
    } catch (error) {
      if (
        !shouldRetry({
          attempt,
          maxAttempts: MAX_ATTEMPTS,
          method: verb,
          error,
        })
      ) {
        throw error;
      }
    }
  }
}

/** The popup's one door onto the host. */
chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  const shape = (message ?? {}) as { verb?: unknown; input?: unknown };
  if (typeof shape.verb !== "string") {
    respond({ ok: false, message: memberSentence("unknown") });
    return false;
  }
  void ask(shape.verb, (shape.input ?? {}) as Record<string, unknown>).then(
    (value) => respond({ ok: true, value }),
    (error: unknown) =>
      respond({
        ok: false,
        message:
          error instanceof Error ? error.message : memberSentence("unknown"),
      })
  );
  // `true` keeps the response channel open for the async answer.
  return true;
});

export type KnownCode = (typeof KNOWN_CODES)[number];
