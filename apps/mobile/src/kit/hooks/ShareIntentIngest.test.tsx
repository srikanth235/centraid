// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  SHARE_STAGING_STALE_MS,
  SHARE_UNPAIRED_MESSAGE,
  SHARE_UNPAIRED_TITLE,
} from "./share-ingest";
import { ShareIntentIngest } from "./ShareIntentIngest";

type ExpoFileSystem = typeof import("expo-file-system");
type ExpoLinking = typeof import("expo-linking");
type ExpoShareIntent = typeof import("expo-share-intent");
type MediaProducer = typeof import("../../lib/upload/media-producer");
type OptionSheetModule = typeof import("../components/OptionSheet");
type ReactNative = typeof import("react-native");
type ReplicaModule = typeof import("../replica/ReplicaProvider");
type StatusLineModule = typeof import("../components/status-line");

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

interface AlertButton {
  text?: string;
  onPress?: () => void;
}

interface SheetOptionLike {
  id: string;
  label: string;
  detail?: string;
}

interface SheetPropsLike {
  visible: boolean;
  title: string;
  options: SheetOptionLike[];
  selectedId?: string;
  onSelect: (id: string) => void;
  onClose: () => void;
}

const state = vi.hoisted(() => ({
  containerExists: true,
  entries: [] as Array<{
    uri: string;
    directory: boolean;
    lastModified: number | null;
  }>,
  present: new Set<string>(),
  deleted: [] as string[],
  alerts: [] as Array<{
    title: string;
    message?: string;
    buttons?: AlertButton[];
  }>,
  sheet: undefined as SheetPropsLike | undefined,
}));

vi.mock(import("expo-file-system"), () => {
  class MockFile {
    readonly uri: string;
    readonly lastModified: number | null;
    readonly size = 128;
    constructor(uri: string, lastModified: number | null = null) {
      this.uri = uri;
      this.lastModified = lastModified;
    }
    get exists(): boolean {
      return state.present.has(this.uri);
    }
    delete(): void {
      state.present.delete(this.uri);
      state.deleted.push(this.uri);
    }
  }
  const container = {
    uri: "file:///group",
    get exists(): boolean {
      return state.containerExists;
    },
    list: (): unknown[] =>
      state.entries.map((entry) =>
        entry.directory
          ? { uri: entry.uri }
          : new MockFile(entry.uri, entry.lastModified)
      ),
  };
  return {
    File: MockFile,
    Paths: {
      appleSharedContainers: { "group.dev.centraid.mobile": container },
    },
  } as unknown as ExpoFileSystem;
});

const linking = vi.hoisted(() => ({ urls: [] as string[] }));
vi.mock(
  import("expo-linking"),
  () =>
    ({
      openURL: async (url: string) => {
        linking.urls.push(url);
        return true;
      },
    }) as unknown as ExpoLinking
);

const share = vi.hoisted(() => ({
  hasShareIntent: true,
  shareIntent: {} as Record<string, unknown>,
  resets: 0,
}));
vi.mock(
  import("expo-share-intent"),
  () =>
    ({
      useShareIntentContext: () => ({
        hasShareIntent: share.hasShareIntent,
        shareIntent: share.shareIntent,
        resetShareIntent: () => {
          share.resets += 1;
        },
      }),
    }) as unknown as ExpoShareIntent
);

const replica = vi.hoisted(() => ({
  value: {} as Record<string, unknown>,
}));
vi.mock(
  import("../replica/ReplicaProvider"),
  () => ({ useReplica: () => replica.value }) as unknown as ReplicaModule
);

const producer = vi.hoisted(() => ({
  media: [] as Array<{
    gatewayBase: string;
    localUri: string;
    targetVaultId?: string;
  }>,
}));
vi.mock(
  import("../../lib/upload/media-producer"),
  () =>
    ({
      backupDeviceMedia: async (
        _session: unknown,
        gatewayBase: string,
        input: { localUri: string; targetVaultId?: string }
      ) => {
        producer.media.push({
          gatewayBase,
          localUri: input.localUri,
          ...(input.targetVaultId
            ? { targetVaultId: input.targetVaultId }
            : {}),
        });
        return "sha-media";
      },
      backupDocument: async () => "sha-doc",
    }) as unknown as MediaProducer
);

vi.mock(
  import("../components/status-line"),
  () => ({ postStatus: () => undefined }) as unknown as StatusLineModule
);

vi.mock(import("react-native"), () => {
  const alert = (
    title: string,
    message?: string,
    buttons?: AlertButton[]
  ): void => {
    state.alerts.push({
      title,
      ...(message ? { message } : {}),
      ...(buttons ? { buttons } : {}),
    });
  };
  return { Alert: { alert } } as unknown as ReactNative;
});

vi.mock(import("../components/OptionSheet"), async () => {
  const ReactModule = await import("react");
  return {
    default: (props: SheetPropsLike) => {
      state.sheet = props;
      return ReactModule.createElement("div", {
        "data-visible": String(props.visible),
      });
    },
  } as unknown as OptionSheetModule;
});

const PHOTO = "file:///group/shared.jpg";
const GATEWAY = "http://127.0.0.1:8787";

let root: Root | undefined;
let container: HTMLDivElement | undefined;

function mediaShare(): Record<string, unknown> {
  return {
    files: [
      {
        path: PHOTO,
        mimeType: "image/jpeg",
        fileName: "shared.jpg",
        size: 128,
      },
    ],
  };
}

function render(): void {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(React.createElement(ShareIntentIngest));
  });
}

function alertNamed(title: string): { buttons?: AlertButton[] } | undefined {
  return state.alerts.find((entry) => entry.title === title);
}

function press(title: string, label: string): void {
  const button = alertNamed(title)?.buttons?.find(
    (entry) => entry.text === label
  );
  expect(button, `${label} button`).toBeDefined();
  act(() => button?.onPress?.());
}

describe(ShareIntentIngest, () => {
  beforeEach(() => {
    state.containerExists = true;
    state.entries = [];
    state.present = new Set([PHOTO]);
    state.deleted = [];
    state.alerts = [];
    state.sheet = undefined;
    share.hasShareIntent = true;
    share.shareIntent = mediaShare();
    share.resets = 0;
    linking.urls = [];
    producer.media = [];
    replica.value = {
      ready: true,
      session: { id: "session" },
      gatewayBase: GATEWAY,
      vaultId: "home",
      scopes: [{ vaultId: "home", label: "Home", canWrite: true }],
    };
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
  });

  describe("ShareIntentIngest cancellation", () => {
    it("deletes the staged copies when the member cancels the review", () => {
      render();
      press("Review shared items", "Cancel");
      expect(state.deleted).toStrictEqual([PHOTO]);
      expect(share.resets).toBe(1);
    });

    it("deletes the staged copies when the vault chooser is abandoned", async () => {
      replica.value = {
        ...replica.value,
        scopes: [
          { vaultId: "home", label: "Home", canWrite: true },
          { vaultId: "work", label: "Work", canWrite: true },
        ],
      };
      render();
      press("Review shared items", "Save");
      await act(async () => state.sheet?.onClose());
      expect(state.deleted).toStrictEqual([PHOTO]);
      expect(share.resets).toBe(1);
      expect(producer.media).toStrictEqual([]);
    });
  });

  describe("ShareIntentIngest without a mounted vault", () => {
    it("tells the member, cleans up and resets instead of leaving files pending", () => {
      replica.value = { ready: true, scopes: [] };
      render();
      expect(state.alerts).toStrictEqual([
        { title: SHARE_UNPAIRED_TITLE, message: SHARE_UNPAIRED_MESSAGE },
      ]);
      expect(state.deleted).toStrictEqual([PHOTO]);
      expect(share.resets).toBe(1);
    });

    it("stops a text share on the same terms rather than opening Quick capture", () => {
      replica.value = { ready: true, scopes: [] };
      share.shareIntent = { files: [], text: "a thought" };
      render();
      expect(alertNamed(SHARE_UNPAIRED_TITLE)).toBeDefined();
      expect(linking.urls).toStrictEqual([]);
      expect(share.resets).toBe(1);
    });

    it("stays silent while the replica is still mounting — that is not unpaired", () => {
      replica.value = { ready: false, scopes: [] };
      render();
      expect(state.alerts).toStrictEqual([]);
      expect(state.deleted).toStrictEqual([]);
      expect(share.resets).toBe(0);
    });
  });

  describe("ShareIntentIngest target vault", () => {
    it("saves straight to the focused vault when only one can be written", async () => {
      render();
      await act(async () => press("Review shared items", "Save"));
      expect(state.sheet?.visible).toBe(false);
      expect(producer.media).toStrictEqual([
        { gatewayBase: GATEWAY, localUri: PHOTO, targetVaultId: "home" },
      ]);
    });

    it("asks which vault when more than one can be written, focused preselected", async () => {
      replica.value = {
        ...replica.value,
        scopes: [
          { vaultId: "home", label: "Home", canWrite: true },
          { vaultId: "work", label: "Work", canWrite: true },
          { vaultId: "shared", label: "Shared", canWrite: false },
        ],
      };
      render();
      press("Review shared items", "Save");
      expect(producer.media).toStrictEqual([]);
      expect(state.sheet?.visible).toBe(true);
      expect(state.sheet?.selectedId).toBe("home");
      expect(state.sheet?.options.map((option) => option.id)).toStrictEqual([
        "home",
        "work",
      ]);
      await act(async () => state.sheet?.onSelect("work"));
      expect(producer.media).toStrictEqual([
        { gatewayBase: GATEWAY, localUri: PHOTO, targetVaultId: "work" },
      ]);
      expect(state.deleted).toStrictEqual([]);
    });
  });

  describe("ShareIntentIngest start-up sweep", () => {
    it("collects staged copies a crash orphaned and spares the fresh ones", () => {
      const now = Date.now();
      share.hasShareIntent = false;
      state.present = new Set([
        "file:///group/orphan.pdf",
        "file:///group/pending.jpg",
      ]);
      state.entries = [
        {
          uri: "file:///group/orphan.pdf",
          directory: false,
          lastModified: now - SHARE_STAGING_STALE_MS - 1,
        },
        {
          uri: "file:///group/pending.jpg",
          directory: false,
          lastModified: now - 1_000,
        },
        { uri: "file:///group/Library", directory: true, lastModified: 0 },
      ];
      render();
      expect(state.deleted).toStrictEqual(["file:///group/orphan.pdf"]);
    });

    it("no-ops when the app group has no staging directory", () => {
      share.hasShareIntent = false;
      state.containerExists = false;
      render();
      expect(state.deleted).toStrictEqual([]);
    });
  });
});
