// Share-target ingest routing and lifecycle. The hook wires real producers and
// Expo modules; the core is exercised here with fakes, so no React renderer
// or native module is loaded.

import { describe, expect, it, vi } from "vitest";

import type { NativeReplicaSession } from "../../lib/replica/native-session";
import {
  SHARE_STAGING_STALE_MS,
  SHARE_STAGING_SWEEP_LIMIT,
  ShareIntentGate,
  discardShareIntentFiles,
  processShareIntent,
  shareTargetChoices,
  sweepStaleShareStaging,
} from "./share-ingest";
import type {
  ShareIngestPorts,
  ShareStagingEntry,
  SharedIntentFileLike,
} from "./share-ingest";

const session = {} as NativeReplicaSession;
const GATEWAY = "http://127.0.0.1:8787";

function fakePorts(
  overrides: Partial<ShareIngestPorts> = {}
): ShareIngestPorts {
  return {
    backupDeviceMedia: vi.fn<ShareIngestPorts["backupDeviceMedia"]>(
      async () => "sha-media"
    ),
    backupDocument: vi.fn<ShareIngestPorts["backupDocument"]>(
      async () => "sha-doc"
    ),
    fileSize: vi.fn<ShareIngestPorts["fileSize"]>(() => 1234),
    reset: vi.fn<ShareIngestPorts["reset"]>(),
    alert: vi.fn<ShareIngestPorts["alert"]>(),
    ...overrides,
  };
}

function file(
  overrides: Partial<SharedIntentFileLike> & { mimeType: string }
): SharedIntentFileLike {
  return { path: "file:///share/x", fileName: "x", size: 10, ...overrides };
}

describe("processShareIntent routing", () => {
  it("routes images and videos to the media producer with the right kind", async () => {
    const ports = fakePorts();
    await processShareIntent(ports, session, GATEWAY, {
      files: [
        file({
          mimeType: "image/jpeg",
          fileName: "p.jpg",
          width: 4,
          height: 3,
        }),
        file({ mimeType: "video/mp4", fileName: "v.mp4", duration: 12 }),
      ],
    });
    expect(ports.backupDeviceMedia).toHaveBeenCalledTimes(2);
    expect(ports.backupDocument).toHaveBeenCalledTimes(0);
    expect(ports.backupDeviceMedia).toHaveBeenNthCalledWith(
      1,
      session,
      GATEWAY,
      expect.objectContaining({
        kind: "photo",
        width: 4,
        height: 3,
        deleteSourceAfterSettle: true,
      })
    );
    expect(ports.backupDeviceMedia).toHaveBeenNthCalledWith(
      2,
      session,
      GATEWAY,
      expect.objectContaining({
        kind: "video",
        durationS: 12,
        deleteSourceAfterSettle: true,
      })
    );
  });

  it("routes shared audio through the media producer as kind audio (F14e)", async () => {
    const ports = fakePorts();
    await processShareIntent(ports, session, GATEWAY, {
      files: [file({ mimeType: "audio/mpeg", fileName: "song.mp3" })],
    });
    expect(ports.backupDeviceMedia).toHaveBeenCalledWith(
      session,
      GATEWAY,
      expect.objectContaining({ kind: "audio", deleteSourceAfterSettle: true })
    );
    expect(ports.backupDocument).toHaveBeenCalledTimes(0);
  });

  it("routes documents to the docs producer", async () => {
    const ports = fakePorts();
    await processShareIntent(ports, session, GATEWAY, {
      files: [file({ mimeType: "application/pdf", fileName: "doc.pdf" })],
    });
    expect(ports.backupDocument).toHaveBeenCalledWith(
      session,
      GATEWAY,
      expect.objectContaining({
        title: "doc.pdf",
        mediaType: "application/pdf",
        deleteSourceAfterSettle: true,
      })
    );
    expect(ports.backupDeviceMedia).toHaveBeenCalledTimes(0);
  });

  it("falls back to fileSize when the intent carries no size", async () => {
    const ports = fakePorts();
    await processShareIntent(ports, session, GATEWAY, {
      files: [file({ mimeType: "application/pdf", size: null })],
    });
    expect(ports.fileSize).toHaveBeenCalledWith("file:///share/x");
    expect(ports.backupDocument).toHaveBeenCalledWith(
      session,
      GATEWAY,
      expect.objectContaining({ plaintextSize: 1234 })
    );
  });
});

describe("processShareIntent lifecycle", () => {
  it("guards its file-only contract and resets when called without files", async () => {
    const ports = fakePorts();
    await processShareIntent(ports, session, GATEWAY, {
      files: [],
      text: "hello",
    });
    expect(ports.backupDeviceMedia).toHaveBeenCalledTimes(0);
    expect(ports.backupDocument).toHaveBeenCalledTimes(0);
    expect(ports.alert).toHaveBeenCalledExactlyOnceWith(
      "Can’t save this to Centraid",
      expect.any(String)
    );
    expect(ports.reset).toHaveBeenCalledOnce();
  });

  it("always resets — on success", async () => {
    const ports = fakePorts();
    await processShareIntent(ports, session, GATEWAY, {
      files: [file({ mimeType: "image/png" })],
    });
    expect(ports.reset).toHaveBeenCalledOnce();
  });

  it("always resets — and surfaces a paused alert on producer failure", async () => {
    const ports = fakePorts({
      backupDeviceMedia: vi.fn<ShareIngestPorts["backupDeviceMedia"]>(
        async () => {
          throw new Error("gateway unreachable");
        }
      ),
    });
    await processShareIntent(ports, session, GATEWAY, {
      files: [file({ mimeType: "image/png" })],
    });
    expect(ports.alert).toHaveBeenCalledWith(
      "Save to Centraid paused",
      "gateway unreachable"
    );
    expect(ports.reset).toHaveBeenCalledOnce();
  });
});

describe("staged share files", () => {
  it("deletes every staged copy the member declined (#880 W4.6)", () => {
    const deleted: string[] = [];
    discardShareIntentFiles((path) => deleted.push(path), {
      files: [
        file({ mimeType: "image/jpeg", path: "file:///group/a.jpg" }),
        file({ mimeType: "application/pdf", path: "file:///group/b.pdf" }),
      ],
    });
    expect(deleted).toStrictEqual([
      "file:///group/a.jpg",
      "file:///group/b.pdf",
    ]);
  });

  it("has nothing to delete for a text-only share", () => {
    const deleteStaged = vi.fn<(path: string) => void>();
    discardShareIntentFiles(deleteStaged, { files: [], text: "hello" });
    expect(deleteStaged).not.toHaveBeenCalled();
  });
});

describe(sweepStaleShareStaging, () => {
  const NOW = Date.parse("2026-08-27T12:00:00.000Z");

  function sweep(
    entries: readonly ShareStagingEntry[] | undefined
  ): readonly string[] {
    const deleted: string[] = [];
    sweepStaleShareStaging({
      stagedEntries: () => entries,
      deleteStaged: (uri) => deleted.push(uri),
      now: () => NOW,
    });
    return deleted;
  }

  function entry(
    uri: string,
    ageMs: number,
    isDirectory = false
  ): ShareStagingEntry {
    return { uri, isFile: !isDirectory, lastModifiedMs: NOW - ageMs };
  }

  it("removes stale staged copies and leaves fresh ones for the ingest", () => {
    expect(
      sweep([
        entry("file:///group/stale.jpg", SHARE_STAGING_STALE_MS + 1),
        entry("file:///group/fresh.jpg", SHARE_STAGING_STALE_MS - 1),
      ])
    ).toStrictEqual(["file:///group/stale.jpg"]);
  });

  it("never touches a directory — the app group carries more than staging", () => {
    expect(
      sweep([
        entry("file:///group/Library", SHARE_STAGING_STALE_MS * 30, true),
        entry("file:///group/stale.pdf", SHARE_STAGING_STALE_MS * 30),
      ])
    ).toStrictEqual(["file:///group/stale.pdf"]);
  });

  it("leaves an entry whose timestamp could not be read", () => {
    expect(
      sweep([{ uri: "file:///group/unknown.jpg", isFile: true }])
    ).toStrictEqual([]);
  });

  it("no-ops when the staging directory does not exist", () => {
    expect(sweep(undefined)).toStrictEqual([]);
  });

  it("stays bounded — one sweep never walks an unbounded container", () => {
    const stale = Array.from(
      { length: SHARE_STAGING_SWEEP_LIMIT + 20 },
      (_, i) => entry(`file:///group/${i}.jpg`, SHARE_STAGING_STALE_MS * 2)
    );
    expect(sweep(stale)).toHaveLength(SHARE_STAGING_SWEEP_LIMIT);
  });
});

describe(shareTargetChoices, () => {
  it("skips the chooser when one vault can be written", () => {
    expect(
      shareTargetChoices([
        { vaultId: "home", label: "Home", canWrite: true },
        { vaultId: "shared", label: "Shared", canWrite: false },
      ])
    ).toStrictEqual([]);
  });

  it("offers only the writable vaults when there is a real choice", () => {
    expect(
      shareTargetChoices([
        { vaultId: "home", label: "Home", canWrite: true },
        { vaultId: "work", label: "Work", canWrite: true },
        { vaultId: "shared", label: "Shared", canWrite: false },
      ])
    ).toStrictEqual([
      { vaultId: "home", label: "Home", canWrite: true },
      { vaultId: "work", label: "Work", canWrite: true },
    ]);
  });

  it("skips the chooser when nothing is writable", () => {
    expect(
      shareTargetChoices([
        { vaultId: "shared", label: "Shared", canWrite: false },
      ])
    ).toStrictEqual([]);
  });
});

describe(ShareIntentGate, () => {
  it("does not double-ingest while a pass is still in flight", async () => {
    const gate = new ShareIntentGate();
    let started = 0;
    let release!: () => void;
    const task = () => {
      started += 1;
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    };
    const first = gate.run(task);
    const second = gate.run(task); // in flight → must no-op
    release();
    await Promise.all([first, second]);
    expect(started).toBe(1);
  });

  it("runs again once the previous pass settled", async () => {
    const gate = new ShareIntentGate();
    const task = vi.fn<() => Promise<void>>(async () => {});
    await gate.run(task);
    await gate.run(task);
    expect(task).toHaveBeenCalledTimes(2);
  });
});
