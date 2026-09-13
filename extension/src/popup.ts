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

interface Candidate {
  readonly item_id: string;
  readonly title: string;
  readonly username?: string | null;
  readonly warning?: boolean;
}

const state = document.querySelector<HTMLElement>("#state");
const error = document.querySelector<HTMLElement>("#error");
const logins = document.querySelector<HTMLElement>("#logins");
const candidates = document.querySelector<HTMLElement>("#candidates");
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

async function draw(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const status = await send<{ paired?: boolean; product_version?: string }>({
    type: "status",
  });
  if (!status.paired) {
    say("Open Centraid on this computer to use the Companion.");
    return;
  }
  say(`Connected to Centraid ${status.product_version ?? ""}`.trim());
  if (capture) capture.hidden = false;

  if (!tab?.url) return;
  const found = await send<Candidate[]>({
    type: "locker:candidates",
    pageUrl: tab.url,
  });
  if (found.length === 0 || !candidates || !logins) return;
  logins.hidden = false;
  for (const candidate of found) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = candidate.username
      ? `${candidate.title} — ${candidate.username}`
      : candidate.title;
    if (candidate.warning) button.dataset["warning"] = "true";
    button.addEventListener("click", () => {
      // THE FILL IS THE WORKER'S. The popup asks and never receives the
      // material: the worker hands it to the content script on the page and
      // drops its own copy (`HostLink.fillInto`).
      void send({
        type: "locker:fill",
        itemId: candidate.item_id,
        pageUrl: tab.url,
      })
        .then(() => window.close())
        .catch(fail);
    });
    item.append(button);
    candidates.append(item);
  }
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
