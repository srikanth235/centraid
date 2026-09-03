export type FocusReturn = () => void;

export function openOnTopLayer(dialog: HTMLDialogElement): FocusReturn {
  const opener = dialog.ownerDocument.activeElement;
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
