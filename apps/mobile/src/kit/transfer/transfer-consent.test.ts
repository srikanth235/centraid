// The consent latch (#711, S4). The gate is the safety property of the whole
// automatic-backup model, so it is tested as a predicate rather than through a
// screen: if `automaticTransferAllowed` can ever say yes to a device that did
// not answer, no amount of UI review makes the product honest.

import { describe, expect, it, vi } from "vitest";

import {
  BACKUP_CONSENT_KEY,
  answerBackupConsent,
  automaticTransferAllowed,
  automaticTransferPlan,
  backupConsentPanel,
} from "./transfer-consent";
import { DEFAULT_TRANSFER_POLICY } from "./transfer-policy";

interface Item {
  id: string;
  custody: "local-only" | "backed-up" | "remote-only";
}

const LIBRARY: Item[] = [
  { id: "fresh", custody: "local-only" },
  { id: "safe", custody: "backed-up" },
  { id: "offloaded", custody: "remote-only" },
  { id: "also-fresh", custody: "local-only" },
];

const localOnly = (item: Item): boolean => item.custody === "local-only";

// AsyncStorage is a native module; the durable mirror is stood in for so the
// pure latch logic runs under node. `hydrate` is not exercised here — the
// question these cases ask is what the predicate does with a record, not how
// the record reaches disk.
vi.mock(import("../../storage") as Promise<unknown>, () => {
  const cache = new Map<string, unknown>();
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
    // A member with two phones has two answers; a key under `photos.` would
    // invite someone to sync it through the vault, which would mean a new
    // phone starts uploading on the strength of an answer given elsewhere.
    expect(BACKUP_CONSENT_KEY).toBe("frame.backupConsent");
  });
});

describe(automaticTransferAllowed, () => {
  it("refuses a device that has never been asked", () => {
    // `undefined` is the state of a fresh install. An unanswered question is
    // not a yes — that is the entire difference between S4 and uploading a
    // stranger's camera roll.
    expect(automaticTransferAllowed(undefined)).toBe(false);
  });

  it("refuses a device that said not now", () => {
    expect(
      automaticTransferAllowed({
        answer: "not-now",
        at: "2026-08-05T00:00:00Z",
      })
    ).toBe(false);
  });

  it("allows only the explicit automatic answer", () => {
    expect(
      automaticTransferAllowed({
        answer: "automatic",
        at: "2026-08-05T00:00:00Z",
      })
    ).toBe(true);
  });
});

describe(automaticTransferPlan, () => {
  // THE SABOTAGE TARGET. Delete the consent check inside `automaticTransferPlan`
  // and these three cases go red — the model stops being a promise the moment
  // an unanswered device can produce work.
  it("enqueues NOTHING on a device that was never asked", () => {
    expect(automaticTransferPlan(undefined, LIBRARY, localOnly)).toStrictEqual(
      []
    );
  });

  it("enqueues NOTHING on a device that declined", () => {
    expect(
      automaticTransferPlan(
        { answer: "not-now", at: "2026-08-05T00:00:00Z" },
        LIBRARY,
        localOnly
      )
    ).toStrictEqual([]);
  });

  it("enqueues exactly the local-only items once consent is given", () => {
    // `backed-up` is already safe and `remote-only` has no device copy to
    // send: sweeping either would be re-uploading the library forever.
    expect(
      automaticTransferPlan(
        { answer: "automatic", at: "2026-08-05T00:00:00Z" },
        LIBRARY,
        localOnly
      ).map((item) => item.id)
    ).toStrictEqual(["fresh", "also-fresh"]);
  });
});

describe(answerBackupConsent, () => {
  it("stamps the answer so the surface can show it back", () => {
    const record = answerBackupConsent("automatic");
    expect(record.answer).toBe("automatic");
    expect(Number.isNaN(Date.parse(record.at))).toBe(false);
  });

  it("is revocable — the latch reopens on not-now", () => {
    answerBackupConsent("automatic");
    const stopped = answerBackupConsent("not-now");
    expect(automaticTransferAllowed(stopped)).toBe(false);
  });
});

describe("the consent panel", () => {
  it("states where the bytes go, and marks it as egress", () => {
    const panel = backupConsentPanel();
    const egress = panel.facts.filter((fact) => fact.net);
    // Exactly one fact carries the `net` rule: the one about bytes leaving the
    // device. Marking more would make the mark meaningless.
    expect(egress).toHaveLength(1);
    expect(egress[0]?.label).toBe("Where the bytes go");
  });

  it("states the policy it is about to run under, not a comfortable default", () => {
    const strict = backupConsentPanel({
      ...DEFAULT_TRANSFER_POLICY,
      chargerOnly: true,
    });
    const when = strict.facts.find((fact) => fact.label === "When");
    expect(when?.value).toContain("only while charging");
  });

  it("offers one filled answer and one plain refusal", () => {
    const panel = backupConsentPanel();
    expect(panel.action).toBe("Back up automatically");
    expect(panel.action2).toBe("Not now");
  });
});
