// The capture-time OCR consent latch (issue #712 C3). Mirrors
// `kit/transfer/transfer-consent.test.ts`'s shape: the gate is tested as a
// predicate, because if `scanOcrExtractionAllowed` can ever say yes to a
// device that never answered, no amount of screen review makes the product
// honest about what a scan does.
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  answerScanOcrConsent,
  hydrateScanOcrConsent,
  scanOcrExtractionAllowed,
  SCAN_OCR_CONSENT_KEY,
} from "./scan-consent";

const mocks = vi.hoisted(() => ({ cache: new Map<string, unknown>() }));

// AsyncStorage is a native module; the durable mirror is stood in for so the
// pure latch logic runs under node — same technique
// transfer-consent.test.ts uses. Exposed via `mocks.cache` (rather than a
// closed-over local) so `beforeEach` below can clear it between tests —
// `answerScanOcrConsent` writes straight through the real module under test.
vi.mock(import("../storage") as Promise<unknown>, () => {
  const cache = mocks.cache;
  return {
    Store: {
      get: <T>(key: string, fallback: T): T =>
        cache.has(key) ? (cache.get(key) as T) : fallback,
      hydrate: <T>(key: string, fallback: T): Promise<T> =>
        Promise.resolve(cache.has(key) ? (cache.get(key) as T) : fallback),
      set: <T>(key: string, value: T): void => {
        cache.set(key, value);
      },
    },
  };
});

describe("the latch", () => {
  it("is device state, under the frame's namespace and not an app's", () => {
    // Two phones, two answers — the same reasoning `transfer-consent.ts`'s
    // `BACKUP_CONSENT_KEY` documents, restated for OCR: a key under `docs.`
    // would invite syncing an answer through the vault, so a new phone would
    // start extracting text from every scan on the strength of an answer
    // given on a different one.
    expect(SCAN_OCR_CONSENT_KEY).toBe("frame.scanOcrConsent");
  });
});

describe(scanOcrExtractionAllowed, () => {
  it("refuses a device that has never been asked", () => {
    expect(scanOcrExtractionAllowed(undefined)).toBe(false);
  });

  it("refuses a device that said not now", () => {
    expect(
      scanOcrExtractionAllowed({
        answer: "not-now",
        at: "2026-08-06T00:00:00Z",
      })
    ).toBe(false);
  });

  it("allows only the explicit on-device answer", () => {
    expect(
      scanOcrExtractionAllowed({
        answer: "on-device",
        at: "2026-08-06T00:00:00Z",
      })
    ).toBe(true);
  });
});

describe(answerScanOcrConsent, () => {
  it("stamps the answer so the surface can show it back", () => {
    const record = answerScanOcrConsent("on-device");
    expect(record.answer).toBe("on-device");
    expect(Number.isNaN(Date.parse(record.at))).toBe(false);
  });

  it("is revocable — answering again changes the latch", () => {
    answerScanOcrConsent("on-device");
    const declined = answerScanOcrConsent("not-now");
    expect(scanOcrExtractionAllowed(declined)).toBe(false);
  });
});

describe(hydrateScanOcrConsent, () => {
  // Cleared here rather than module-wide: this is the one describe block
  // whose first case depends on a truly unanswered cache, and earlier
  // blocks above it answer the latch as part of their own assertions.
  beforeEach(() => {
    mocks.cache.clear();
  });

  it("reads back an unanswered device as undefined", async () => {
    await expect(hydrateScanOcrConsent()).resolves.toBeUndefined();
  });

  it("reads back a stored answer", async () => {
    answerScanOcrConsent("not-now");
    await expect(hydrateScanOcrConsent()).resolves.toMatchObject({
      answer: "not-now",
    });
  });
});
