// governance: allow-repo-hygiene file-size-limit (#567) one component-level suite shares the Assistant bridge fixture across runner, capability, workspace, attachment, stop, and transcript behavior
// (Provider-egress consent lives on the ROUTE, not this screen — see AssistantRoute.test.tsx.)
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  AssistantBridgeProps,
  AssistantSnapshot,
  AsstModelPickerDTO,
} from "../screen-contracts.js";
import AssistantScreen from "./AssistantScreen.js";
import { TRANSCRIPT_WINDOW } from "./transcriptWindow.js";

function emptySnap(over: Partial<AssistantSnapshot> = {}): AssistantSnapshot {
  return {
    empty: true,
    busy: false,
    messages: [],
    pendingAttachments: [],
    ...over,
  };
}

function modelPickerDTO(
  over: Partial<AsstModelPickerDTO> = {}
): AsstModelPickerDTO {
  return {
    runners: [
      {
        kind: "codex",
        title: "Codex",
        connected: true,
        sessionReady: true,
        hint: "ready",
      },
    ],
    selectedRunnerKind: "codex",
    workspaceKinds: ["vault-data"],
    connected: true,
    models: [
      { id: "sonnet-5", name: "Sonnet 5", default: true },
      { id: "opus-5", name: "Opus 5" },
    ],
    defaultModelName: "Sonnet 5",
    selectedModelId: "",
    efforts: [],
    defaultEffortName: "",
    selectedEffortId: "",
    supportsAttachments: true,
    supportsContext: true,
    ...over,
  };
}

function makeProps(
  over: Partial<AssistantBridgeProps> = {}
): AssistantBridgeProps {
  return {
    suggestions: [
      "What did I spend the most on last month?",
      "What tasks are due this week?",
    ],
    onReady: vi.fn<AssistantBridgeProps["onReady"]>(),
    onSend: vi.fn<AssistantBridgeProps["onSend"]>(),
    onStop: vi.fn<AssistantBridgeProps["onStop"]>(),
    onAttachFiles: vi.fn<AssistantBridgeProps["onAttachFiles"]>(),
    onRemovePendingAttachment:
      vi.fn<AssistantBridgeProps["onRemovePendingAttachment"]>(),
    hydrateRefs: vi.fn<AssistantBridgeProps["hydrateRefs"]>(),
    wireCodeCopy: vi.fn<AssistantBridgeProps["wireCodeCopy"]>(),
    loadAttachmentImage: vi
      .fn<AssistantBridgeProps["loadAttachmentImage"]>()
      .mockResolvedValue("blob:mock"),
    onCopyMessage: vi.fn<AssistantBridgeProps["onCopyMessage"]>(),
    onFeedback: vi.fn<AssistantBridgeProps["onFeedback"]>(),
    onRegenerate: vi.fn<AssistantBridgeProps["onRegenerate"]>(),
    onRetryError: vi.fn<AssistantBridgeProps["onRetryError"]>(),
    onPagerNav: vi.fn<AssistantBridgeProps["onPagerNav"]>(),
    loadModelPicker: vi
      .fn<AssistantBridgeProps["loadModelPicker"]>()
      .mockResolvedValue(modelPickerDTO()),
    onSetModel: vi.fn<AssistantBridgeProps["onSetModel"]>(),
    onSetEffort: vi.fn<AssistantBridgeProps["onSetEffort"]>(),
    onSetRunner: vi
      .fn<AssistantBridgeProps["onSetRunner"]>()
      .mockResolvedValue(modelPickerDTO()),
    ...over,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((_resolve) => {
    resolve = _resolve;
  });
  return { promise, resolve };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let update: ((s: AssistantSnapshot) => void) | null = null;
describe("AssistantScreen suite", () => {
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    update = null;
    vi.clearAllMocks();
  });
  async function mount(props: AssistantBridgeProps): Promise<HTMLDivElement> {
    container = document.createElement("div");
    document.body.appendChild(container);
    const onReady = (u: (s: AssistantSnapshot) => void): void => {
      update = u;
    };
    // Awaited so the model-picker fetch this mount kicks off settles INSIDE
    // act. Left dangling it lands as an un-acted update after the test body has
    // moved on — which is what every "not wrapped in act" warning in this file
    // was reporting.
    await act(async () => {
      root = createRoot(container as HTMLDivElement);
      root.render(<AssistantScreen {...props} onReady={onReady} />);
      await Promise.resolve();
    });
    return container;
  }
  function push(snap: AssistantSnapshot): void {
    act(() => update?.(snap));
  }
  function setValue(el: HTMLTextAreaElement, value: string): void {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value"
    )?.set;
    setter?.call(el, value);
    void act(() => el.dispatchEvent(new Event("input", { bubbles: true })));
  }
  /** Flush the `loadModelPicker()` microtask the picker fetches on mount. */
  async function flush(): Promise<void> {
    await act(async () => {
      await Promise.resolve();
    });
  }

  describe(AssistantScreen, () => {
    it("shows the empty state with clickable suggestions", async () => {
      const props = makeProps();
      const el = await mount(props);
      push(emptySnap());
      expect(el.querySelector(".empty")).toBeTruthy();
      const chips = [...el.querySelectorAll<HTMLButtonElement>(".suggestChip")];
      expect(chips).toHaveLength(2);
      void act(() =>
        chips[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true }))
      );
      // suggestion loads into the composer draft
      expect(
        (el.querySelector(".input") as HTMLTextAreaElement).value
      ).toContain("spend");
    });

    it("renders user, tools, and streaming/final AI messages", async () => {
      const el = await mount(makeProps());
      push(
        emptySnap({
          empty: false,
          messages: [
            { kind: "user", text: "How much did I spend?" },
            {
              kind: "tools",
              label: "1 query · 12ms",
              calls: [
                {
                  tool: "vault_sql",
                  sql: "SELECT 1",
                  state: "ok",
                  meta: "3 rows · 12ms",
                  outputText: "terminal output",
                  artifacts: [
                    {
                      label: "report.md",
                      workspacePath: "/workspace/report.md",
                      hash: "abc123",
                    },
                  ],
                },
              ],
            },
            {
              kind: "ai",
              streaming: false,
              html: '<p class="cd-asst-p">You spent <strong>$412</strong>.</p>',
              error: false,
              copyText: "You spent $412.",
            },
          ],
        })
      );
      expect(el.querySelector(".msgUser")?.textContent).toContain("How much");
      expect(el.querySelector(".tools summary")?.textContent).toContain(
        "1 query"
      );
      expect(el.querySelector(".asstPre")?.textContent).toBe("SELECT 1");
      expect([...el.querySelectorAll(".asstPre")][1]?.textContent).toBe(
        "terminal output"
      );
      expect(el.querySelector(".toolArtifact")?.textContent).toContain(
        "report.md"
      );
      expect(el.querySelector(".toolArtifact")?.getAttribute("title")).toBe(
        "/workspace/report.md"
      );
      // final answer HTML is injected verbatim
      expect(el.querySelector(".msgAi strong")?.textContent).toBe("$412");
    });

    it("renders attachment chips on a user message", async () => {
      const el = await mount(makeProps());
      push(
        emptySnap({
          empty: false,
          messages: [
            {
              kind: "user",
              text: "See attached",
              attachments: [
                {
                  hash: "h1",
                  filename: "notes.pdf",
                  mime: "application/pdf",
                  sizeBytes: 2048,
                },
              ],
            },
          ],
        })
      );
      const chip = el.querySelector(".msgAttachChip");
      expect(chip?.textContent).toContain("notes.pdf");
    });

    it("re-hydrates refs inside an injected final answer", async () => {
      const props = makeProps();
      await mount(props);
      push(
        emptySnap({
          empty: false,
          messages: [
            {
              kind: "ai",
              streaming: false,
              html: '<p>See <button class="cd-asst-ref">x</button></p>',
              error: false,
              copyText: "See x",
            },
          ],
        })
      );
      expect(props.hydrateRefs).toHaveBeenCalledOnce();
      const node = (props.hydrateRefs as ReturnType<typeof vi.fn>).mock
        .calls[0]![0] as HTMLElement;
      expect(node.querySelector(".cd-asst-ref")).not.toBeNull();
    });

    it("shows a live streaming bubble with a cursor", async () => {
      const el = await mount(makeProps());
      push(
        emptySnap({
          empty: false,
          busy: true,
          messages: [{ kind: "ai", streaming: true, text: "Working on it" }],
        })
      );
      expect(el.querySelector(".live")?.textContent).toBe("Working on it");
      expect(el.querySelector(".cursor")).not.toBeNull();
    });

    it("sends the composed draft on Enter and clears it", async () => {
      const props = makeProps();
      const el = await mount(props);
      push(emptySnap());
      const input = el.querySelector(".input") as HTMLTextAreaElement;
      setValue(input, "When is my next event?");
      void act(() =>
        input.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
        )
      );
      expect(props.onSend).toHaveBeenCalledWith("When is my next event?");
      expect(input.value).toBe("");
    });

    it("the send button acts as Stop while busy", async () => {
      const props = makeProps();
      const el = await mount(props);
      push(emptySnap({ busy: true }));
      const send = el.querySelector(".send") as HTMLButtonElement;
      expect(send.getAttribute("aria-label")).toBe("Stop");
      void act(() =>
        send.dispatchEvent(new MouseEvent("click", { bubbles: true }))
      );
      expect(props.onStop).toHaveBeenCalledOnce();
      expect(props.onSend).toHaveBeenCalledTimes(0);
    });

    it("does not send while busy or when the draft is blank and nothing is attached", async () => {
      const props = makeProps();
      const el = await mount(props);
      push(emptySnap());
      const input = el.querySelector(".input") as HTMLTextAreaElement;
      setValue(input, "   ");
      void act(() =>
        input.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
        )
      );
      expect(props.onSend).toHaveBeenCalledTimes(0);
    });

    it("sends a blank draft when a ready attachment is staged", async () => {
      const props = makeProps();
      const el = await mount(props);
      push(
        emptySnap({
          pendingAttachments: [
            {
              id: "a1",
              filename: "photo.png",
              sizeBytes: 1024,
              state: "ready",
            },
          ],
        })
      );
      const send = el.querySelector(".send") as HTMLButtonElement;
      void act(() =>
        send.dispatchEvent(new MouseEvent("click", { bubbles: true }))
      );
      expect(props.onSend).toHaveBeenCalledWith("");
    });

    it("renders staged attachment chips and removes one", async () => {
      const props = makeProps();
      const el = await mount(props);
      push(
        emptySnap({
          pendingAttachments: [
            {
              id: "a1",
              filename: "photo.png",
              sizeBytes: 1024,
              state: "ready",
            },
            {
              id: "a2",
              filename: "huge.zip",
              sizeBytes: 0,
              state: "uploading",
            },
          ],
        })
      );
      const chips = [...el.querySelectorAll<HTMLDivElement>(".attachChip")];
      expect(chips).toHaveLength(2);
      const removeBtn = chips[0]!.querySelector(
        ".attachRemove"
      ) as HTMLButtonElement;
      void act(() =>
        removeBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }))
      );
      expect(props.onRemovePendingAttachment).toHaveBeenCalledWith("a1");
    });

    it("forwards dropped files to onAttachFiles", async () => {
      const props = makeProps();
      const el = await mount(props);
      push(emptySnap());
      const row = el.querySelector(".composerRow") as HTMLDivElement;
      const file = new File(["hello"], "hello.txt", { type: "text/plain" });
      const dataTransfer = { files: [file] } as unknown as DataTransfer;
      void act(() =>
        row.dispatchEvent(
          Object.assign(
            new Event("drop", { bubbles: true, cancelable: true }),
            {
              dataTransfer,
            }
          )
        )
      );
      expect(props.onAttachFiles).toHaveBeenCalledWith([file]);
    });

    describe("transcript actions (#420)", () => {
      const finalAi = (
        over: Record<string, unknown> = {}
      ): AssistantSnapshot["messages"][number] => ({
        kind: "ai",
        streaming: false,
        html: "<p>Answer</p>",
        error: false,
        copyText: "Answer",
        turnId: "t1",
        feedback: null,
        ...over,
      });
      const clickLabel = (el: HTMLElement, label: string): void => {
        const btn = el.querySelector(
          `[aria-label="${label}"]`
        ) as HTMLButtonElement;
        void act(() =>
          btn.dispatchEvent(new MouseEvent("click", { bubbles: true }))
        );
      };

      it("copies an answer via the copy button", async () => {
        const props = makeProps();
        const el = await mount(props);
        push(emptySnap({ empty: false, messages: [finalAi()] }));
        clickLabel(el, "Copy message");
        expect(props.onCopyMessage).toHaveBeenCalledWith("Answer");
      });

      it("sends thumbs feedback with the answer turn id", async () => {
        const props = makeProps();
        const el = await mount(props);
        push(emptySnap({ empty: false, messages: [finalAi()] }));
        clickLabel(el, "Good response");
        expect(props.onFeedback).toHaveBeenCalledWith("t1", "up");
        clickLabel(el, "Bad response");
        expect(props.onFeedback).toHaveBeenCalledWith("t1", "down");
      });

      it("regenerates the last answer", async () => {
        const props = makeProps();
        const el = await mount(props);
        push(
          emptySnap({
            empty: false,
            messages: [finalAi({ canRegenerate: true })],
          })
        );
        clickLabel(el, "Regenerate response");
        expect(props.onRegenerate).toHaveBeenCalledOnce();
      });

      it("flips the retry pager", async () => {
        const props = makeProps();
        const el = await mount(props);
        push(
          emptySnap({
            empty: false,
            messages: [finalAi({ retry: { index: 2, count: 2 } })],
          })
        );
        expect(el.querySelector(".pagerLabel")?.textContent).toBe("2/2");
        clickLabel(el, "Previous attempt");
        expect(props.onPagerNav).toHaveBeenCalledWith(0, -1);
      });

      it("retries a failed message from its error bubble", async () => {
        const props = makeProps();
        const el = await mount(props);
        push(
          emptySnap({
            empty: false,
            messages: [
              { kind: "user", text: "q" },
              {
                kind: "ai",
                streaming: false,
                html: "<p>err</p>",
                error: true,
                copyText: "err",
                canRetry: true,
              },
            ],
          })
        );
        const retry = el.querySelector(
          '[aria-label="Retry"]'
        ) as HTMLButtonElement;
        expect(retry.textContent).toContain("Retry");
        void act(() =>
          retry.dispatchEvent(new MouseEvent("click", { bubbles: true }))
        );
        expect(props.onRetryError).toHaveBeenCalledWith(1);
      });
    });

    // Long-transcript windowing (issue #659). The control is the safety
    // property: history is deferred, never dropped, and the reader is told how
    // much is above them.
    describe("transcript windowing (#659)", () => {
      const longTranscript = (n: number): AssistantSnapshot =>
        emptySnap({
          empty: false,
          messages: Array.from({ length: n }, (_unused, index) => ({
            kind: "user" as const,
            text: `message ${index}`,
            msgId: `m${index}`,
          })),
        });

      it("mounts only the newest window and says how many are above", async () => {
        const el = await mount(makeProps());
        push(longTranscript(200));
        expect(el.querySelectorAll(".msgUser")).toHaveLength(TRANSCRIPT_WINDOW);
        expect(el.textContent).toContain("message 199");
        expect(el.textContent).not.toContain("message 0");
        const earlier = el.querySelector(".showEarlier");
        expect(earlier?.textContent).toContain(
          `${200 - TRANSCRIPT_WINDOW} above`
        );
      });

      it("offers the control as a real button, so it is keyboard reachable", async () => {
        const el = await mount(makeProps());
        push(longTranscript(200));
        const earlier = el.querySelector<HTMLElement>(".showEarlier");
        expect(earlier?.tagName).toBe("BUTTON");
        // Not removed from the tab order, and not a div wearing a role.
        expect(earlier?.getAttribute("tabindex")).toBeNull();
        expect(earlier?.hasAttribute("disabled")).toBe(false);
      });

      it("reveals older messages a window at a time, keeping the newest mounted", async () => {
        const el = await mount(makeProps());
        push(longTranscript(200));
        const earlier = el.querySelector<HTMLButtonElement>(".showEarlier");
        void act(() =>
          earlier!.dispatchEvent(new MouseEvent("click", { bubbles: true }))
        );
        expect(el.querySelectorAll(".msgUser")).toHaveLength(
          TRANSCRIPT_WINDOW * 2
        );
        expect(el.textContent).toContain("message 199");
      });

      it("stops offering the control once the whole transcript is mounted", async () => {
        const el = await mount(makeProps());
        push(longTranscript(TRANSCRIPT_WINDOW + 1));
        void act(() =>
          el
            .querySelector<HTMLButtonElement>(".showEarlier")!
            .dispatchEvent(new MouseEvent("click", { bubbles: true }))
        );
        expect(el.querySelector(".showEarlier")).toBeNull();
        expect(el.textContent).toContain("message 0");
      });

      it("never shows the control for a transcript that already fits", async () => {
        const el = await mount(makeProps());
        push(longTranscript(5));
        expect(el.querySelector(".showEarlier")).toBeNull();
      });

      it("keeps offering the control when the local window is exhausted but the server has more", async () => {
        const el = await mount(makeProps());
        push({ ...longTranscript(5), canLoadEarlier: true });
        // Nothing is hidden locally, yet older turns exist server-side — the
        // control must still be there.
        const earlier = el.querySelector<HTMLButtonElement>(".showEarlier");
        expect(earlier).not.toBeNull();
        expect(earlier?.textContent).toBe("Show earlier messages");
      });

      it("expands the local window BEFORE asking the server", async () => {
        const onLoadEarlier = vi.fn<() => void>();
        const el = await mount(makeProps({ onLoadEarlier }));
        push({ ...longTranscript(200), canLoadEarlier: true });
        void act(() =>
          el
            .querySelector<HTMLButtonElement>(".showEarlier")!
            .dispatchEvent(new MouseEvent("click", { bubbles: true }))
        );
        // Rows it already holds are free; the fetch is the last resort.
        expect(onLoadEarlier).not.toHaveBeenCalled();
        expect(el.querySelectorAll(".msgUser")).toHaveLength(
          TRANSCRIPT_WINDOW * 2
        );
      });

      it("asks the server once the local window is exhausted", async () => {
        const onLoadEarlier = vi.fn<() => void>();
        const el = await mount(makeProps({ onLoadEarlier }));
        push({ ...longTranscript(5), canLoadEarlier: true });
        void act(() =>
          el
            .querySelector<HTMLButtonElement>(".showEarlier")!
            .dispatchEvent(new MouseEvent("click", { bubbles: true }))
        );
        expect(onLoadEarlier).toHaveBeenCalledOnce();
      });

      it("disables the control and says so while a page is in flight", async () => {
        const onLoadEarlier = vi.fn<() => void>();
        const el = await mount(makeProps({ onLoadEarlier }));
        push({
          ...longTranscript(5),
          canLoadEarlier: true,
          loadingEarlier: true,
        });
        const earlier = el.querySelector<HTMLButtonElement>(".showEarlier");
        expect(earlier?.disabled).toBe(true);
        expect(earlier?.textContent).toBe("Loading earlier messages…");
      });

      it("retires the control once neither source has more", async () => {
        const el = await mount(makeProps());
        push({ ...longTranscript(5), canLoadEarlier: false });
        expect(el.querySelector(".showEarlier")).toBeNull();
      });

      it("re-collapses the window when the open conversation changes", async () => {
        const props = makeProps({ conversationId: "c-1" });
        const el = await mount(props);
        push(longTranscript(200));
        void act(() =>
          el
            .querySelector<HTMLButtonElement>(".showEarlier")!
            .dispatchEvent(new MouseEvent("click", { bubbles: true }))
        );
        expect(el.querySelectorAll(".msgUser")).toHaveLength(
          TRANSCRIPT_WINDOW * 2
        );
        await act(async () => {
          root!.render(
            <AssistantScreen
              {...props}
              conversationId="c-2"
              onReady={(u) => {
                update = u;
              }}
            />
          );
          await Promise.resolve();
        });
        push(longTranscript(200));
        expect(el.querySelectorAll(".msgUser")).toHaveLength(TRANSCRIPT_WINDOW);
      });
    });

    describe("model picker", () => {
      it('shows "Default · <model>" when the subsystem has no override, with an accessible name', async () => {
        const props = makeProps();
        const el = await mount(props);
        push(emptySnap());
        await flush();
        const btn = el.querySelector(".modelBtn") as HTMLButtonElement;
        expect(btn.getAttribute("aria-label")).toBe("Assistant model");
        expect(btn.textContent).toContain("Default · Sonnet 5");
        expect(props.loadModelPicker).toHaveBeenCalledOnce();
      });

      it("shows the overridden model name when the subsystem pref is set", async () => {
        const props = makeProps({
          loadModelPicker: vi
            .fn<AssistantBridgeProps["loadModelPicker"]>()
            .mockResolvedValue(modelPickerDTO({ selectedModelId: "opus-5" })),
        });
        const el = await mount(props);
        push(emptySnap());
        await flush();
        const btn = el.querySelector(".modelBtn") as HTMLButtonElement;
        expect(btn.textContent).toContain("Opus 5");
        expect(btn.textContent).not.toContain("Default");
      });

      it("opens a menu on click with menu/menuitemradio semantics, closes on Escape", async () => {
        const props = makeProps();
        const el = await mount(props);
        push(emptySnap());
        await flush();
        const btn = el.querySelector(".modelBtn") as HTMLButtonElement;
        void act(() =>
          btn.dispatchEvent(new MouseEvent("click", { bubbles: true }))
        );
        expect(btn.getAttribute("aria-expanded")).toBe("true");
        const menu = el.querySelector(".modelMenu") as HTMLDivElement;
        expect(menu.getAttribute("role")).toBe("menu");
        const items = [...el.querySelectorAll('[role="menuitemradio"]')];
        // "Use default" + the two catalog models
        expect(items).toHaveLength(3);
        expect(items[0]?.getAttribute("aria-checked")).toBe("true"); // no override yet
        void act(() =>
          document.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
          )
        );
        expect(el.querySelector(".modelMenu")).toBeFalsy();
        expect(btn.getAttribute("aria-expanded")).toBe("false");
      });

      it("closes on an outside click", async () => {
        const props = makeProps();
        const el = await mount(props);
        push(emptySnap());
        await flush();
        const btn = el.querySelector(".modelBtn") as HTMLButtonElement;
        void act(() =>
          btn.dispatchEvent(new MouseEvent("click", { bubbles: true }))
        );
        expect(el.querySelector(".modelMenu")).toBeTruthy();
        void act(() =>
          document.body.dispatchEvent(
            new MouseEvent("mousedown", { bubbles: true })
          )
        );
        expect(el.querySelector(".modelMenu")).toBeFalsy();
      });

      it("picking a catalog model persists the pref and updates the label immediately", async () => {
        const props = makeProps();
        const el = await mount(props);
        push(emptySnap());
        await flush();
        const btn = el.querySelector(".modelBtn") as HTMLButtonElement;
        void act(() =>
          btn.dispatchEvent(new MouseEvent("click", { bubbles: true }))
        );
        const opusItem = [
          ...el.querySelectorAll('[role="menuitemradio"]'),
        ].find((n) => n.textContent?.includes("Opus 5")) as HTMLButtonElement;
        void act(() =>
          opusItem.dispatchEvent(new MouseEvent("click", { bubbles: true }))
        );
        expect(props.onSetModel).toHaveBeenCalledWith("opus-5");
        expect(el.querySelector(".modelMenu")).toBeFalsy();
        expect(
          (el.querySelector(".modelBtn") as HTMLButtonElement).textContent
        ).toContain("Opus 5");
      });

      it('"Use default" clears the override back to the runner default', async () => {
        const props = makeProps({
          loadModelPicker: vi
            .fn<AssistantBridgeProps["loadModelPicker"]>()
            .mockResolvedValue(modelPickerDTO({ selectedModelId: "opus-5" })),
        });
        const el = await mount(props);
        push(emptySnap());
        await flush();
        const btn = el.querySelector(".modelBtn") as HTMLButtonElement;
        void act(() =>
          btn.dispatchEvent(new MouseEvent("click", { bubbles: true }))
        );
        const useDefault = [
          ...el.querySelectorAll('[role="menuitemradio"]'),
        ][0] as HTMLButtonElement;
        void act(() =>
          useDefault.dispatchEvent(new MouseEvent("click", { bubbles: true }))
        );
        expect(props.onSetModel).toHaveBeenCalledWith("");
        expect(
          (el.querySelector(".modelBtn") as HTMLButtonElement).textContent
        ).toContain("Default · Sonnet 5");
      });
    });

    it("shows capability-derived effort and persists a new choice", async () => {
      const props = makeProps({
        loadModelPicker: vi
          .fn<AssistantBridgeProps["loadModelPicker"]>()
          .mockResolvedValue(
            modelPickerDTO({
              efforts: [
                { value: "medium", name: "Medium" },
                { value: "high", name: "High" },
              ],
              defaultEffortName: "Medium",
            })
          ),
      });
      const el = await mount(props);
      push(emptySnap());
      await flush();
      const effort = el.querySelector(
        'select[aria-label="Assistant effort"]'
      ) as HTMLSelectElement;
      expect(effort).toBeTruthy();
      await act(async () => {
        effort.value = "high";
        effort.dispatchEvent(new Event("change", { bubbles: true }));
      });
      expect(props.onSetEffort).toHaveBeenCalledWith("high");
    });

    it("re-enables the pickers when a runner switch rejects", async () => {
      const props = makeProps({
        loadModelPicker: vi
          .fn<AssistantBridgeProps["loadModelPicker"]>()
          .mockResolvedValue(
            modelPickerDTO({
              runners: [
                {
                  kind: "codex",
                  title: "Codex",
                  connected: true,
                  sessionReady: true,
                  hint: "ready",
                },
                {
                  kind: "copilot",
                  title: "Copilot",
                  connected: true,
                  sessionReady: true,
                  hint: "ready",
                },
              ],
            })
          ),
        onSetRunner: vi
          .fn<AssistantBridgeProps["onSetRunner"]>()
          .mockRejectedValue(new Error("preflight failed")),
      });
      const el = await mount(props);
      push(emptySnap());
      await flush();
      const runner = el.querySelector(
        'select[aria-label="Assistant runner"]'
      ) as HTMLSelectElement;
      expect(runner.disabled).toBe(false);
      await act(async () => {
        runner.value = "copilot";
        runner.dispatchEvent(new Event("change", { bubbles: true }));
        await Promise.resolve();
      });
      await flush();
      // A rejected switch used to leave every picker disabled for good.
      expect(props.onSetRunner).toHaveBeenCalledWith("copilot");
      expect(
        el.querySelector<HTMLSelectElement>(
          'select[aria-label="Assistant runner"]'
        )?.disabled
      ).toBe(false);
    });

    it("re-enables the composer when the initial picker load rejects", async () => {
      const props = makeProps({
        loadModelPicker: vi
          .fn<AssistantBridgeProps["loadModelPicker"]>()
          .mockRejectedValue(new Error("provider status unavailable")),
      });
      const el = await mount(props);
      push(emptySnap());
      await flush();

      // A failed capability read must not strand the composer in its
      // loading-disabled state forever.
      expect((el.querySelector(".input") as HTMLTextAreaElement).disabled).toBe(
        false
      );
    });

    it("ignores an older picker response after a conversation revision", async () => {
      const first = deferred<AsstModelPickerDTO>();
      const codex = modelPickerDTO();
      const claude = modelPickerDTO({
        runners: [
          {
            kind: "codex",
            title: "Codex",
            connected: true,
            sessionReady: true,
            hint: "ready",
          },
          {
            kind: "claude-code",
            title: "Claude Code",
            connected: true,
            sessionReady: true,
            hint: "ready",
          },
        ],
        selectedRunnerKind: "claude-code",
        defaultModelName: "Claude default",
      });
      const props = makeProps({
        loadModelPicker: vi
          .fn<AssistantBridgeProps["loadModelPicker"]>()
          .mockReturnValueOnce(first.promise)
          .mockResolvedValue(claude),
      });
      const el = await mount(props);

      push(emptySnap({ pickerRevision: 1 }));
      await flush();
      expect(
        (
          el.querySelector(
            'select[aria-label="Assistant runner"]'
          ) as HTMLSelectElement
        ).value
      ).toBe("claude-code");

      first.resolve(codex);
      await flush();
      // The response for the superseded revision must not repaint Codex.
      expect(
        (
          el.querySelector(
            'select[aria-label="Assistant runner"]'
          ) as HTMLSelectElement
        ).value
      ).toBe("claude-code");
    });

    it("keeps the latest overlapping runner switch", async () => {
      const claudeResult = deferred<AsstModelPickerDTO>();
      const copilotResult = deferred<AsstModelPickerDTO>();
      const initial = modelPickerDTO({
        runners: [
          {
            kind: "codex",
            title: "Codex",
            connected: true,
            sessionReady: true,
            hint: "ready",
          },
          {
            kind: "claude-code",
            title: "Claude Code",
            connected: true,
            sessionReady: true,
            hint: "ready",
          },
          {
            kind: "copilot",
            title: "Copilot",
            connected: true,
            sessionReady: true,
            hint: "ready",
          },
        ],
      });
      const props = makeProps({
        loadModelPicker: vi
          .fn<AssistantBridgeProps["loadModelPicker"]>()
          .mockResolvedValue(initial),
        onSetRunner: vi
          .fn<AssistantBridgeProps["onSetRunner"]>()
          .mockReturnValueOnce(claudeResult.promise)
          .mockReturnValueOnce(copilotResult.promise),
      });
      const el = await mount(props);
      push(emptySnap());
      await flush();
      const runner = el.querySelector(
        'select[aria-label="Assistant runner"]'
      ) as HTMLSelectElement;

      await act(async () => {
        runner.value = "claude-code";
        runner.dispatchEvent(new Event("change", { bubbles: true }));
        runner.value = "copilot";
        runner.dispatchEvent(new Event("change", { bubbles: true }));
      });
      expect(props.onSetRunner).toHaveBeenNthCalledWith(1, "claude-code");
      expect(props.onSetRunner).toHaveBeenNthCalledWith(2, "copilot");

      copilotResult.resolve(
        modelPickerDTO({
          runners: initial.runners,
          selectedRunnerKind: "copilot",
          defaultModelName: "Copilot default",
        })
      );
      await flush();
      expect(runner.value).toBe("copilot");

      claudeResult.resolve(
        modelPickerDTO({
          runners: initial.runners,
          selectedRunnerKind: "claude-code",
          defaultModelName: "Claude default",
        })
      );
      await flush();
      expect(runner.value).toBe("copilot");
      expect(runner.disabled).toBe(false);
    });

    it("hides the workspace select while there is only one workspace", async () => {
      const el = await mount(makeProps());
      push(emptySnap());
      await flush();
      expect(
        el.querySelector('select[aria-label="Assistant workspace"]')
      ).toBeNull();
    });

    it("labels workspaces in words once there is a choice", async () => {
      const props = makeProps({
        loadModelPicker: vi
          .fn<AssistantBridgeProps["loadModelPicker"]>()
          .mockResolvedValue(
            modelPickerDTO({ workspaceKinds: ["vault-data", "app"] })
          ),
      });
      const el = await mount(props);
      push(emptySnap());
      await flush();
      const select = el.querySelector(
        'select[aria-label="Assistant workspace"]'
      );
      expect(
        [...(select?.querySelectorAll("option") ?? [])].map(
          (o) => o.textContent
        )
      ).toStrictEqual(["Vault data", "Live app"]);
    });

    it("renders the latest context snapshot and permits the gauge to decrease", async () => {
      const el = await mount(makeProps());
      push(emptySnap({ context: { used: 80, size: 100 } }));
      const gauge = el.querySelector('[aria-label="Context 80 of 100 tokens"]');
      expect(gauge?.textContent).toContain("80%");
      push(emptySnap({ context: { used: 25, size: 100 } }));
      expect(
        el.querySelector('[aria-label="Context 25 of 100 tokens"]')?.textContent
      ).toContain("25%");
    });
  });
});
