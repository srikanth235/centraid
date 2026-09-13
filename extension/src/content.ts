/*
 * The Companion's content script: the only code that touches a page (#1020 wave
 * 4 lane extension).
 *
 * ## Why the picker is here and not in the popup
 *
 * v0's popup cannot ask a Locker question and neither can this one: every
 * `locker:*` message is judged by `lockerGestureRefusal` (v0's
 * `assertTopFramePage`), which requires a **top frame with the active tab's own
 * origin** — and a popup has no tab, so it is refused by construction. That is
 * not an accident to work around: the whole point is that a Locker request names
 * the page it is for and the worker can check that claim against the tab the
 * browser says is active. A popup's claim has nothing to check it against.
 *
 * So the picker is drawn in the page, on a **trusted gesture**, and every choice
 * a member makes is a real click on a real element — which is also the only kind
 * of event that reaches [`isTrustedCredentialGesture`]. A page-created event is
 * never authority to reveal, save or generate a secret.
 *
 * ## What this script decides about origins: nothing
 *
 * The worker refuses a subframe and a page that is not the active tab's; the
 * native host filters the candidate list over the promoted spec; the seat matches
 * the row's own stored policy before it unwraps `K`. Three walls, and none of
 * them is in the page's own process — which is the point.
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

interface Candidate {
  readonly item_id: string;
  readonly title: string;
  readonly username?: string | null;
  readonly warning?: boolean;
}

interface FillMaterial {
  value?: string;
  username?: string;
  password?: string;
}

/** The id of the host element the picker lives in. */
export const PICKER_ID = "centraid-companion-picker";

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

async function send<T>(message: unknown): Promise<T> {
  return unwrapEnvelope(await chrome.runtime.sendMessage<T>(message));
}

/** Ask for a fill, put it in the field, then drop it. */
async function fill(target: Element, itemId: string): Promise<void> {
  const material = await send<FillMaterial>({
    type: "locker:fill",
    itemId,
    pageUrl: location.href,
  });
  const fields = fieldsAround(target);
  assign(fields.password, material.value ?? material.password ?? "");
  assign(fields.username, material.username ?? "");
  // THIS PROCESS'S COPY GOES TOO. The worker drops its own on the response; a
  // content script that kept one would be a credential living in the page's own
  // world for as long as the tab is open.
  clearFillMaterial(material);
}

/** Draw the picker beside a field, in a shadow root so page CSS cannot reach it. */
function draw(
  target: HTMLInputElement,
  candidates: readonly Candidate[],
  message?: string
): void {
  document.querySelector(`#${PICKER_ID}`)?.remove();
  const host = document.createElement("div");
  host.id = PICKER_ID;
  host.dataset["count"] = String(candidates.length);
  const shadow = host.attachShadow({ mode: "open" });
  if (message !== undefined) {
    const said = document.createElement("p");
    said.dataset["refusal"] = "true";
    said.textContent = message;
    shadow.append(said);
  }
  for (const candidate of candidates) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset["itemId"] = candidate.item_id;
    button.textContent = candidate.username
      ? `${candidate.title} — ${candidate.username}`
      : candidate.title;
    if (candidate.warning) button.dataset["warning"] = "true";
    button.addEventListener("click", (event) => {
      // A TRUSTED CLICK, or nothing happens.
      if (!isTrustedCredentialGesture(event)) return;
      void fill(target, candidate.item_id)
        .then(() => host.remove())
        .catch((error: unknown) => {
          draw(
            target,
            [],
            error instanceof Error ? error.message : String(error)
          );
        });
    });
    shadow.append(button);
  }
  target.after(host);
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
  "focusin",
  (event) => {
    // A TRUSTED FOCUS. A page that dispatched `focusin` at its own field would
    // otherwise be able to make the Companion ask what logins exist for it.
    if (!isTrustedCredentialGesture(event)) return;
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || target.type !== "password") {
      return;
    }
    void send<Candidate[]>({
      type: "locker:candidates",
      pageUrl: location.href,
    })
      .then((candidates) => {
        if (candidates.length > 0) draw(target, candidates);
      })
      .catch((error: unknown) => {
        draw(
          target,
          [],
          error instanceof Error ? error.message : String(error)
        );
      });
  },
  { capture: true }
);
