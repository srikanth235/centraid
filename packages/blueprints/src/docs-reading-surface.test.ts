import path from "node:path";
import { pathToFileURL } from "node:url";

import { act, createElement } from "react";
import type { ComponentType } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

const QUICK_LOOK_TEXT = pathToFileURL(
  path.resolve(import.meta.dirname, "../apps/docs/components/QuickLookText.tsx")
).href;

const DOC_TITLE = "lease-notes.txt";
const DOC_BODY =
  "Lease renewal notes: the deposit clause moved to §4.\n\nKeep the signed copy with the 2026 tax folder.";

describe("Docs reading sheet", () => {
  let root: ReturnType<typeof createRoot> | null = null;
  let container: HTMLElement | null = null;

  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = null;
    container = null;
    document.body.replaceChildren();
  });

  it("paints the document title and both body paragraphs on an article named for the file", async () => {
    const { QuickLookText } = (await import(QUICK_LOOK_TEXT)) as {
      QuickLookText: ComponentType<{
        doc: {
          document_id: string;
          content_id: string;
          title: string;
          media_type: string;
          byte_size: number;
          content_uri: string;
          poster_uri: null;
          created_at: string;
          updated_at: string;
          folder_id: null;
          starred: boolean;
          trashed: boolean;
          purge_at: null;
          tags: [];
          custody_state: string;
        };
      }>;
    };
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        createElement(QuickLookText, {
          doc: {
            document_id: "lease-notes",
            content_id: "lease-notes-bytes",
            title: DOC_TITLE,
            media_type: "text/plain",
            byte_size: Buffer.byteLength(DOC_BODY, "utf8"),
            content_uri: `data:text/plain;charset=utf-8,${encodeURIComponent(DOC_BODY)}`,
            poster_uri: null,
            created_at: "2026-08-18T00:00:00.000Z",
            updated_at: "2026-08-18T00:00:00.000Z",
            folder_id: null,
            starred: false,
            trashed: false,
            purge_at: null,
            tags: [],
            custody_state: "replicated",
          },
        })
      );
    });

    const article = container.querySelector("article");
    expect(article).not.toBeNull();
    expect(article?.getAttribute("aria-labelledby")).toBe(
      "docs-read-lease-notes"
    );
    const heading = article?.querySelector("h1");
    expect(heading?.id).toBe("docs-read-lease-notes");
    expect(heading?.textContent).toBe(DOC_TITLE);
    const paragraphs = [...(article?.querySelectorAll("p") ?? [])].map(
      (node) => node.textContent
    );
    expect(paragraphs).toContain(DOC_BODY.split("\n\n")[0]);
    expect(paragraphs).toContain(DOC_BODY.split("\n\n")[1]);
  });
});
// @vitest-environment jsdom
