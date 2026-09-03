import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";

import {
  ASSISTANT_APP_ID,
  createConversation,
  streamAssistantTurn,
  uploadConversationAttachment,
} from "../../../gateway-client.js";
import type { TurnStreamEvent } from "../../../gateway-client.js";
import { seat } from "../../host-platform.js";
import { loadHarnesses } from "../routes/settingsHarnessesData.js";
import { Store } from "../store.js";
import AssistantCompanion from "./AssistantCompanion.js";
import type {
  AssistantAttachmentSource,
  AssistantCompanionAttachment,
  AssistantCompanionMessage,
  AssistantCompanionSend,
} from "./AssistantCompanion.js";
import type {
  AssistantEffort,
  AssistantHarnessOption,
  AssistantSelection,
} from "./assistantCompanionModel.js";
import { initialAssistantSelection } from "./assistantCompanionModel.js";

export interface AssistantCompanionControllerProps {
  surface: "pointer" | "touch";
  open: boolean;
  contextLabel: string;
  getContextText: () => string;
  onOpenChange: (open: boolean) => void;
  onOpenFull: () => void;
}

const effortNote = (value: string): string => {
  const normalized = value.toLowerCase();
  if (normalized.includes("min")) return "Answers without thinking first";
  if (normalized.includes("low")) return "Brief reasoning · fewer tokens";
  if (normalized.includes("high")) return "Longest reasoning · most tokens";
  return "Balanced reasoning and response time";
};

export function companionCatalog(
  status: Awaited<ReturnType<typeof loadHarnesses>>
): AssistantHarnessOption[] {
  return status.cards.map((card) => {
    const effortOption = card.configOptions?.find(
      (option) => option.category === "thought_level"
    );
    const efforts: AssistantEffort[] = (effortOption?.values ?? []).map(
      (value) => ({
        id: value.value,
        label: value.name ?? value.value,
        note: effortNote(value.name ?? value.value),
      })
    );
    return {
      id: card.kind,
      label: card.title,
      vendorLabel: `${card.title}'s configured provider`,
      statusLabel: card.subtitle,
      installed: card.connected && card.sessionReady,
      models: card.models.map((model) => ({
        id: model.id,
        label: model.name ?? model.id,
        efforts,
        ...(efforts.length === 0
          ? {
              noEffortReason: `${model.name ?? model.id} does not expose a thinking budget.`,
            }
          : {}),
      })),
    };
  });
}

const messageId = (): string => crypto.randomUUID();

const replaceMessageContent =
  (
    id: string,
    content: string
  ): ((messages: AssistantCompanionMessage[]) => AssistantCompanionMessage[]) =>
  (messages) =>
    messages.map((message) =>
      message.id === id ? { ...message, content } : message
    );

export function companionPrompt(
  request: Pick<
    AssistantCompanionSend,
    "attachmentIds" | "includeContext" | "text"
  >,
  attachments: readonly AssistantCompanionAttachment[],
  contextLabel: string,
  contextText: string
): string {
  const selected = attachments.filter((attachment) =>
    request.attachmentIds.includes(attachment.id)
  );
  const pageAttachment = selected.find(
    (attachment) => attachment.source === "page"
  );
  const pageText =
    pageAttachment?.text ||
    contextText ||
    "No readable page text was available.";
  const context = request.includeContext
    ? [`Current page: ${contextLabel}\n${pageText}`]
    : [];
  const sources = selected.map((attachment) =>
    attachment.source === "page"
      ? request.includeContext
        ? `Attached source: This page as text — ${contextLabel} (using the current page snapshot above)`
        : `Attached source: This page as text — ${contextLabel}\n${attachment.text || "No readable page text was available."}`
      : `Attached source: ${attachment.label}\n${attachment.text || "No attachment payload was available."}`
  );
  return [...context, ...sources, request.text].join("\n\n");
}

export function companionAttachmentRefs(
  attachmentIds: readonly string[],
  attachments: readonly AssistantCompanionAttachment[]
) {
  return attachments
    .filter(
      (attachment) =>
        attachmentIds.includes(attachment.id) && attachment.ref !== undefined
    )
    .map((attachment) => attachment.ref!);
}

const readableFile = (file: File): boolean =>
  file.type.startsWith("text/") ||
  /\.(?:csv|json|md|markdown|txt)$/iu.test(file.name);

export async function companionFileAttachment(
  source: Exclude<AssistantAttachmentSource, "page" | "link">,
  file: File
): Promise<AssistantCompanionAttachment> {
  const content = readableFile(file) ? await file.text() : "";
  const kind = source === "photo" ? "Photo file" : "Chosen file";
  return {
    id: `${source}-${crypto.randomUUID()}`,
    label: `${kind} · ${file.name}`,
    source,
    text: [
      `Name: ${file.name}`,
      `Type: ${file.type || "unknown"}`,
      `Size: ${file.size} bytes`,
      content ? `Content:\n${content.slice(0, 12_000)}` : undefined,
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

export function companionLinkAttachment(
  value: string
): AssistantCompanionAttachment | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return {
      id: `link-${crypto.randomUUID()}`,
      label: `Link · ${url.hostname}`,
      source: "link",
      text: `URL: ${url.href}`,
    };
  } catch {
    return undefined;
  }
}

export function companionSelectionKey(value: "custodian" | "viewer"): string {
  return `assistant.companion.selection.${value}`;
}

export function readCompanionSelection(
  value: "custodian" | "viewer"
): AssistantSelection | undefined {
  return Store.get<AssistantSelection | undefined>(
    companionSelectionKey(value),
    undefined
  );
}

export function persistCompanionSelection(
  value: "custodian" | "viewer",
  selection: AssistantSelection
): void {
  Store.set(companionSelectionKey(value), selection);
}

export function companionAttachmentFor(
  source: AssistantAttachmentSource,
  contextLabel: string,
  contextText: string
): AssistantCompanionAttachment | undefined {
  if (source !== "page") return undefined;
  return {
    id: "current-page",
    label: `This page · ${contextLabel}`,
    source: "page",
    text: contextText,
  };
}

export default function AssistantCompanionController({
  surface,
  open,
  contextLabel,
  getContextText,
  onOpenChange,
  onOpenFull,
}: AssistantCompanionControllerProps): JSX.Element {
  const [catalog, setCatalog] = useState<AssistantHarnessOption[]>([]);
  const currentSeat = seat();
  const selectionKey = companionSelectionKey(currentSeat);
  const [selection, setSelection] = useState<AssistantSelection | undefined>(
    () => readCompanionSelection(currentSeat)
  );
  const [messages, setMessages] = useState<AssistantCompanionMessage[]>([]);
  const [attachments, setAttachments] = useState<
    AssistantCompanionAttachment[]
  >([]);
  const [working, setWorking] = useState(false);
  const conversationId = useRef<string | undefined>(undefined);
  const abort = useRef<AbortController | undefined>(undefined);

  useEffect(() => {
    let current = true;
    void Promise.resolve()
      .then(() => loadHarnesses())
      .then((status) => {
        if (!current) return;
        const nextCatalog = companionCatalog(status);
        setCatalog(nextCatalog);
        setSelection(
          (currentSelection) =>
            initialAssistantSelection(nextCatalog, currentSelection) ??
            undefined
        );
      })
      .catch(() => {
        if (current) setCatalog([]);
      });
    return () => {
      current = false;
    };
  }, [selectionKey]);

  useEffect(
    () => () => {
      abort.current?.abort();
    },
    []
  );

  const onRequestAttachment = async (
    source: AssistantAttachmentSource,
    payload?: File | string
  ): Promise<void> => {
    const attachment =
      source === "page"
        ? companionAttachmentFor(source, contextLabel, getContextText())
        : source === "link" && typeof payload === "string"
          ? companionLinkAttachment(payload)
          : payload instanceof File &&
              (source === "document" ||
                source === "photo" ||
                source === "device-file")
            ? {
                ...(await companionFileAttachment(source, payload)),
                ref: await uploadConversationAttachment(
                  ASSISTANT_APP_ID,
                  new Uint8Array(await payload.arrayBuffer()),
                  payload.type || "application/octet-stream",
                  payload.name
                ),
              }
            : undefined;
    if (!attachment) return;
    setAttachments((current) => [
      ...current.filter((item) => item.id !== "current-page"),
      attachment,
    ]);
  };

  const onSend = async (request: AssistantCompanionSend): Promise<void> => {
    const userId = messageId();
    const assistantId = messageId();
    setMessages((current) => [
      ...current,
      { id: userId, author: "you", meta: "YOU · NOW", content: request.text },
      {
        id: assistantId,
        author: "assistant",
        meta: "ASSISTANT · NOW",
        content: "",
      },
    ]);
    setWorking(true);
    try {
      conversationId.current ??= (
        await createConversation(ASSISTANT_APP_ID, request.text.slice(0, 80))
      ).id;
      const controller = new AbortController();
      abort.current = controller;
      const prompt = companionPrompt(
        request,
        attachments,
        contextLabel,
        request.includeContext ? getContextText() : ""
      );
      const attachmentRefs = companionAttachmentRefs(
        request.attachmentIds,
        attachments
      );
      let answer = "";
      const onEvent = (event: TurnStreamEvent): void => {
        if (event.type === "assistant.delta") answer += event.delta;
        else if (event.type === "final" && !answer) answer = event.text;
        else if (event.type === "error") answer = event.message;
        else return;
        setMessages(replaceMessageContent(assistantId, answer));
      };
      await streamAssistantTurn(
        {
          conversationId: conversationId.current,
          message: prompt,
          harnessKind: request.selection.harnessId,
          model: request.selection.modelId,
          ...(request.selection.effortId
            ? { thinking: request.selection.effortId }
            : {}),
          idempotencyKey: crypto.randomUUID(),
          ...(attachmentRefs.length ? { attachments: attachmentRefs } : {}),
        },
        onEvent,
        controller.signal
      );
    } catch (error) {
      const failureText =
        error instanceof Error ? error.message : "Turn failed";
      setMessages(replaceMessageContent(assistantId, failureText));
    } finally {
      abort.current = undefined;
      setWorking(false);
    }
  };

  return (
    <AssistantCompanion
      surface={surface}
      open={open}
      catalog={catalog}
      selection={selection}
      messages={messages}
      attachments={attachments}
      contextLabel={contextLabel}
      working={working}
      onOpenChange={onOpenChange}
      onOpenFull={onOpenFull}
      onSelectionChange={(next) => {
        setSelection(next);
        persistCompanionSelection(currentSeat, next);
      }}
      onRemoveAttachment={(id) =>
        setAttachments((current) =>
          current.filter((attachment) => attachment.id !== id)
        )
      }
      onRequestAttachment={(source, payload) =>
        void onRequestAttachment(source, payload)
      }
      onSend={(request) => void onSend(request)}
      onStop={() => abort.current?.abort()}
    />
  );
}
