// THE IMPORT'S DOOR IS THE DURABLE UPLOAD QUEUE (#1014, R20/R8/P4).
//
// The first-run import used to POST each original at the gateway's staged
// import route and publish the batch: no queue row, so no durability across a
// kill and no sha256 on the device row (which is what Photos' timeline joins
// the roll to the vault BY, so an imported photograph listed twice for ever);
// no vault address, so every original landed in whichever vault the gateway
// picked; and no transfer policy, so originals shipped over a metered radio
// the member had told the policy table never to use.
//
// What this file pins is that door: every candidate goes through
// `backupDeviceMedia` with its vault and its OWN media type, nothing is sent
// when the policy refuses, and the imported-vs-already-in count comes from the
// queue's own per-vault ledger rather than a publish response.

import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as TypeImport_producer from "../../lib/upload/media-producer";
import type * as TypeImport_policy from "../../lib/upload/native-policy";
import type { ImportCandidate } from "./camera-roll-import";
import type * as TypeImport_deviceMedia from "./device-media";

class FakeFile {
  readonly uri: string;

  constructor(base: string | { uri: string }, name?: string) {
    const root = typeof base === "string" ? base : base.uri;
    this.uri = name === undefined ? root : `${root}/${name}`;
  }

  get name(): string {
    return this.uri.split("/").at(-1) ?? this.uri;
  }

  readonly size = 4_096;
}

vi.mock(import("expo-file-system"), () => ({
  File: FakeFile as unknown as (typeof import("expo-file-system"))["File"],
}));

let liveVideo: string | null = null;

vi.mock(import("./device-media"), () => ({
  openDeviceOriginal: ((localId: string) =>
    Promise.resolve({
      asset: {},
      uri: `file:///dcim/${localId}.HEIC`,
    })) as unknown as typeof TypeImport_deviceMedia.openDeviceOriginal,
  liveVideoUri: () => Promise.resolve(liveVideo),
}));

let canTransfer = true;

vi.mock(import("../../lib/upload/native-policy"), () => ({
  LAST_SUCCESSFUL_SYNC_KEY: "photos.lastSuccessfulSync" as const,
  nativeUploadPolicy: (() => ({
    canTransfer: () => Promise.resolve(canTransfer),
  })) as unknown as typeof TypeImport_policy.nativeUploadPolicy,
}));

/** Every enqueue the import made, in order, with the fact the producer would
 *  have told it back about the queue's ledger. */
let queued: TypeImport_producer.DeviceMediaInput[];
let alreadySettled: Set<string>;

vi.mock(import("../../lib/upload/media-producer"), () => ({
  backupDeviceMedia: ((
    _session: unknown,
    _base: string,
    input: TypeImport_producer.DeviceMediaInput
  ) => {
    queued.push(input);
    input.onEnqueued?.({
      sha256: "f".repeat(64),
      isNew: !alreadySettled.has(input.localUri),
    });
    return Promise.resolve("f".repeat(64));
  }) as unknown as typeof TypeImport_producer.backupDeviceMedia,
}));

const { attemptImportCandidate, deviceMediaType, POLICY_BLOCKED_MESSAGE } =
  await import("./camera-roll-import-run");

const SCOPE = {
  gatewayBase: "http://gw",
  session: {} as never,
  vaultId: "vault-family",
};

function candidate(overrides: Partial<ImportCandidate> = {}): ImportCandidate {
  return {
    id: "a",
    localId: "local-a",
    filename: "IMG_0001.HEIC",
    kind: "photo",
    capturedAt: "2026-02-03T10:00:00.000Z",
    width: 3_024,
    height: 4_032,
    ...overrides,
  };
}

describe("the camera-roll import's door", () => {
  beforeEach(() => {
    queued = [];
    alreadySettled = new Set();
    canTransfer = true;
    liveVideo = null;
  });

  it("queues the original against the vault being imported into", async () => {
    await expect(attemptImportCandidate(SCOPE, candidate())).resolves.toBe(
      "imported"
    );

    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      localUri: "file:///dcim/local-a.HEIC",
      targetVaultId: "vault-family",
      filename: "IMG_0001.HEIC",
      mediaType: "image/heic",
      kind: "photo",
      capturedAt: "2026-02-03T10:00:00.000Z",
      width: 3_024,
      height: 4_032,
    });
  });

  // The gateway's preview codec cannot decode HEIC, so declaring one as a
  // JPEG would cost it the phone's own display rungs and leave it with a
  // durable "unsupported" stamp instead.
  it("declares the original's own type", () => {
    expect(deviceMediaType({ kind: "photo", filename: "a.HEIC" })).toBe(
      "image/heic"
    );
    expect(deviceMediaType({ kind: "photo", filename: "a.JPG" })).toBe(
      "image/jpeg"
    );
    expect(deviceMediaType({ kind: "video", filename: "a.MOV" })).toBe(
      "video/mp4"
    );
  });

  it("queues a Live Photo's paired video under the same capture group", async () => {
    liveVideo = "file:///dcim/local-a.MOV";

    await attemptImportCandidate(SCOPE, candidate());

    expect(queued.map((input) => input.captureGroupId)).toStrictEqual([
      "live:local-a",
      "live:local-a",
    ]);
    expect(queued[1]).toMatchObject({
      kind: "video",
      mediaType: "video/quicktime",
      targetVaultId: "vault-family",
    });
  });

  // P4: originals are bytes, and the policy table's `never` is its floor.
  it("ships nothing when the transfer rules refuse", async () => {
    canTransfer = false;

    await expect(attemptImportCandidate(SCOPE, candidate())).rejects.toThrow(
      POLICY_BLOCKED_MESSAGE
    );
    expect(queued).toStrictEqual([]);
  });

  // The count the member reads is the queue's answer for THIS vault, not a
  // publish response: the same photograph already in the personal vault is
  // still new to the family one.
  it("reports bytes this vault's queue already settled as already in", async () => {
    alreadySettled.add("file:///dcim/local-a.HEIC");

    await expect(attemptImportCandidate(SCOPE, candidate())).resolves.toBe(
      "skipped"
    );
  });
});
