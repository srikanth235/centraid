export type TurnStreamEvent =
  | { type: "assistant.start" }
  | { type: "assistant.delta"; delta: string }
  | { type: "reasoning.delta"; delta: string }
  | {
      type: "tool.start";
      toolCallId: string;
      toolName: string;
      args?: unknown;
      sql?: string;
      kind?: string;
      rawJson?: string;
    }
  | {
      type: "tool.result";
      toolCallId: string;
      toolName: string;
      ok: boolean;
      result?: unknown;
      errorText?: string;
      diffs?: Array<{ path?: string; oldText?: string; newText?: string }>;
      locations?: Array<{ path: string; line?: number }>;
      artifacts?: Array<{
        dataBase64: string;
        mime: string;
        filename?: string;
        hash?: string;
      }>;
      rawJson?: string;
    }
  | {
      type: "phase";
      phase: string;
      detail?: unknown;
      plan?: Array<{ content: string; status?: string; priority?: string }>;
    }
  | { type: "final"; text: string; stopReason?: string; rawJson?: string }
  | {
      type: "error";
      message: string;
      failureClass?:
        | "spawn"
        | "auth"
        | "init"
        | "timeout"
        | "quota"
        | "wedge"
        | "exit"
        | "unknown";
      stopReason?: string;
      rawJson?: string;
    }
  | { type: "aborted" }
  | {
      type: "consent.required";
      consentKind: "provider-egress";
      provider: string;
      reason: "direct" | "ladder";
      message: string;
    }
  | { type: "notice"; level: "warn" | "info"; code?: string; message: string }
  | {
      type: "usage";
      model?: string;
      provider?: string;
      effort?: string;
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      costUsd?: number;
      costSource?: "harness" | "estimated";
    }
  | { type: "context"; used?: number; size?: number }
  | {
      type: "webhooks";
      minted: Array<{
        automationId: string;
        ownerApp: string;
        webhookId: string;
        url: string;
        secret: string;
      }>;
    };

export function frameData(rawFrame: string): string {
  let data = "";
  for (const line of rawFrame.split("\n")) {
    if (line.slice(0, 5) === "data:") data += line.slice(5).replace(/^ /u, "");
  }
  return data;
}

export function parseFrame(rawFrame: string): TurnStreamEvent | null {
  const data = frameData(rawFrame);
  if (!data) return null;
  try {
    const evt: unknown = JSON.parse(data);
    if (evt && typeof (evt as { type?: unknown }).type === "string")
      return evt as TurnStreamEvent;
  } catch {
    // Intentionally empty.
  }
  return null;
}

export function isEndFrame(rawFrame: string): boolean {
  for (const line of rawFrame.split("\n")) {
    if (
      line.slice(0, 6) === "event:" &&
      line.slice(6).replace(/^ /u, "") === "end"
    )
      return true;
  }
  return false;
}

export function parseSseText(text: string): TurnStreamEvent[] {
  const out: TurnStreamEvent[] = [];
  for (const frame of text.split("\n\n")) {
    const evt = parseFrame(frame);
    if (evt) out.push(evt);
  }
  return out;
}

export async function consumeSseFrames(
  body: ReadableStream<Uint8Array>,
  onFrame: (rawFrame: string) => void,
  opts: { signal?: AbortSignal } = {}
): Promise<void> {
  const { signal } = opts;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  async function consumeNext(): Promise<void> {
    if (signal?.aborted) return;
    const { done, value } = await reader.read();
    if (done) return;
    buf += decoder.decode(value, { stream: true });
    let sep = buf.indexOf("\n\n");
    while (sep >= 0) {
      const frame = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      onFrame(frame);
      sep = buf.indexOf("\n\n");
    }
    return consumeNext();
  }
  try {
    await consumeNext();
  } finally {
    void reader.cancel().catch(() => {});
  }
}

export async function consumeSse(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: TurnStreamEvent) => void,
  opts: { signal?: AbortSignal } = {}
): Promise<{ ended: boolean }> {
  const { signal } = opts;
  let ended = false;
  try {
    await consumeSseFrames(
      body,
      (frame) => {
        if (isEndFrame(frame)) ended = true;
        const evt = parseFrame(frame);
        if (evt) onEvent(evt);
      },
      opts
    );
  } catch (error) {
    if (!signal?.aborted && (error as Error | null)?.name !== "AbortError")
      throw error;
  }
  return { ended };
}
