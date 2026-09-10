// One channel, one painter (#1015, S3 — audit B5). Every editor on this seat
// is an iOS `Modal`, which renders above the app root, so a note posted from
// inside one painted underneath it and was never seen. The fix is a host
// stack: the topmost claim paints and every other mounted host stays quiet.
// @vitest-environment jsdom
import React, { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { postStatus, resetStatus } from "@centraid/client/status-channel";

import { mountBlock, nodesOf } from "../../test/react-native-stub";
import { claimStatusHost, resetStatusHosts } from "./status-host";
import StatusLine from "./StatusLine";
import StatusLineHost from "./StatusLineHost";

vi.mock(import("react-native"), async () => {
  const stub = await import("../../test/react-native-stub");
  return stub.reactNativeStub() as unknown as typeof import("react-native");
});
vi.mock(import("react-native-safe-area-context"), () => ({
  useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }),
}));

let dispose: (() => void) | undefined;

function render(node: React.ReactNode): HTMLElement {
  const mounted = mountBlock(node);
  dispose = mounted.unmount;
  return mounted.container;
}

const textOf = (container: HTMLElement): string[] =>
  nodesOf(container, "span").map((node) => node.textContent ?? "");

describe(StatusLine, () => {
  afterEach(() => {
    dispose?.();
    dispose = undefined;
    resetStatus();
    resetStatusHosts();
  });

  it("is quiet until a note is posted", () => {
    const container = render(<StatusLine />);
    expect(textOf(container)).toStrictEqual([]);
  });

  it("paints at the root when no presentation holds the line", () => {
    postStatus("Photo deleted");
    const container = render(<StatusLine />);
    expect(textOf(container)).toContain("Photo deleted");
  });

  it("goes quiet at the root while a presentation holds the line", () => {
    postStatus("Note saved");
    claimStatusHost("editor");
    const container = render(<StatusLine />);
    expect(textOf(container)).toStrictEqual([]);
  });

  it("paints inside the presentation that hosts it", () => {
    postStatus("Note saved");
    const container = render(<StatusLineHost name="note-editor" />);
    expect(textOf(container)).toContain("Note saved");
  });

  it("hands the line back to the root when the presentation closes", () => {
    postStatus("Note saved");
    const root = render(<StatusLine />);
    let release = (): void => undefined;
    act(() => {
      release = claimStatusHost("editor");
    });
    expect(textOf(root)).toStrictEqual([]);
    act(() => release());
    expect(textOf(root)).toContain("Note saved");
  });
});
