// *Share*, as ONE selection-bar handler (#825): what the four Photos shelves
// get for their third target.
//
// The claim: the control refuses BEFORE anything opens where the selection is
// not one subject, and where it is one, the sheet is opened over that
// photograph's own id — never over the selection key that carries it. Every
// outcome lands on the status line and then closes the selection.
// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ONE_AT_A_TIME } from "@centraid/blueprints/apps/photos/grant-audiences";

import type { VaultAsset } from "./photos-selection-writes";
import { usePhotoSelectionShare } from "./use-photo-selection-share";

// The grant entry has its own suite (`photo-grants.test.tsx`) — here it is a
// recorder, so this file's own two decisions are what is under test.
const entry = vi.hoisted(() => ({
  requested: 0,
  dismissed: 0,
  audiences: [
    { kind: "party", id: "party-asha", label: "Asha Rao" },
  ] as readonly unknown[],
  visible: false,
}));
vi.mock(
  import("./photo-grants"),
  () =>
    ({
      usePhotoGrantEntry: () => ({
        audiences: entry.audiences,
        visible: entry.visible,
        request: () => {
          entry.requested += 1;
        },
        dismiss: () => {
          entry.dismissed += 1;
        },
      }),
    }) as never
);

const posted = vi.hoisted(() => [] as string[]);
vi.mock(
  import("../../kit/components/status-line"),
  () => ({ postStatus: (message: string) => posted.push(message) }) as never
);

const asset = (assetId: string): VaultAsset =>
  ({ id: `row-${assetId}`, assetId }) as VaultAsset;

let root: ReturnType<typeof createRoot> | undefined;

function drive(
  selected: readonly VaultAsset[],
  onDone: () => void = () => undefined
): ReturnType<typeof usePhotoSelectionShare> {
  const container = document.createElement("div");
  document.body.append(container);
  const seen: ReturnType<typeof usePhotoSelectionShare>[] = [];
  const Probe = (): null => {
    seen.push(usePhotoSelectionShare(() => selected, onDone));
    return null;
  };
  act(() => {
    root = createRoot(container);
    root.render(React.createElement(Probe));
  });
  return seen[seen.length - 1]!;
}

describe("Photos' selection-bar Share", () => {
  beforeEach(() => {
    entry.requested = 0;
    entry.dismissed = 0;
    entry.visible = false;
    posted.length = 0;
  });

  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = undefined;
    document.body.replaceChildren();
  });

  it("opens the sheet over the one photograph selected", () => {
    const share = drive([asset("asset-1")]);
    expect(share.copyLabel).toBe("Share");
    expect(share.handler).toStrictEqual({ run: expect.any(Function) });
    if ("run" in share.handler) share.handler.run();
    expect(entry.requested).toBe(1);
    expect(share.sheetProps.subject).toStrictEqual({
      subjectType: "media.asset",
      subjectId: "asset-1",
    });
  });

  it("refuses a selection of many with the sentence that names the album", () => {
    const share = drive([asset("asset-1"), asset("asset-2")]);
    expect(share.handler).toStrictEqual({ unavailableReason: ONE_AT_A_TIME });
    // Refused BEFORE anything opens: the roster is never even asked for.
    expect(entry.requested).toBe(0);
    expect(ONE_AT_A_TIME).toContain("album");
  });

  it("refuses an empty selection too — there is no subject to stand over", () => {
    const share = drive([]);
    expect(share.handler).toStrictEqual({ unavailableReason: ONE_AT_A_TIME });
    expect(entry.requested).toBe(0);
  });

  it("posts the sheet's outcome on the status line, then closes the selection", () => {
    let done = 0;
    const share = drive([asset("asset-1")], () => {
      done += 1;
    });
    share.sheetProps.onStatus("Asha Rao can view it");
    expect(posted).toStrictEqual(["Asha Rao can view it"]);
    expect(done).toBe(1);
  });

  it("hands the sheet the roster the entry read, and its own visibility", () => {
    entry.visible = true;
    const share = drive([asset("asset-1")]);
    expect(share.visible).toBe(true);
    expect(share.sheetProps.audiences).toBe(entry.audiences);
    share.dismiss();
    expect(entry.dismissed).toBe(1);
  });
});
