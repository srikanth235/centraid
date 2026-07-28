/**
 * DOM helpers shared by the screen tests.
 *
 * `setValue` exists because assigning `el.value` directly is invisible to
 * React: React installs its own `value` setter on the element instance and
 * tracks the last value it wrote, so a plain assignment is treated as an echo
 * of React's own render and the change event is swallowed. Going through the
 * prototype's setter updates the DOM without touching React's tracker, so the
 * subsequent `input` event reads as a genuine user edit.
 *
 * Ten-odd screen tests carry their own copy of this; they should migrate here
 * (issue #573 follow-up) rather than each maintaining a subtly different one.
 */

import { act } from "react";

/** Type into a controlled input/textarea the way a user would. */
export function setValue(
  el: HTMLInputElement | HTMLTextAreaElement,
  value: string
): void {
  const proto =
    el.tagName === "TEXTAREA"
      ? globalThis.HTMLTextAreaElement.prototype
      : globalThis.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  act(() => {
    setter?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** The button whose visible label is exactly `label`. */
export function button(el: HTMLElement, label: string): HTMLButtonElement {
  return [...el.querySelectorAll("button")].find(
    (b) => b.textContent === label
  ) as HTMLButtonElement;
}
