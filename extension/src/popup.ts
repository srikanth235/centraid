/*
 * The Companion popup: a surface over the worker's one door (#1020 wave 4 lane
 * extension).
 *
 * Every decision is in `popup-core.ts` and `host-link.ts`; this file is the DOM.
 * It talks to the worker with `chrome.runtime.sendMessage` and never opens a
 * native port itself — one port per browser, held by the worker, is what makes
 * the badge push and the idle close possible at all.
 */

import { errorText, unwrapEnvelope } from "./popup-core.js";
import type { CompanionEnvelope } from "./popup-core.js";

declare const chrome: {
  runtime: {
    sendMessage: <T>(message: unknown) => Promise<CompanionEnvelope<T>>;
  };
  tabs: {
    query: (query: {
      active: boolean;
      currentWindow: boolean;
    }) => Promise<{ id?: number; url?: string; title?: string }[]>;
  };
};

const state = document.querySelector<HTMLElement>("#state");
const error = document.querySelector<HTMLElement>("#error");
const capture = document.querySelector<HTMLElement>("#capture");

function say(text: string): void {
  if (state) state.textContent = text;
}

function fail(reason: unknown): void {
  if (!error) return;
  error.textContent = errorText(reason);
  error.hidden = false;
}

async function send<T>(message: unknown): Promise<T> {
  return unwrapEnvelope(await chrome.runtime.sendMessage<T>(message));
}

/*
 * THE POPUP ASKS NO LOCKER QUESTION, and that is a boundary rather than an
 * omission. Every `locker:*` message is judged against the ACTIVE TAB's own
 * origin (`page-origin.ts`, v0's `assertTopFramePage`), and a popup has no tab —
 * so its claim about which page it is asking for has nothing to check it
 * against. v0's popup does not ask either; the content script draws the picker
 * in the page, where a click is a trusted gesture and the origin is the page's.
 */
async function draw(): Promise<void> {
  const status = await send<{ paired?: boolean; product_version?: string }>({
    type: "status",
  });
  if (!status.paired) {
    say("Open Centraid on this computer to use the Companion.");
    return;
  }
  say(`Connected to Centraid ${status.product_version ?? ""}`.trim());
  if (capture) capture.hidden = false;
}

async function captureWith(type: string): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) return;
  await send({
    type,
    capture: { title: tab.title ?? tab.url, url: tab.url },
  });
  window.close();
}

document
  .querySelector("#capture-task")
  ?.addEventListener(
    "click",
    () => void captureWith("capture:task").catch(fail)
  );
document
  .querySelector("#capture-note")
  ?.addEventListener(
    "click",
    () => void captureWith("capture:note").catch(fail)
  );

void draw().catch(fail);
