import type { ServerResponse } from "node:http";

import { sendJson } from "./route-helpers.js";

export const SSE_MAX_SUBSCRIBERS = 32;

const SSE_RETRY_AFTER_SECONDS = 5;

export class SseSubscriberCap {
  private count = 0;

  constructor(private readonly max: number = SSE_MAX_SUBSCRIBERS) {}

  current(): number {
    return this.count;
  }

  admit(res: ServerResponse): (() => void) | undefined {
    if (this.count >= this.max) {
      res.setHeader("Retry-After", String(SSE_RETRY_AFTER_SECONDS));
      sendJson(res, 503, {
        error: "sse_capacity",
        message: `too many concurrent subscribers on this stream (max ${this.max}) — retry shortly`,
      });
      return undefined;
    }
    this.count += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.count = Math.max(0, this.count - 1);
    };
  }
}
