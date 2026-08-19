/* oxlint-disable typescript-eslint/ban-ts-comment -- app components are browser
   modules; this node-side suite intentionally runs them under jsdom. */
/* oxlint-disable no-script-url -- the adversarial URL assertion must name the
   executable scheme it proves the shared allowlist rejects. */
// @ts-nocheck
// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  displayText,
  safeBackgroundImage,
  safeDocumentUrl,
  safeExternalUrl,
  safeMediaUrl,
} from "../apps/_shared/untrusted.ts";
import { EventDrawer } from "../apps/agenda/components/EventDrawer.tsx";
import { ListRow as DocsRow } from "../apps/docs/components/List.tsx";
import { LockerList } from "../apps/locker/components/List.tsx";
import { Card as NoteCard } from "../apps/notes/components/Card.tsx";
import { Row as PeopleRow } from "../apps/people/components/Shared.tsx";
import { MemoriesStrip } from "../apps/photos/components/Memories.tsx";
import { ExpenseRow } from "../apps/tally/components/ExpenseRow.tsx";
import { Row as TaskRow } from "../apps/tasks/components/Row.tsx";

const VECTORS = [
  "<script>globalThis.pwned=true</script>",
  '<img src=x onerror="globalThis.pwned=true">',
  '<svg onload="globalThis.pwned=true"></svg>',
  '<a href="javascript:alert(1)">click</a>',
  "<iframe srcdoc='<script>alert(1)</script>'></iframe>",
  "</textarea><script>alert(1)</script>",
  '<style>body{display:none}</style><b id="owned">x</b>',
  "<template><img src=x onerror=alert(1)></template>",
  "&lt;img src=x onerror=alert(1)&gt;",
  '"><input autofocus onfocus=alert(1)>',
  "java\tscript:alert(1)",
  "\u202Etxt.exe\u202C<img src=x onerror=alert(1)>",
  "\u0000\u001B[31m<script>alert(1)</script>",
] as const;

type Renderer = (value: string) => string;

const noop = () => undefined;
const asyncNoop = async () => undefined;

const RENDERERS: Record<string, Renderer> = {
  agenda: (value) =>
    renderToStaticMarkup(
      createElement(EventDrawer, {
        event: {
          event_id: "event-1",
          summary: value,
          description: value,
          status: "confirmed",
          dtstart: "2026-07-29T09:00:00Z",
          dtend: "2026-07-29T10:00:00Z",
        },
        calendarName: value,
        color: null,
        pending: false,
        pendingCancel: false,
        activity: [],
        onClose: noop,
        onReschedule: asyncNoop,
        onRsvp: noop,
        onAttach: noop,
        onRemoveAttachment: asyncNoop,
        onCancel: noop,
      })
    ),
  docs: (value) =>
    renderToStaticMarkup(
      createElement(DocsRow, {
        doc: {
          document_id: "doc-1",
          content_id: "content-1",
          title: value,
          media_type: "text/plain",
          byte_size: 4,
          poster_uri: null,
          created_at: "2026-07-29T09:00:00Z",
          updated_at: "2026-07-29T09:00:00Z",
          folder_id: null,
          starred: false,
          trashed: false,
          purge_at: null,
          tags: [],
          custody_state: "replicated",
        },
        index: 0,
        selectedIds: new Set(),
        // Selection is a mode, and the owner disc is member-supplied text on
        // the row - both are fed the vector rather than stubbed away, since a
        // display name is exactly the kind of string that reaches the DOM
        // without ever having been typed by the member reading it.
        selecting: true,
        owner: { name: value, initial: value },
        narrow: false,
        search: "",
        trashed: false,
        offline: false,
        folderName: () => value,
        onOpenDetails: noop,
        onOpenQuick: noop,
        onToggleSelect: noop,
        onOpenMenu: noop,
        onRestore: noop,
      })
    ),
  locker: (value) =>
    renderToStaticMarkup(
      createElement(LockerList, {
        pool: [
          {
            item_id: "item-1",
            type: "login",
            title: value,
            subtitle: value,
          },
        ],
        listTitle: "All items",
        allCount: 1,
        search: "",
        selectedId: null,
        onOpenSide: noop,
        onSelect: noop,
        onSearchInput: noop,
        onClearSearch: noop,
      })
    ),
  notes: (value) =>
    renderToStaticMarkup(
      createElement(NoteCard, {
        note: {
          note_id: "note-1",
          title: value,
          preview: value,
          pinned: 0,
          updated_at: "2026-07-29T09:00:00Z",
        },
        search: "",
        pending: false,
        onOpen: noop,
        onTogglePin: noop,
      })
    ),
  // ONE row draws the whole of People — the roster, Search, Touch's three
  // lists, Trash and Merge all render this component (apps/people/components/
  // Shared.tsx), so covering it covers every list the app has. Each of its
  // three text slots is fed the vector, plus the avatar's own name path: a
  // display name reaches both the monogram and the row's accessible label
  // without ever having been typed by the member reading it.
  people: (value) =>
    renderToStaticMarkup(
      createElement(PeopleRow, {
        avatar: { party_id: "party-1", name: value, avatar_color: null },
        name: value,
        sub: value,
        meta: value,
        onOpen: noop,
      })
    ),
  photos: (value) =>
    renderToStaticMarkup(
      createElement(MemoriesStrip, {
        memories: [
          {
            key: "memory-1",
            title: value,
            sub: value,
            coverUri: null,
            newestAt: "2026-07-29T09:00:00Z",
            onOpen: noop,
          },
        ],
      })
    ),
  tally: (value) =>
    renderToStaticMarkup(
      createElement(ExpenseRow, {
        row: {
          expense_id: "expense-1",
          group_id: "group-1",
          group_name: value,
          description: value,
          amount_minor: 100,
          category: "other",
          spent_on: "2026-07-29",
          paid_by: "party-1",
          paid_by_name: value,
          your_role: "lent",
          your_amount_minor: 100,
          splits: [],
        },
        currency: "USD",
        groupSuffix: true,
        onOpen: noop,
      })
    ),
  tasks: (value) =>
    renderToStaticMarkup(
      createElement(TaskRow, {
        task: {
          task_id: "task-1",
          title: value,
          description: value,
          status: "needs-action",
        },
        onOpen: noop,
        onToggle: async () => true,
      })
    ),
};

function assertInert(html: string, vector: string): void {
  const host = document.createElement("div");
  host.innerHTML = html;
  expect(
    host.querySelector(
      "script,iframe,object,embed,style,template,[onerror],[onload],[onfocus]"
    )
  ).toBeNull();
  for (const node of host.querySelectorAll("[href],[src],[style]")) {
    const sink = [
      node.getAttribute("href"),
      node.getAttribute("src"),
      node.getAttribute("style"),
    ]
      .filter(Boolean)
      .join(" ");
    expect(sink).not.toMatch(/(?:javascript|vbscript|data:text\/html)/iu);
  }
  expect(host.textContent).toContain(displayText(vector));
}

describe("untrusted blueprint render paths", () => {
  const cases = Object.entries(RENDERERS).flatMap(([app, render]) =>
    VECTORS.map((vector) => ({ app, render, vector }))
  );
  it.each(cases)("$app renders $vector as inert text", ({ render, vector }) => {
    const html = render(vector);
    expect(html).toBeTypeOf("string");
    assertInert(html, vector);
  });

  it("allowlists dynamic URL sinks and rejects active-content schemes", () => {
    expect(safeExternalUrl("https://centraid.dev/path")).toBe(
      "https://centraid.dev/path"
    );
    expect(safeExternalUrl("javascript:alert(1)")).toBeNull();
    expect(safeExternalUrl("java\tscript:alert(1)")).toBeNull();
    expect(safeMediaUrl("data:image/svg+xml,<svg onload=alert(1)>")).toBeNull();
    expect(
      safeDocumentUrl("data:text/html,<script>alert(1)</script>")
    ).toBeNull();
    expect(
      safeBackgroundImage('https://x.invalid/a") ; color:red;/*')
    ).toBeUndefined();
  });
});
