import { describe, expect, test } from "vitest";

import type {
  RecoveryKitTarget,
  SnapshotRow,
  WalReplayOutcome,
} from "@centraid/backup";

import {
  buildProviderFromTarget,
  currentVersions,
  pickSnapshotRow,
  recoveredAsOfMs,
  selectTarget,
  walReplayTruncated,
} from "./recover-internals.js";

function target(over: Partial<RecoveryKitTarget> = {}): RecoveryKitTarget {
  return {
    provider: "https://home.example",
    targetId: "t1",
    vaultId: "vault-a",
    label: "A",
    ...over,
  };
}

function snapshot(over: Partial<SnapshotRow> = {}): SnapshotRow {
  return {
    seq: 1,
    manifestKey: "m1",
    manifestHash: "h1",
    prevManifestHash: null,
    totalBytes: 10,
    objectCount: 1,
    generation: 1,
    format: "v1",
    appMeta: {},
    createdAt: 1_700_000_000,
    prunedAt: null,
    ...over,
  };
}

describe("recover-internals", () => {
  test("selectTarget returns the only kit target or the named one", () => {
    const only = target();
    expect(selectTarget([only], undefined)).toBe(only);
    const a = target({ vaultId: "a" });
    const b = target({ vaultId: "b", label: "B" });
    expect(selectTarget([a, b], "b")).toStrictEqual(b);
    expect(() => selectTarget([a, b], undefined)).toThrow(
      /choose one with --vault/u
    );
    expect(() => selectTarget([a, b], "missing")).toThrow(
      /no vault "missing"/u
    );
  });

  test("pickSnapshotRow prefers newest at-or-before --at, else newest overall", () => {
    const rows = [
      snapshot({ seq: 3, createdAt: 300 }),
      snapshot({ seq: 2, createdAt: 200 }),
      snapshot({ seq: 1, createdAt: 100 }),
    ];
    expect(pickSnapshotRow(rows, undefined)?.seq).toBe(3);
    expect(pickSnapshotRow(rows, 200_000)?.seq).toBe(2);
    expect(pickSnapshotRow(rows, 50_000)).toBeUndefined();
    expect(pickSnapshotRow([], undefined)).toBeUndefined();
  });

  test("buildProviderFromTarget opens a local provider for local: roots", () => {
    const provider = buildProviderFromTarget(
      target({ provider: "local:/tmp/backup-root" }),
      "unused-key"
    );
    expect(provider).toBeTruthy();
    expect(provider.listSnapshots).toBeTypeOf("function");
  });

  test("recoveredAsOfMs uses the marked cut when present else snapshot time", () => {
    const row = snapshot({ createdAt: 1_000 });
    const withCut = {
      cutTickMs: 1_234,
      expectedCutMs: 1_234,
      newestMarkerTickMs: 1_234,
      truncated: false,
      damaged: [],
    } as unknown as WalReplayOutcome;
    expect(recoveredAsOfMs(withCut, row)).toBe(1_234);
    const baseOnly = {
      cutTickMs: -1,
      expectedCutMs: -1,
      newestMarkerTickMs: -1,
      truncated: false,
      damaged: [],
    } as unknown as WalReplayOutcome;
    expect(recoveredAsOfMs(baseOnly, row)).toBe(1_000_000);
  });

  test("walReplayTruncated is true when the cut is short of the expected tip", () => {
    const shortOfTip = {
      cutTickMs: 100,
      expectedCutMs: 200,
      newestMarkerTickMs: 200,
      truncated: false,
      damaged: [],
    } as unknown as WalReplayOutcome;
    expect(walReplayTruncated(shortOfTip)).toBe(true);
    const selfReported = {
      cutTickMs: 200,
      expectedCutMs: 200,
      newestMarkerTickMs: 200,
      truncated: true,
      damaged: [],
    } as unknown as WalReplayOutcome;
    expect(walReplayTruncated(selfReported)).toBe(true);
    const ok = {
      cutTickMs: 200,
      expectedCutMs: 200,
      newestMarkerTickMs: 200,
      truncated: false,
      damaged: [],
    } as unknown as WalReplayOutcome;
    expect(walReplayTruncated(ok)).toBe(false);
  });

  test("currentVersions reports gateway + ontology ceilings", () => {
    const versions = currentVersions();
    expect(versions.gatewayVersion.length).toBeGreaterThan(0);
    expect(versions.ontologyVersion).toBe("1.0");
    expect(Number(versions.vaultUserVersion)).toBeGreaterThan(0);
  });
});
