/*
 * The Companion's content script: the only code that touches a page (#1020 wave
 * 4 lane extension).
 *
 * It holds no credential longer than the assignment takes and asks for one only
 * on a **trusted gesture** — a page-created event is never authority to reveal,
 * save or generate a secret (`credential-gesture.ts`, v0's rule). Everything it
 * asks for goes through the worker, which is the only holder of a native port.
 *
 * What it does NOT do is decide anything about origins. The worker refuses a
 * subframe and a page that is not the active tab's; the native host filters the
 * candidate list; the seat matches the row's own policy before it unwraps. Three
 * walls, and none of them is in the page's own process — which is the point.
 */

import {
  clearFillMaterial,
  isTrustedCredentialGesture,
  passwordForSave,
} from "./credential-gesture.js";
import { randomPassword, unwrapEnvelope } from "./popup-core.js";
import type { CompanionEnvelope } from "./popup-core.js";

declare const chrome: {
  runtime: {
    sendMessage: <T>(message: unknown) => Promise<CompanionEnvelope<T>>;
  };
};

interface FillMaterial {
  value?: string;
  username?: string;
  password?: string;
}

/** The login fields of the form this element is in. */
export function fieldsAround(element: Element): {
  username?: HTMLInputElement;
  password?: HTMLInputElement;
  newPassword?: HTMLInputElement;
} {
  const form = element.closest("form") ?? document;
  const inputs = [...form.querySelectorAll("input")];
  return {
    username: inputs.find(
      (input) =>
        input.type === "email" ||
        input.type === "text" ||
        input.autocomplete === "username"
    ),
    password: inputs.find(
      (input) =>
        input.type === "password" && input.autocomplete !== "new-password"
    ),
    newPassword: inputs.find(
      (input) =>
        input.type === "password" && input.autocomplete === "new-password"
    ),
  };
}

function assign(input: HTMLInputElement | undefined, value: string): void {
  if (!input || !value) return;
  input.value = value;
  // The page's own listeners run, so a framework-controlled field keeps its
  // state in step with the DOM.
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

/** Ask for a fill and put it in the field, then drop it. */
async function fill(target: Element, itemId: string): Promise<void> {
  const material = unwrapEnvelope(
    await chrome.runtime.sendMessage<FillMaterial>({
      type: "locker:fill",
      itemId,
      pageUrl: location.href,
    })
  );
  const fields = fieldsAround(target);
  assign(fields.password, material.value ?? material.password ?? "");
  assign(fields.username, material.username ?? "");
  // THIS PROCESS'S COPY GOES TOO. The worker drops its own on the response; a
  // page's content script that kept one would be a credential living in the
  // page's own world for as long as the tab is open.
  clearFillMaterial(material);
}

/** Offer a generated password on a signup form, on a trusted gesture only. */
export function generateInto(
  target: Element,
  event: Event
): string | undefined {
  if (!isTrustedCredentialGesture(event)) return undefined;
  const fields = fieldsAround(target);
  const generated = randomPassword();
  assign(fields.newPassword ?? fields.password, generated);
  return passwordForSave({
    ...(fields.password ? { password: { value: fields.password.value } } : {}),
    ...(fields.newPassword ? { newPassword: { value: generated } } : {}),
  });
}

document.addEventListener(
  "centraid:fill",
  (event) => {
    if (!isTrustedCredentialGesture(event)) return;
    const detail = (event as CustomEvent<{ itemId?: string }>).detail;
    const target =
      event.target instanceof Element ? event.target : document.body;
    if (typeof detail?.itemId === "string") {
      void fill(target, detail.itemId).catch(() => undefined);
    }
  },
  { capture: true }
);
