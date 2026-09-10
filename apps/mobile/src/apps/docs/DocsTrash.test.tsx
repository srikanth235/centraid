// Emptying the Docs trash on the phone (#1015 D1, audit docs/findings#7).
//
// The shelf used to print an ask — "Delete forever and Empty trash, not
// available yet" — while Photos shipped both verbs. `core.empty_document_trash`
// closed that, and this pins the phone's half of the answer:
//
//  - the control carries the NOUN and the count, so nobody presses a bare verb;
//  - pressing it writes NOTHING: it opens the confirm, and only the confirm
//    reaches the write door;
//  - the confirm is a sheet (D4), never an `Alert`;
//  - an empty trash offers no verb at all.
// @vitest-environment jsdom
import React, { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EMPTY_TRASH_COPY } from "@centraid/blueprints/apps/docs/drive-copy";

import { mountBlock, nodesOf } from "../../test/react-native-stub";
import DocsTrash from "./DocsTrash";

vi.mock(import("react-native"), async () => {
  const stub = await import("../../test/react-native-stub");
  return stub.reactNativeStub() as unknown as typeof import("react-native");
});
vi.mock(import("@react-native-async-storage/async-storage"), async () => {
  const stub = await import("../../test/react-native-stub");
  return stub.asyncStorageStub() as unknown as {
    default: typeof import("@react-native-async-storage/async-storage").default;
  };
});
vi.mock(import("react-native-svg"), async () => {
  const stub = await import("../../test/react-native-stub");
  return stub.svgStub() as unknown as typeof import("react-native-svg");
});
vi.mock(
  import("@react-navigation/native"),
  () =>
    ({
      useNavigation: () => ({ navigate: vi.fn<() => void>() }),
    }) as never
);
// The shell, the head, the list and the replica bar are other files' claims.
vi.mock(import("./DocsScreen"), () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock(import("./DocsShelfHeader"), () => ({ default: () => <></> }));
vi.mock(import("./DriveList"), () => ({ default: () => <></> }));
vi.mock(import("../../kit/replica/ReplicaStatusBar"), () => ({
  default: () => <></>,
}));

const posted: string[] = [];
vi.mock(import("../../kit/components/status-line"), () => ({
  postStatus: (message: string) => {
    posted.push(message);
  },
}));

// The sheet is the kit's; what matters here is WHAT was offered and that
// choosing it is the only thing that writes.
interface SheetProps {
  visible: boolean;
  title: string;
  options: { id: string; label: string; detail?: string }[];
  onSelect: (id: string) => void;
}
const sheets: SheetProps[] = [];
vi.mock(import("../../kit/components/OptionSheet"), () => ({
  default: (props: SheetProps) => {
    sheets.push(props);
    return <></>;
  },
}));

const writes: [string, Record<string, unknown>][] = [];
const trashed = vi.hoisted(() => ({ count: 0 }));
vi.mock(
  import("./useDocs"),
  () =>
    ({
      useDocs: () => ({
        documents: Array.from({ length: trashed.count }, (_, index) => ({
          document_id: `doc-${index}`,
          trashed: true,
        })),
        folders: [],
        loading: false,
        connection: "current",
        offline: false,
        refresh: async () => undefined,
      }),
      useDocsWrite:
        () => async (action: string, input: Record<string, unknown>) => {
          writes.push([action, input]);
          return { status: "executed" };
        },
    }) as never
);

let dispose: (() => void) | undefined;
function render(count: number): HTMLElement {
  trashed.count = count;
  const mounted = mountBlock(<DocsTrash />);
  dispose = mounted.unmount;
  return mounted.container;
}

/** A press, flushed — the stub's `Pressable` is a plain `<button>`. */
function press(node: HTMLElement | undefined): void {
  act(() => {
    node?.click();
  });
}

function emptyTrashButton(container: HTMLElement): HTMLElement | undefined {
  return nodesOf(container, "button").find((node) =>
    (node.textContent ?? "").startsWith(EMPTY_TRASH_COPY.control)
  );
}

describe("the Docs trash shelf", () => {
  afterEach(() => {
    dispose?.();
    dispose = undefined;
    sheets.length = 0;
    writes.length = 0;
    posted.length = 0;
  });

  it("names the documents on the control, and writes nothing until the confirm", () => {
    const container = render(3);

    const control = emptyTrashButton(container);
    expect(control?.textContent).toBe("Empty trash — 3 documents");

    press(control);
    // The press OPENED something; it did not delete anything.
    expect(writes).toStrictEqual([]);
    const sheet = sheets.at(-1)!;
    expect(sheet.visible).toBe(true);
    expect(sheet.title).toBe("Delete 3 documents forever?");
    expect(sheet.options.map((option) => option.label)).toStrictEqual([
      "Delete 3 forever",
    ]);
    expect(sheet.options[0]!.detail).toContain("cannot be undone");
  });

  it("empties the whole trash in ONE write when the confirm is chosen, and says so", async () => {
    const container = render(12);

    press(emptyTrashButton(container));
    act(() => {
      sheets.at(-1)!.onSelect("empty");
    });

    // One command for the shelf — never one purge per row.
    expect(writes).toStrictEqual([["empty-trash", {}]]);
    // The status sentence lands after the write door answers.
    await act(async () => undefined);
    expect(posted).toStrictEqual(["Trash emptied — 12 documents · receipted."]);
  });

  it("offers no verb when there is nothing to empty", () => {
    const container = render(0);

    expect(emptyTrashButton(container)).toBeUndefined();
  });
});
