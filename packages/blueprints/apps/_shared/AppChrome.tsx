import type { ReactNode } from "react";

import { chromeClass } from "./chrome-kit.ts";
import { VAULT_DENIED_TITLE } from "./shared-copy.ts";
import { VaultAccessButton } from "./VaultAccessButton.tsx";

/** `onFocusRefresh` reads the id to bypass its 30s throttle on a
 *  denied→recovered flip; without it no read follows a grant (#505). */
export function ConsentBanner({
  message,
  className,
  title = VAULT_DENIED_TITLE,
}: {
  message: string;
  className?: string;
  title?: string;
}): ReactNode {
  return (
    <div
      id="consentBanner"
      className={className ? `kit-banner ${className}` : "kit-banner"}
    >
      <strong>{title}</strong> <span>{message}</span>
      <VaultAccessButton />
    </div>
  );
}

/** Written imperatively by `logic.ts`; never reconciled by React. */
export function NoticeBanner({ className }: { className?: string }): ReactNode {
  return (
    <output
      id="noticeBanner"
      className={
        className ? `kit-banner notice ${className}` : "kit-banner notice"
      }
      aria-live="polite"
      hidden
    />
  );
}

/** Mount point for the shell's Ask panel. */
export function AskMount({ className }: { className?: string }): ReactNode {
  return <div className={className} data-ask-mount />;
}

export function ChromeToolbar({
  label,
  className,
  selecting,
  children,
}: {
  label: string;
  className?: string;
  selecting?: boolean;
  children: ReactNode;
}): ReactNode {
  if (!children) return null;
  return (
    <div
      className={className}
      {...(selecting === undefined
        ? {}
        : { "data-selecting": String(selecting) })}
      role="toolbar"
      aria-label={label}
    >
      {children}
    </div>
  );
}

/** DECLARED, not walked for: `useScrollHost` reads this stamp. */
export function ScrollHost({
  id,
  className,
  data,
  loading = false,
  skeletonClassName,
  skeleton,
  children,
}: {
  id?: string;
  className?: string;
  data?: Readonly<Record<string, string>>;
  loading?: boolean;
  skeletonClassName?: string;
  skeleton?: ReactNode;
  children: ReactNode;
}): ReactNode {
  return (
    <div
      {...(id === undefined ? {} : { id })}
      className={className}
      data-scroll-host=""
      {...data}
    >
      {loading ? (
        <div className={skeletonClassName} aria-hidden="true">
          {skeleton}
        </div>
      ) : (
        children
      )}
    </div>
  );
}

export function DropOverlay({
  id,
  className,
  visible,
  children,
}: {
  id?: string;
  className?: string;
  visible: boolean;
  children: ReactNode;
}): ReactNode {
  return (
    <div
      {...(id === undefined ? {} : { id })}
      className={chromeClass("kit-drop", className)}
      aria-hidden="true"
      hidden={!visible}
    >
      <div className="kit-drop-card">{children}</div>
    </div>
  );
}
