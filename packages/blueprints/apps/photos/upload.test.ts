import { beforeEach, describe, expect, it, vi } from "vitest";

const stage = vi.hoisted(() => ({
  stageFileBytes: vi.fn<(file: File) => Promise<{ sha256: string }>>(),
  isPendingOffsite: vi.fn<() => boolean>(() => false),
  stageDerivative: vi.fn<() => Promise<void>>(async () => undefined),
}));

const outcomes = vi.hoisted(() => ({
  acts: [] as Array<{ action: string; input: Record<string, unknown> }>,
  notices: [] as string[],
  writeTarget: vi.fn<() => { disabled: false; scopeId: string; label: string }>(
    () => ({
      disabled: false,
      scopeId: "own-library",
      label: "Library",
    })
  ),
}));

vi.mock(
  import("@centraid/design/elements"),
  () =>
    ({
      isPendingOffsite: stage.isPendingOffsite,
      stageDerivative: stage.stageDerivative,
      stageFileBytes: stage.stageFileBytes,
    }) as never
);

vi.mock(
  import("./outcomes.ts"),
  () =>
    ({
      act: (action: string, input: Record<string, unknown> = {}) => {
        outcomes.acts.push({ action, input });
        return Promise.resolve({
          status: "executed",
          output: { asset_id: `asset-${outcomes.acts.length}`, deduped: 0 },
        });
      },
      narrate: () => false,
      notice: (text: string) => {
        outcomes.notices.push(text);
      },
      writeTarget: outcomes.writeTarget,
    }) as never
);

vi.mock(
  import("./dom.ts"),
  () =>
    ({
      $: () => document.createElement("button"),
    }) as never
);

vi.mock(
  import("./thumbhash.ts"),
  () =>
    ({
      thumbHashFromImage: () => null,
    }) as never
);

vi.mock(
  import("../_shared/video-frame.ts"),
  () =>
    ({
      captureVideoFrames: async () => null,
      VIDEO_POSTER_EDGE: 2048,
      VIDEO_THUMB_EDGE: 256,
    }) as never
);

const { filesFromDataTransfer } = await import("./import-drop.ts");
const { runUpload } = await import("./upload.ts");

function photo(name: string): File {
  return new File([name], name, { type: "image/jpeg" });
}

function transfer(input: { files?: File[]; itemFiles?: File[] }): DataTransfer {
  const files = input.files ?? [];
  const itemFiles = input.itemFiles ?? [];
  const list = {
    length: files.length,
    item: (index: number) => files[index] ?? null,
    *[Symbol.iterator]() {
      yield* files;
    },
  };
  const items = itemFiles.map((file) => ({
    kind: "file" as const,
    type: file.type,
    getAsFile: () => file,
  }));
  return {
    files: list as unknown as FileList,
    items: items as unknown as DataTransferItemList,
    types: ["Files"],
  } as unknown as DataTransfer;
}

describe("import drop completeness", () => {
  it("keeps a files-list drop complete when items is empty", async () => {
    const dropped = [photo("a.jpg"), photo("b.jpg")];
    const files = await filesFromDataTransfer(
      transfer({ files: dropped, itemFiles: [] })
    );
    expect(files.map((file) => file.name)).toStrictEqual(["a.jpg", "b.jpg"]);
  });

  it("collects every file a host placed on items when files is empty", async () => {
    const dropped = Array.from({ length: 96 }, (_, i) =>
      photo(`drop-${String(i).padStart(3, "0")}.jpg`)
    );
    const files = await filesFromDataTransfer(
      transfer({ files: [], itemFiles: dropped })
    );
    expect(files.map((file) => file.name)).toStrictEqual(
      dropped.map((file) => file.name)
    );
  });
});

describe("runUpload batch completeness", () => {
  beforeEach(() => {
    outcomes.acts.length = 0;
    outcomes.notices.length = 0;
    stage.stageFileBytes.mockReset();
    stage.stageFileBytes.mockImplementation(async (file) => ({
      sha256: `sha-${file.name}`,
    }));
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => {
        throw new Error("no decode in this suite");
      })
    );
  });

  it("claims every file in a 96-file drop, in selection order", async () => {
    const files = Array.from({ length: 96 }, (_, i) =>
      photo(`batch-${String(i).padStart(3, "0")}.jpg`)
    );
    const result = await runUpload(files, {
      refresh: async () => undefined,
      setUploading: () => undefined,
      wasTrashed: () => false,
    });
    expect(result).toStrictEqual({ added: 96, deduped: 0, restored: 0 });
    expect(outcomes.acts.map((call) => call.input.staged_sha)).toStrictEqual(
      files.map((file) => `sha-${file.name}`)
    );
  });

  it("a middle staging failure does not strand later files", async () => {
    stage.stageFileBytes.mockImplementation(async (file) => {
      if (file.name === "two.jpg") throw new Error("unreadable");
      return { sha256: `sha-${file.name}` };
    });
    const result = await runUpload(
      [photo("one.jpg"), photo("two.jpg"), photo("three.jpg")],
      {
        refresh: async () => undefined,
        setUploading: () => undefined,
        wasTrashed: () => false,
      }
    );
    expect(result.added).toBe(2);
    expect(outcomes.acts.map((call) => call.input.staged_sha)).toStrictEqual([
      "sha-one.jpg",
      "sha-three.jpg",
    ]);
  });
});
// @vitest-environment jsdom
