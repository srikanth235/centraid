import type { ServerResponse } from "node:http";

import { sendJson } from "./route-helpers.js";

export const SSE_MAX_SUBSCRIBERS = 32;

/**
 * ONE PHONE MAY NOT STARVE THE HOUSEHOLD (#1014, V17).
 *
 * The cap was per PROCESS and nothing else: one device opening 32 radios took
 * every slot, and every other seat got `503 sse_capacity` with — until this
 * issue's periodic pull — no delivery path at all to fall back on. A device
 * needs at most a couple of live streams (the multiplex radio, plus one
 * crossing a reconnect), so two is generous and a third is a leak.
 */
export const SSE_PER_DEVICE_MAX = 2;

const SSE_RETRY_AFTER_SECONDS = 5;

export class SseSubscriberCap {
  private count = 0;
  /** Live streams per device, for the fairness bound above. Zero entries are
   *  deleted, so this map is the size of the households actually connected. */
  private readonly perDevice = new Map<string, number>();

  constructor(
    private readonly max: number = SSE_MAX_SUBSCRIBERS,
    private readonly perDeviceMax: number = SSE_PER_DEVICE_MAX
  ) {}

  current(): number {
    return this.count;
  }

  /** How many streams this device holds right now. */
  currentFor(deviceId: string): number {
    return this.perDevice.get(deviceId) ?? 0;
  }

  /**
   * #351 Tier 4 hygiene. Release fn MUST run once at stream end; saturation
   * → 503 + Retry-After, undefined, no write after.
   *
   * `deviceId` is optional because not every stream is device-addressed; a
   * stream without one is bounded by the process cap alone, exactly as before.
   */
  admit(res: ServerResponse, deviceId?: string): (() => void) | undefined {
    if (
      deviceId !== undefined &&
      this.currentFor(deviceId) >= this.perDeviceMax
    )
      return this.refuse(
        res,
        `this device already holds ${this.perDeviceMax} streams on this gateway — retry shortly`
      );
    if (this.count >= this.max)
      return this.refuse(
        res,
        `too many concurrent subscribers on this stream (max ${this.max}) — retry shortly`
      );
    this.count += 1;
    if (deviceId !== undefined)
      this.perDevice.set(deviceId, this.currentFor(deviceId) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.count = Math.max(0, this.count - 1);
      if (deviceId === undefined) return;
      const held = this.currentFor(deviceId) - 1;
      if (held > 0) this.perDevice.set(deviceId, held);
      else this.perDevice.delete(deviceId);
    };
  }

  private refuse(res: ServerResponse, message: string): undefined {
    // Retry-After on BOTH refusals: a client told to back off without a delay
    // reconnects immediately and turns a cap into a hot loop.
    res.setHeader("Retry-After", String(SSE_RETRY_AFTER_SECONDS));
    sendJson(res, 503, { error: "sse_capacity", message });
    return undefined;
  }
}
