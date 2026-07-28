/* oxlint-disable typescript-eslint/ban-ts-comment -- imports the untyped browser
   kit module (plain JS); suppressing per-file matches kit-smoke.test.ts. */
// @ts-nocheck — exercises the untyped browser kit module (plain JS) directly.
// Unit tests for the shared consent / parked-write flow (issue #420) — the ONE
// state machine turning a parked vault invocation into an Approve/Discard
// decision.
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it, vi } from "vitest";

const PKG = path.resolve(import.meta.dirname, "..");
const url = pathToFileURL(path.resolve(PKG, "kit/consent-cards.js")).href;
const {
  outcomeOf,
  shortVal,
  describeParked,
  fetchParkedEntry,
  confirmParked,
  normalizeApproveOutcome,
} = await import(url);

type ConsentFetchTestSeam = (
  url: string,
  options?: { method?: string; body?: string }
) => Promise<{ ok: boolean; status: number; body: Record<string, unknown> }>;

describe("outcomeOf", () => {
  it("finds a bare or nested InvokeOutcome, else null", () => {
    expect(outcomeOf({ status: "parked" })).toStrictEqual({ status: "parked" });
    expect(outcomeOf({ output: { status: "denied" } })).toStrictEqual({
      status: "denied",
    });
    expect(outcomeOf({ nope: 1 })).toBeNull();
    expect(outcomeOf(null)).toBeNull();
  });
});

describe("shortVal + describeParked", () => {
  it("truncates long values", () => {
    expect(shortVal("a".repeat(80)).endsWith("…")).toBe(true);
    expect(shortVal("short")).toBe("short");
  });

  it("builds a title + caller-prefixed detail line", () => {
    const d = describeParked({
      command: "add_task",
      caller: "tasks",
      input: { title: "Buy milk", due: "2026-07-20" },
    });
    expect(d.title).toBe("add_task");
    expect(d.detail).toBe("tasks · title: Buy milk · due: 2026-07-20");
  });

  it('falls back to "no input" when the invocation carries none', () => {
    expect(describeParked({ command: "x", input: {} }).detail).toBe("no input");
  });
});

describe("fetchParkedEntry", () => {
  it("finds the matching invocation on the consent surface", async () => {
    const fetchJson = vi.fn<ConsentFetchTestSeam>().mockResolvedValue({
      ok: true,
      status: 200,
      body: {
        parked: [
          { invocationId: "inv-1", command: "a" },
          { invocationId: "inv-2" },
        ],
      },
    });
    await expect(
      fetchParkedEntry("inv-2", { fetchJson })
    ).resolves.toStrictEqual({
      invocationId: "inv-2",
    });
    expect(fetchJson).toHaveBeenCalledWith("/centraid/_vault/parked");
    await expect(fetchParkedEntry("gone", { fetchJson })).resolves.toBeNull();
  });
});

describe("confirmParked", () => {
  it("POSTs the decision and returns the outcome body", async () => {
    const fetchJson = vi.fn<ConsentFetchTestSeam>().mockResolvedValue({
      ok: true,
      status: 200,
      body: { status: "executed", receiptId: "r1" },
    });
    const out = await confirmParked("inv-1", true, { fetchJson });
    expect(out).toStrictEqual({ status: "executed", receiptId: "r1" });
    const [url, opts] = fetchJson.mock.calls[0];
    expect(url).toBe("/centraid/_vault/parked/inv-1");
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body)).toStrictEqual({ approve: true });
  });

  it("throws the server message on a non-ok response", async () => {
    const fetchJson = vi.fn<ConsentFetchTestSeam>().mockResolvedValue({
      ok: false,
      status: 409,
      body: { message: "stale" },
    });
    await expect(confirmParked("inv-1", false, { fetchJson })).rejects.toThrow(
      "stale"
    );
  });
});

describe("normalizeApproveOutcome", () => {
  it("maps executed/replayed to ok, everything else to a refusal note", () => {
    expect(
      normalizeApproveOutcome({ status: "executed", receiptId: "r1" })
    ).toStrictEqual({
      ok: true,
      receipt: "approved · receipt r1",
    });
    expect(normalizeApproveOutcome({ status: "replayed" })).toStrictEqual({
      ok: true,
      receipt: "already applied",
    });
    expect(
      normalizeApproveOutcome({ status: "denied", reason: "no grant" })
    ).toStrictEqual({
      ok: false,
      note: "no grant",
    });
    expect(normalizeApproveOutcome(null)).toStrictEqual({
      ok: false,
      note: "The vault refused this write.",
    });
  });
});
