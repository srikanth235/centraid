// @vitest-environment jsdom
// The attach flow's SHAPE — the inline/stage threshold, the batch ordering,
// the custody notice. The transport it delegates to lives in the shell
// (packages/client blob-staging.ts) and is exercised there; here the host is a
// spy, which is exactly the boundary this layer is allowed to know about.
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  INLINE_ATTACH_BYTES,
  isPendingOffsite,
  stageDerivative,
  stageFileBytes,
  wireAttachInput,
} from "./attachments.js";
import type { CentraidHost, StagedBlob } from "./host.js";

type AttachHandlers = Parameters<typeof wireAttachInput>[2];

function installHost(host: CentraidHost): void {
  (globalThis as { centraid?: CentraidHost }).centraid = host;
}

function fileInput(): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "file";
  return input;
}

function setFiles(input: HTMLInputElement, files: File[]): void {
  Object.defineProperty(input, "files", { configurable: true, value: files });
}

/**
 * A `refresh` handler that is a real synchronization primitive rather than a
 * spy: `wireAttachInput` calls it once, last, when the batch is done, so
 * awaiting it is the honest way to know the flow finished. A test that wants
 * to assert refresh RAN passes a mock instead — that is a contract, this is a
 * barrier, and conflating the two is how a suite starts asserting that its own
 * mocks were called.
 */
function refreshBarrier(): { refresh: () => void; settled: Promise<void> } {
  let done!: () => void;
  const settled = new Promise<void>((resolve) => {
    done = resolve;
  });
  return { refresh: done, settled };
}

describe("attachments", () => {
  beforeEach(() => {
    delete (globalThis as { centraid?: CentraidHost }).centraid;
  });

  it("stageFileBytes forwards the whole call to the host's blob door", async () => {
    const receipt: StagedBlob = { sha256: "deadbeef" };
    const stageBlob = vi.fn<NonNullable<CentraidHost["stageBlob"]>>(
      async () => receipt
    );
    installHost({ stageBlob });
    const file = new File(["hello"], "note.txt", { type: "text/plain" });

    await expect(
      stageFileBytes(file, "&kind=cover", { hash: false, scope: "v2" })
    ).resolves.toBe(receipt);
    expect(stageBlob).toHaveBeenCalledWith(file, "&kind=cover", {
      hash: false,
      scope: "v2",
    });
  });

  it("refuses to stage on a host with no blob door rather than failing silently", async () => {
    installHost({});
    const file = new File(["hello"], "note.txt", { type: "text/plain" });
    await expect(stageFileBytes(file)).rejects.toThrow(
      "This host cannot stage vault bytes."
    );
    await expect(
      stageDerivative("parent", "thumb", new Blob([]))
    ).rejects.toThrow("This host cannot stage vault bytes.");
  });

  it("stageDerivative defaults the media type of a variant contribution", async () => {
    const stageDerivativeSpy = vi.fn<
      NonNullable<CentraidHost["stageDerivative"]>
    >(async () => ({ sha256: "thumb" }));
    installHost({ stageDerivative: stageDerivativeSpy });
    const body = new Blob([new Uint8Array(4)]);

    await stageDerivative("parent-sha", "thumb", body);

    expect(stageDerivativeSpy).toHaveBeenCalledWith(
      "parent-sha",
      "thumb",
      body,
      "application/octet-stream"
    );
  });

  it("only strict provider custody clears the offsite-pending flag", () => {
    expect(isPendingOffsite({ sha256: "s", casAck: "replicated" })).toBe(true);
    expect(
      isPendingOffsite({
        sha256: "s",
        casAck: "replicated",
        custody: "remote-only",
      })
    ).toBe(false);
    expect(isPendingOffsite(undefined)).toBe(false);
  });

  it("inlines a small file as a data: URI through the app action (no upload)", async () => {
    const stageBlob = vi.fn<NonNullable<CentraidHost["stageBlob"]>>(
      async () => ({ sha256: "unused" })
    );
    installHost({ stageBlob });
    const input = fileInput();
    const act = vi.fn<AttachHandlers["act"]>(async () => ({
      status: "executed" as const,
    }));
    const refresh = vi.fn<NonNullable<AttachHandlers["refresh"]>>();
    wireAttachInput(input, () => "note-1", {
      act,
      narrate: () => true,
      refresh,
    });

    setFiles(input, [new File(["tiny"], "tiny.txt", { type: "text/plain" })]);
    input.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledWith());

    expect(stageBlob).not.toHaveBeenCalled();
    expect(act).toHaveBeenCalledOnce();
    const [action, payload] = act.mock.calls[0]!;
    expect(action).toBe("attach");
    expect(payload.subject_id).toBe("note-1");
    expect(String(payload.data_uri)).toContain("data:text/plain");
  });

  it("stages a file over the inline threshold, then attaches by sha", async () => {
    const stageBlob = vi.fn<NonNullable<CentraidHost["stageBlob"]>>(
      async () => ({
        sha256: "big-sha",
        casAck: "replicated",
      })
    );
    installHost({ stageBlob });
    const input = fileInput();
    const act = vi.fn<AttachHandlers["act"]>(async () => ({
      status: "executed" as const,
    }));
    const notice = vi.fn<NonNullable<AttachHandlers["notice"]>>();
    const { refresh, settled } = refreshBarrier();
    wireAttachInput(input, () => "note-2", {
      act,
      narrate: () => true,
      notice,
      refresh,
    });

    const big = new File([new Uint8Array(INLINE_ATTACH_BYTES + 1)], "big.bin", {
      type: "application/octet-stream",
    });
    setFiles(input, [big]);
    input.dispatchEvent(new Event("change"));
    await settled;

    expect(stageBlob).toHaveBeenCalledOnce();
    const [action, payload] = act.mock.calls[0]!;
    expect(action).toBe("attach");
    expect(payload.subject_id).toBe("note-2");
    expect(payload.staged_sha).toBe("big-sha");
    expect(payload.data_uri).toBeUndefined();
    // Staged but not yet in provider custody — the owner is told so.
    expect(notice).toHaveBeenCalledWith(
      "Attached locally · waiting for offsite custody."
    );
  });

  it("stops the batch at the first outcome the app declines to narrate", async () => {
    installHost({});
    const input = fileInput();
    const act = vi.fn<AttachHandlers["act"]>(async () => ({
      status: "denied" as const,
    }));
    const { refresh, settled } = refreshBarrier();
    wireAttachInput(input, () => "note-3", {
      act,
      narrate: () => false,
      refresh,
    });

    setFiles(input, [
      new File(["a"], "a.txt", { type: "text/plain" }),
      new File(["b"], "b.txt", { type: "text/plain" }),
    ]);
    input.dispatchEvent(new Event("change"));
    await settled;

    expect(act).toHaveBeenCalledOnce();
  });

  it("does nothing when there is no attach subject", async () => {
    const input = fileInput();
    const act = vi.fn<AttachHandlers["act"]>(async () => undefined);
    wireAttachInput(input, () => null, { act, narrate: () => true });
    setFiles(input, [new File(["x"], "x.txt", { type: "text/plain" })]);
    input.dispatchEvent(new Event("change"));
    await Promise.resolve();
    expect(act).not.toHaveBeenCalled();
  });
});
