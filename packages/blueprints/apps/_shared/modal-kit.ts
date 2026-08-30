// `showModal()`, never the `open` attribute — inert page, Escape, top layer.
// The kit hands focus back to the opener; the platform does not.

export type FocusReturn = () => void;

/** Call the returned closer once, when the modal stops being open. */
export function openOnTopLayer(dialog: HTMLDialogElement): FocusReturn {
  const opener = dialog.ownerDocument.activeElement;
  // `showModal` is absent in a non-DOM test host.
  if (!dialog.open) dialog.showModal?.();
  return () => {
    if (dialog.open) dialog.close();
    if (opener instanceof HTMLElement) opener.focus();
  };
}

export function onModalDismissed(
  dialog: HTMLDialogElement,
  dismissed: () => void
): () => void {
  dialog.addEventListener("close", dismissed);
  return () => dialog.removeEventListener("close", dismissed);
}
