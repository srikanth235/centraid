import type { InlineKitAsk } from "@centraid/blueprints/apps/inline-types";

// The inline "Ask your <app>" panel — the shell-side replacement for the served
// kit.ts ask IIFE (which is suppressed inline; see suppress-served-ask.ts). It
// mounts against the gateway conversation surface: turns stream through
// `streamTurn(appId, …, register:'ask')`. Any write the agent parks belongs to
// the canonical Notifications; this conversational surface never forks decision state.
//
// Strictly online-only and lazy: `installInlineAsk` performs NO network on the
// mount path (it only builds DOM + click handlers), so the route host can fire
// it without awaiting and first paint never blocks on it. Everything that talks
// to the gateway happens on user interaction.
//
// Scope note (issue #505 pilot): this is the single-conversation core — send,
// stream. Conversation history, the model picker and turn
// attachments (all present in the served panel) are follow-ups for the rollout.
import { createConversation, streamTurn } from "../../gateway-client.js";
import type { TurnStreamEvent } from "../../gateway-client.js";
import {
  providerConsentWire,
  withProviderConsent,
} from "../providerConsent.js";
import { openConfirm } from "../shell/confirm.js";

export interface InstallInlineAskOptions {
  /** The app root element; the panel mounts into its `[data-ask-mount]`. */
  appRoot: HTMLElement;
  appId: string;
  config: InlineKitAsk;
}

function elFrom(html: string): HTMLElement {
  const template = document.createElement("template");
  template.innerHTML = html.trim();
  return template.content.firstElementChild as HTMLElement;
}

/** Install the inline ask affordance; returns a teardown. */
export function installInlineAsk(options: InstallInlineAskOptions): () => void {
  const { appRoot, appId, config } = options;
  const mount = appRoot.querySelector<HTMLElement>("[data-ask-mount]");
  if (!mount) return () => {};

  const button = elFrom(
    '<button type="button" class="kit-ask-btn"><span class="kit-spark">✦</span> Ask</button>'
  );
  const panel = elFrom(
    '<div class="kit-ask-panel" role="dialog" aria-label="Ask" hidden>' +
      '<div class="kit-ask-log" aria-live="polite"></div>' +
      '<form class="kit-ask-compose"><textarea class="kit-ask-input" rows="2"></textarea>' +
      '<button type="submit" class="kit-ask-send">Send</button></form>' +
      "</div>"
  );
  const log = panel.querySelector<HTMLElement>(".kit-ask-log")!;
  const form = panel.querySelector<HTMLFormElement>(".kit-ask-compose")!;
  const input = panel.querySelector<HTMLTextAreaElement>(".kit-ask-input")!;
  if (config.placeholder) input.placeholder = config.placeholder;

  mount.appendChild(button);
  appRoot.appendChild(panel);

  let conversationId: string | undefined;
  let controller: AbortController | undefined;
  let disposed = false;

  const line = (cls: string, text: string): HTMLElement => {
    const el = document.createElement("div");
    el.className = cls;
    el.textContent = text;
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
    return el;
  };

  const onEvent =
    (assistantEl: { el: HTMLElement | null }) =>
    (event: TurnStreamEvent): void => {
      if (event.type === "assistant.delta" || event.type === "final") {
        const text = event.type === "final" ? event.text : event.delta;
        if (!assistantEl.el) assistantEl.el = line("kit-ask-a", "");
        assistantEl.el.textContent = (assistantEl.el.textContent ?? "") + text;
        log.scrollTop = log.scrollHeight;
      } else if (event.type === "error") {
        line("kit-ask-err", event.message);
      }
    };

  const send = async (message: string): Promise<void> => {
    line("kit-ask-q", message);
    if (!conversationId) {
      conversationId = (await createConversation(appId).catch(() => undefined))
        ?.id;
      if (!conversationId) {
        line("kit-ask-err", "Ask is unavailable — the gateway is unreachable.");
        return;
      }
    }
    const activeConversationId = conversationId;
    controller = new AbortController();
    const signal = controller.signal;
    const assistantEl = { el: null as HTMLElement | null };
    try {
      // Accumulated across this send: a consent-gated failover asks for a
      // second provider, and resending without the first loops forever (#567).
      let approvedProviders: string[] = [];
      // Every consent changes the provider credential wire for the next turn,
      // so retries are one ordered conversation state machine.
      const streamWithConsent = async (): Promise<void> => {
        let requiredProvider: string | undefined;
        const providerConsent = providerConsentWire(approvedProviders);
        await streamTurn(
          appId,
          {
            conversationId: activeConversationId,
            message,
            register: "ask",
            ...(providerConsent === undefined ? {} : { providerConsent }),
          },
          (event) => {
            if (event.type === "consent.required")
              requiredProvider = event.provider;
            else onEvent(assistantEl)(event);
          },
          signal
        );
        const provider = requiredProvider;
        if (!provider) return;
        // Inline apps mount into the SHELL document (the iframe is builder-only,
        // issue #505), so the shell's own confirm dialog is reachable here.
        const approved = await openConfirm({
          confirmLabel: "Allow provider",
          title: `Send to ${provider}?`,
          message: `Allow this conversation to be sent to ${provider}? This can include vault tool results.`,
        });
        if (!approved) {
          line("kit-ask-note", `Nothing was sent to ${provider}.`);
          return;
        }
        approvedProviders = withProviderConsent(approvedProviders, provider);
        return streamWithConsent();
      };
      await streamWithConsent();
    } catch (error) {
      line(
        "kit-ask-err",
        error instanceof Error ? error.message : String(error)
      );
    }
  };

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const message = input.value.trim();
    if (!message) return;
    input.value = "";
    void send(message);
  });

  button.addEventListener("click", () => {
    const opening = panel.hidden;
    panel.hidden = !opening;
    if (opening) {
      input.focus();
    }
  });

  return () => {
    if (disposed) return;
    disposed = true;
    controller?.abort();
    button.remove();
    panel.remove();
  };
}
