// @vitest-environment jsdom
// Pin / add-tag / attach in the editor must not empty a body the note query
// already answered (matrix `pin-empty-overwrite`, #864). The parent forgets
// the loaded body on every library re-read; the editor is the last place that
// still has the words, so a forgotten body must not become an empty write.
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, test } from "vitest";

import { Editor } from "./components/Editor.tsx";
import type { EditorProps } from "./components/Editor.tsx";
import type { Note } from "./types.ts";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const BODY = "The deposit clause moved to §4.";

function row(body?: string): Note {
  return {
    note_id: "n1",
    title: "Lease terms",
    pinned: 0,
    ...(body === undefined ? {} : { body }),
  };
}

function props(
  over: Partial<EditorProps> & Pick<EditorProps, "note" | "onEdit">
): EditorProps {
  return {
    body: over.body,
    onToggleCheck: () => undefined,
    onSendToTasks: () => undefined,
    onLink: () => undefined,
    onProbe: () => undefined,
    onAddTag: () => undefined,
    onRemoveTag: () => undefined,
    onAttach: () => undefined,
    onDetach: () => undefined,
    onOpenHistory: () => undefined,
    onDelete: () => undefined,
    onTogglePin: () => undefined,
    ...over,
  };
}

describe("in-editor writes keep the loaded body", () => {
  let reactRoot: ReturnType<typeof createRoot> | undefined;
  let host: HTMLDivElement | undefined;

  afterEach(() => {
    if (reactRoot) act(() => reactRoot?.unmount());
    reactRoot = undefined;
    host?.remove();
    host = undefined;
  });

  async function mount(next: EditorProps): Promise<HTMLDivElement> {
    if (!host) {
      host = document.createElement("div");
      document.body.append(host);
      reactRoot = createRoot(host);
    }
    await act(async () => {
      reactRoot?.render(createElement(Editor, next));
    });
    return host;
  }

  test("forgetting the body after Pin does not empty the field or write a blank", async () => {
    const edits: Array<{ title?: string; body_text?: string }> = [];
    const pins: number[] = [];
    const first = props({
      note: row(BODY),
      body: BODY,
      onEdit: (patch) => edits.push(patch),
      onTogglePin: () => pins.push(1),
    });
    const el = await mount(first);

    const pin = [...el.querySelectorAll("button")].find(
      (button) => button.textContent === "Pin"
    );
    expect(pin).toBeDefined();
    await act(async () => pin?.click());
    expect(pins).toStrictEqual([1]);

    await mount(
      props({
        note: row(),
        onEdit: (patch) => edits.push(patch),
        onTogglePin: () => pins.push(1),
      })
    );

    const area = el.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Note body"]'
    );
    expect(area?.value).toBe(BODY);
    expect(edits.filter((patch) => patch.body_text === "")).toStrictEqual([]);
  });

  test("forgetting the body after adding a tag does not empty the field", async () => {
    const tags: string[] = [];
    const el = await mount(
      props({
        note: row(BODY),
        body: BODY,
        onEdit: () => undefined,
        onAddTag: (label) => tags.push(label),
      })
    );

    const field = el.querySelector<HTMLInputElement>(
      'input[aria-label="Add a tag"]'
    );
    expect(field).not.toBeNull();
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set;
    await act(async () => {
      if (!field) return;
      setter?.call(field, "lease");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      field?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
      );
    });
    expect(tags).toStrictEqual(["lease"]);

    await mount(
      props({
        note: row(),
        onEdit: () => undefined,
        onAddTag: (label) => tags.push(label),
      })
    );
    expect(
      el.querySelector<HTMLTextAreaElement>('textarea[aria-label="Note body"]')
        ?.value
    ).toBe(BODY);
  });
});
