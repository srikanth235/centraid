// Anchored popover menu (Docs' openPopover, shared). One popover at a time:
// opening a second closes the first, and every app's layered Escape handler
// asks `isPopoverOpen()` before claiming the key.

import { el, h } from "./dom.js";

let popoverEl: HTMLElement | null = null;
let popoverCleanup: (() => void) | null = null;

/** Whether a kit popover is open — layered Escape handlers ask before closing. */
export function isPopoverOpen(): boolean {
  return popoverEl != null;
}

/** Close the open kit popover (no-op when none is open). */
export function closePopover(): void {
  if (!popoverEl) return;
  popoverCleanup?.();
  popoverEl.remove();
  popoverEl = null;
  popoverCleanup = null;
}

/** Open a popover anchored to `anchor`: right-aligned, flips above when out of
 *  viewport, closes on outside click / scroll / resize / Escape. Options:
 *  `focus` first field; `className` width/spacing override; `role` default
 *  menu; `onClose` runs once on any close path (teardown point). */
export function openPopover(
  anchor: HTMLElement,
  build: (box: HTMLElement) => void,
  {
    focus = false,
    className,
    role = "menu",
    onClose,
  }: {
    focus?: boolean;
    className?: string;
    role?: string;
    onClose?: () => void;
  } = {}
): void {
  closePopover();
  const box = h("div", {
    class: className ? `kit-popover ${className}` : "kit-popover",
    role,
  });
  build(box);
  box.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Escape") {
      e.stopPropagation();
      closePopover();
    }
  });
  document.body.appendChild(box);
  const rect = anchor.getBoundingClientRect();
  const left = Math.max(
    8,
    Math.min(
      rect.right - box.offsetWidth,
      window.innerWidth - box.offsetWidth - 8
    )
  );
  let top = rect.bottom + 4;
  if (top + box.offsetHeight > window.innerHeight - 8)
    top = Math.max(8, rect.top - box.offsetHeight - 4);
  box.style.left = `${left}px`;
  box.style.top = `${top}px`;
  const onDoc = (e: Event): void => {
    const target = e.target as Node;
    if (!box.contains(target) && !anchor.contains(target)) closePopover();
  };
  const onScroll = (e: Event): void => {
    // Scroll inside the popover or the kit's @-mention list must not close it.
    if (box.contains(e.target as Node)) return;
    if (e.target instanceof Element && e.target.closest?.(".kit-mention-pop"))
      return;
    closePopover();
  };
  const timer = setTimeout(() => document.addEventListener("click", onDoc), 0);
  window.addEventListener("resize", closePopover);
  window.addEventListener("scroll", onScroll, true);
  popoverEl = box;
  popoverCleanup = () => {
    clearTimeout(timer);
    document.removeEventListener("click", onDoc);
    window.removeEventListener("resize", closePopover);
    window.removeEventListener("scroll", onScroll, true);
    onClose?.();
  };
  if (focus)
    box.querySelector<HTMLElement>("input, select, textarea, button")?.focus();
}

/** One menu row for `openPopover`: label + optional icon, dot, danger tone. */
export function popItem(
  label: string,
  onClick: (event: MouseEvent) => void,
  {
    danger = false,
    disabled = false,
    iconHtml = null,
    dotColor = null,
    /** Trailing slot: current-choice ✓ or shortcut. Trailing on purpose — a
     *  leading dot would indent every other row past it. */
    trailing = null,
  }: {
    danger?: boolean;
    disabled?: boolean;
    iconHtml?: string | null;
    dotColor?: string | null;
    trailing?: string | null;
  } = {}
): HTMLButtonElement {
  const btn = h("button", {
    type: "button",
    class: `kit-popover-item${danger ? " danger" : ""}`,
    role: "menuitem",
    disabled: disabled || undefined,
    onclick: onClick,
  }) as HTMLButtonElement;
  if (iconHtml) btn.appendChild(el(iconHtml));
  if (dotColor)
    btn.appendChild(
      h("span", { class: "kit-dotmini", style: `background:${dotColor};` })
    );
  // The label takes the slack so the trailing slot sits on the far edge.
  btn.appendChild(h("span", { class: "kit-popover-label" }, label));
  if (trailing)
    btn.appendChild(h("span", { class: "kit-popover-key" }, trailing));
  return btn;
}
