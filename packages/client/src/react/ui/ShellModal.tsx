// Twin of `apps/_shared/KitModal.tsx`: one `modal-kit.ts` law, one wrapper per
// TypeScript program (`KIT_MODAL_OWNERS`).
import { useEffect, useRef } from "react";
import type { CSSProperties, JSX, ReactNode, RefObject } from "react";

import {
  onModalDismissed,
  openOnTopLayer,
} from "@centraid/blueprints/apps/_shared/modal-kit";

export interface ShellModalProps {
  layer: "top" | "inline";
  open?: boolean;
  className?: string;
  label?: string;
  labelledBy?: string;
  ariaModal?: boolean;
  id?: string;
  focusable?: boolean;
  data?: Readonly<Record<string, string>>;
  style?: CSSProperties;
  dialogRef?: RefObject<HTMLDialogElement | null>;
  onDismiss?: () => void;
  children?: ReactNode;
}

export default function ShellModal({
  layer,
  open = true,
  className,
  label,
  labelledBy,
  ariaModal,
  id,
  focusable,
  data,
  style,
  dialogRef,
  onDismiss,
  children,
}: ShellModalProps): JSX.Element {
  const ref = useRef<HTMLDialogElement | null>(null);
  // Through a ref: an inline arrow would reopen the dialog every render.
  const dismissRef = useRef(onDismiss);
  useEffect(() => {
    dismissRef.current = onDismiss;
  }, [onDismiss]);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog || layer !== "top" || !open) return;
    const restore = openOnTopLayer(dialog);
    const unsubscribe = onModalDismissed(dialog, () => dismissRef.current?.());
    return () => {
      unsubscribe();
      restore();
    };
  }, [layer, open]);

  return (
    <dialog
      ref={(node) => {
        ref.current = node;
        if (dialogRef) dialogRef.current = node;
      }}
      // `top` must NOT carry `open`, or it never reaches the platform layer.
      {...(layer === "inline" ? { open: true } : {})}
      {...(id === undefined ? {} : { id })}
      {...(className === undefined ? {} : { className })}
      {...(label === undefined ? {} : { "aria-label": label })}
      {...(labelledBy === undefined ? {} : { "aria-labelledby": labelledBy })}
      {...(ariaModal === undefined
        ? {}
        : { "aria-modal": ariaModal ? ("true" as const) : ("false" as const) })}
      {...(focusable ? { tabIndex: -1 } : {})}
      {...(style === undefined ? {} : { style })}
      {...data}
    >
      {children}
    </dialog>
  );
}
