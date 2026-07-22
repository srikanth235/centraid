// The inline "Ask your <app>" panel — the shell-side replacement for the served
// kit.js ask IIFE (which is suppressed inline; see suppress-served-ask.ts). It
// mounts against the gateway conversation surface: turns stream through
// `streamTurn(appId, …, register:'ask')`, and any write the agent parks is
// surfaced as an Approve/Discard consent card driven by the shell's
// `vaultParked` / `confirmVaultParked`.
//
// Strictly online-only and lazy: `installInlineAsk` performs NO network on the
// mount path (it only builds DOM + click handlers), so the route host can fire
// it without awaiting and first paint never blocks on it. Everything that talks
// to the gateway happens on user interaction.
//
// Scope note (issue #505 pilot): this is the single-conversation core — send,
// stream, parked-write consent. Conversation history, the model picker and turn
// attachments (all present in the served panel) are follow-ups for the rollout.
import {
  confirmVaultParked,
  createConversation,
  streamTurn,
  vaultParked,
  type TurnStreamEvent,
} from '../../gateway-client.js';
import type { InlineKitAsk } from '@centraid/blueprints/apps/inline-types';

export interface InstallInlineAskOptions {
  /** The app root element; the panel mounts into its `[data-ask-mount]`. */
  appRoot: HTMLElement;
  appId: string;
  config: InlineKitAsk;
}

function elFrom(html: string): HTMLElement {
  const template = document.createElement('template');
  template.innerHTML = html.trim();
  return template.content.firstElementChild as HTMLElement;
}

/** Install the inline ask affordance; returns a teardown. */
export function installInlineAsk(options: InstallInlineAskOptions): () => void {
  const { appRoot, appId, config } = options;
  const mount = appRoot.querySelector<HTMLElement>('[data-ask-mount]');
  if (!mount) return () => {};

  const button = elFrom(
    '<button type="button" class="kit-ask-btn"><span class="kit-spark">✦</span> Ask</button>',
  );
  const panel = elFrom(
    '<div class="kit-ask-panel" role="dialog" aria-label="Ask" hidden>' +
      '<div class="kit-ask-log" aria-live="polite"></div>' +
      '<div class="kit-ask-pending" hidden></div>' +
      '<form class="kit-ask-compose"><textarea class="kit-ask-input" rows="2"></textarea>' +
      '<button type="submit" class="kit-ask-send">Send</button></form>' +
      '</div>',
  );
  const log = panel.querySelector<HTMLElement>('.kit-ask-log')!;
  const pending = panel.querySelector<HTMLElement>('.kit-ask-pending')!;
  const form = panel.querySelector<HTMLFormElement>('.kit-ask-compose')!;
  const input = panel.querySelector<HTMLTextAreaElement>('.kit-ask-input')!;
  if (config.placeholder) input.placeholder = config.placeholder;

  mount.appendChild(button);
  appRoot.appendChild(panel);

  let conversationId: string | undefined;
  let controller: AbortController | undefined;
  let disposed = false;

  const line = (cls: string, text: string): HTMLElement => {
    const el = document.createElement('div');
    el.className = cls;
    el.textContent = text;
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
    return el;
  };

  const refreshParked = async (): Promise<void> => {
    try {
      const entries = (await vaultParked()).filter((entry) => entry.callerKind === 'app');
      pending.innerHTML = '';
      pending.hidden = entries.length === 0;
      for (const entry of entries) {
        const card = elFrom(
          '<div class="kit-ask-consent"><span></span>' +
            '<button type="button" data-approve="1">Approve</button>' +
            '<button type="button" data-approve="0">Discard</button></div>',
        );
        card.querySelector('span')!.textContent = entry.command ?? 'Proposed change';
        for (const btn of card.querySelectorAll<HTMLButtonElement>('button')) {
          btn.addEventListener('click', () => {
            void confirmVaultParked({
              approve: btn.dataset.approve === '1',
              invocationId: entry.invocationId,
            })
              .then(() => refreshParked())
              .catch(() => undefined);
          });
        }
        pending.appendChild(card);
      }
    } catch {
      /* offline / no vault plane — leave the pending strip as-is */
    }
  };

  const onEvent =
    (assistantEl: { el: HTMLElement | null }) =>
    (event: TurnStreamEvent): void => {
      if (event.type === 'assistant.delta' || event.type === 'final') {
        const text = event.type === 'final' ? event.text : event.delta;
        if (!assistantEl.el) assistantEl.el = line('kit-ask-a', '');
        assistantEl.el.textContent = (assistantEl.el.textContent ?? '') + text;
        log.scrollTop = log.scrollHeight;
      } else if (event.type === 'error') {
        line('kit-ask-err', event.message);
      }
    };

  const send = async (message: string): Promise<void> => {
    line('kit-ask-q', message);
    if (!conversationId) {
      conversationId = (await createConversation(appId).catch(() => undefined))?.id;
      if (!conversationId) {
        line('kit-ask-err', 'Ask is unavailable — the gateway is unreachable.');
        return;
      }
    }
    controller = new AbortController();
    const assistantEl = { el: null as HTMLElement | null };
    try {
      await streamTurn(
        appId,
        { conversationId, message, register: 'ask' },
        onEvent(assistantEl),
        controller.signal,
      );
    } catch (error) {
      line('kit-ask-err', error instanceof Error ? error.message : String(error));
    }
    await refreshParked();
  };

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const message = input.value.trim();
    if (!message) return;
    input.value = '';
    void send(message);
  });

  button.addEventListener('click', () => {
    const opening = panel.hidden;
    panel.hidden = !opening;
    if (opening) {
      input.focus();
      void refreshParked();
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
