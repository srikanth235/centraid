// @vitest-environment jsdom
/* oxlint-disable typescript-eslint/ban-ts-comment -- app components are browser
   modules; this node-side suite intentionally runs them under jsdom. */
/* oxlint-disable no-script-url -- the adversarial URL assertion must name the
   executable scheme it proves the shared allowlist rejects. */
// @ts-nocheck
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
import { ListView as AgendaListView } from "../apps/agenda/components/ListViews.tsx";
import { ListRow as DocsRow } from "../apps/docs/components/List.tsx";
import { LockerList } from "../apps/locker/components/List.tsx";
import { NoteCard } from "../apps/notes/components/Library.tsx";
import { Row as PeopleRow } from "../apps/people/components/Shared.tsx";
import { MemoriesStrip } from "../apps/photos/components/Memories.tsx";
import { LedgerRow } from "../apps/tally/components/LedgerRow.tsx";
import { TaskRow } from "../apps/tasks/components/TaskRow.tsx";

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

const RENDERERS: Record<string, Renderer> = {
  agenda: (value) =>
    renderToStaticMarkup(
      createElement(AgendaListView, {
        groups: [
          {
            dayKey: "2026-08-21",
            segments: [
              {
                ev: {
                  event_id: "event-1",
                  calendar_id: "cal-1",
                  dtstart: "2026-08-21T09:00:00Z",
                  dtend: "2026-08-21T10:00:00Z",
                  summary: value,
                  description: value,
                  snippet: value,
                  recurrence_summary: value,
                  conferencing_uri: value,
                  attendees: [{ party_id: "p1", name: value, partstat: value }],
                },
                segStart: 540,
                segEnd: 600,
                startsHere: true,
                endsHere: true,
                spansAll: false,
                clamped: false,
              },
            ],
          },
        ],
        hueFor: () => null,
        pendingFor: () => undefined,
        onOpen: noop,
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
        rows: [
          {
            item_id: "item-1",
            type: "login" as const,
            title: value,
            subtitle: value,
            tags: [value],
          },
        ],
        windowCount: 1,
        loaded: true,
        truncated: false,
        onOpen: noop,
        onCopyUsername: noop,
        onShowMore: noop,
        onImport: noop,
        onAdd: noop,
      })
    ),
  notes: (value) =>
    [
      renderToStaticMarkup(
        createElement(NoteCard, {
          note: {
            note_id: "note-1",
            title: value,
            preview: value,
            updated_at: "2026-08-21T09:00:00Z",
            notebook_names: [value],
          },
          onOpen: noop,
          onTogglePin: noop,
          search: "",
        })
      ),
      renderToStaticMarkup(
        createElement(NoteCard, {
          note: {
            note_id: "note-2",
            title: value,
            preview: value,
            updated_at: "2026-08-21T09:00:00Z",
            notebook_names: [value],
            snippet: value,
          },
          onOpen: noop,
          onTogglePin: noop,
          search: "term",
        })
      ),
    ].join(""),
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
      createElement(LedgerRow, {
        chip: { partyId: "party-1", initials: value },
        title: value,
        meta: value,
        status: { label: value, tone: "seam" as const },
        figure: { text: value, tone: "net" as const, sub: value },
        acts: [{ label: value, run: noop }],
        onOpen: noop,
      })
    ),
  tasks: (value) =>
    renderToStaticMarkup(
      createElement(TaskRow, {
        task: {
          task_id: "task-1",
          status: "needs-action",
          title: value,
          due_at: "2026-08-21",
          tags: [{ tag_id: "g1", label: value }],
        },
        now: "2026-08-21T09:00:00Z",
        projectName: value,
        projectHue: "ochre",
        shared: true,
        onOpen: noop,
        onComplete: noop,
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
