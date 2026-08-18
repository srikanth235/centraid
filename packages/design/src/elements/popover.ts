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

/**
 * Open a popover anchored to `anchor`: right-aligned, flips above when the
 * viewport runs out, closes on outside click / scroll / resize / Escape.
 * `build` receives the popover box and appends its content (see `popItem`).
 * Options: `focus` moves focus to the first field/button inside (form
 * popovers); `className` adds an app class for width/spacing overrides;
 * `role` overrides the default `menu` (use `dialog` for form popovers);
 * `onClose` runs once when the popover closes by any path (Escape, outside
 * click, scroll, resize, programmatic) — the teardown point for popovers
 * that attach document-level helpers.
 */
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
    // Scrolling inside the popover — or inside the kit's own body-level
    // @-mention list — must not close the popover hosting it.
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
    /**
     * The TRAILING slot at the end of the row — a `✓` on the option a menu of
     * choices is currently in, or the keyboard shortcut for a verb.
     *
     * It is the far edge on purpose. A menu that marks its current choice with
     * a leading dot indents every OTHER row's text past it, so five options
     * line up along an edge that only exists because one of them is chosen; a
     * trailing mark leaves the labels on one edge and answers "which one is
     * on" at the other. Ticks and shortcuts share the slot because they are
     * the same thing — what this row is, said after what it does.
     */
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
  // The label takes the slack so the trailing slot sits on the far edge; with
  // no trailing slot it is an ordinary flex child and nothing moves.
  btn.appendChild(h("span", { class: "kit-popover-label" }, label));
  if (trailing)
    btn.appendChild(h("span", { class: "kit-popover-key" }, trailing));
  return btn;
}
