import { act } from "react";

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

export function button(el: HTMLElement, label: string): HTMLButtonElement {
  return [...el.querySelectorAll("button")].find(
    (b) => b.textContent === label
  ) as HTMLButtonElement;
}
