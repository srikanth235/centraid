import { useEffect, useRef } from "react";
import type { CSSProperties, ReactNode, RefObject } from "react";

import { onModalDismissed, openOnTopLayer } from "./modal-kit.ts";

export interface KitModalProps {
  layer: "top" | "inline";
  open?: boolean;
  className?: string;
  label?: string;
  labelledBy?: string;
  ariaModal?: boolean;
  id?: string;
  hidden?: boolean;
  focusable?: boolean;
  data?: Readonly<Record<string, string>>;
  style?: CSSProperties;
  dialogRef?: RefObject<HTMLDialogElement | null>;
  onDismiss?: () => void;
  children?: ReactNode;
}

export function KitModal({
  layer,
  open = true,
  className,
  label,
  labelledBy,
  ariaModal,
  id,
  hidden,
  focusable,
  data,
  style,
  dialogRef,
  onDismiss,
  children,
}: KitModalProps): ReactNode {
  const ref = useRef<HTMLDialogElement | null>(null);
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
      {...(layer === "inline" ? { open: true } : {})}
      {...(id === undefined ? {} : { id })}
      {...(className === undefined ? {} : { className })}
      {...(label === undefined ? {} : { "aria-label": label })}
      {...(labelledBy === undefined ? {} : { "aria-labelledby": labelledBy })}
      {...(ariaModal === undefined
        ? {}
        : { "aria-modal": ariaModal ? ("true" as const) : ("false" as const) })}
      {...(focusable ? { tabIndex: -1 } : {})}
      {...(hidden ? { hidden: true } : {})}
      {...(style === undefined ? {} : { style })}
      {...data}
    >
      {children}
    </dialog>
  );
}
