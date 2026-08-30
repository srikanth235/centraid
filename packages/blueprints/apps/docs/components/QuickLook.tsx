// THE STAGE (spec §7) — the SHELL only: the document is `QuickLookStage.tsx`,
// the panel `QuickLookInfo.tsx`, the words `document-copy.ts`. ONE action set,
// TWO arrangements: described once as data, laid out twice. Withheld on
// purpose — filmstrip, zoom chip, `Keep this on my device`: no page model.
import { useState } from "react";
import type { ReactNode } from "react";

import { GrantSheet } from "../../_shared/GrantSheet.tsx";
import { KitModal } from "../../_shared/KitModal.tsx";
import { STAGE_ACTIONS } from "../document-copy.ts";
import { fmtBytes, typeMeta } from "../format.ts";
import type { DocsShareHost } from "../grant-audiences.ts";
import { I, STAGE_ICONS } from "../icons.ts";
import { printDoc, printKind, printRefusal } from "../print.ts";
import type { DriveDoc } from "../types.ts";
import { QuickLookInfo } from "./QuickLookInfo.tsx";
import { QuickLookStage } from "./QuickLookStage.tsx";
import { Icon } from "./Shared.tsx";

import styles from "./QuickLook.module.css";

/** `href` makes it an anchor, keeping the browser's save behaviour. */
interface StageAction {
  id: string;
  label: string;
  svg: string;
  onRun?: () => void;
  href?: string;
  download?: string;
  pressed?: boolean;
  disabled?: boolean;
  /** Why it is disabled, ON the control, never in a toast (§6). */
  reason?: string;
  destructive?: boolean;
}

function BarActions({
  actions,
  labelled,
}: {
  actions: readonly StageAction[];
  labelled: boolean;
}) {
  return (
    <div className={styles.actions}>
      {actions.map((action) => {
        const className = `${styles.action} ${action.destructive ? styles.destructive : ""}`;
        const mark = <Icon svg={action.svg} />;
        const label = labelled ? (
          <span className={styles.actionLabel}>{action.label}</span>
        ) : null;
        // Labelled, `title` carries only a disabled control's reason.
        const title = action.reason ?? (labelled ? undefined : action.label);
        if (action.href !== undefined)
          return (
            <a
              key={action.id}
              className={className}
              href={action.href}
              download={action.download}
              aria-label={action.label}
              title={title}
            >
              {mark}
              {label}
            </a>
          );
        return (
          <button
            key={action.id}
            type="button"
            className={className}
            disabled={action.disabled ?? false}
            aria-pressed={action.pressed}
            aria-label={action.label}
            title={title}
            onClick={() => void action.onRun?.()}
          >
            {mark}
            {label}
          </button>
        );
      })}
    </div>
  );
}

/** Never labelled at 390px; names ride on the element. */
function BottomBar({ actions }: { actions: readonly StageAction[] }) {
  return (
    <div className={styles.bottomBar} role="toolbar" aria-label="Document">
      {actions.map((action) => {
        const className = `${styles.bottomAction} ${action.destructive ? styles.destructive : ""}`;
        if (action.href !== undefined)
          return (
            <a
              key={action.id}
              className={className}
              href={action.href}
              download={action.download}
              aria-label={action.label}
              title={action.label}
            >
              <Icon svg={action.svg} />
            </a>
          );
        return (
          <button
            key={action.id}
            type="button"
            className={className}
            disabled={action.disabled ?? false}
            aria-pressed={action.pressed}
            aria-label={action.label}
            title={action.reason ?? action.label}
            onClick={() => void action.onRun?.()}
          >
            <Icon svg={action.svg} />
          </button>
        );
      })}
    </div>
  );
}

export function QuickLook({
  doc,
  rows,
  narrow,
  folderName,
  onClose,
  onStep,
  onToggleStar,
  onRename,
  onTrash,
  shareHost,
}: {
  doc: DriveDoc;
  rows: DriveDoc[];
  /** From this prop, never off a global state class (trap #5). */
  narrow: boolean;
  folderName: (id: string | null | undefined) => string;
  onClose: () => void;
  onStep: (delta: number) => void;
  onToggleStar?: () => void;
  onRename?: () => void;
  onTrash?: () => void;
  /** `null` where the seat has no grant plane: no Share verb. */
  shareHost: DocsShareHost | null;
}) {
  const m = typeMeta(doc.media_type, doc.title);
  const idx = rows.findIndex((d) => d.document_id === doc.document_id);
  // Closed by default: the document is what they came for.
  const [infoOpen, setInfoOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const handleStatus = (message: string): void => shareHost?.onStatus(message);
  const printable = printKind(doc) !== null;

  const star: StageAction | null = onToggleStar
    ? {
        id: "star",
        label: doc.starred ? STAGE_ACTIONS.starred : STAGE_ACTIONS.star,
        svg: STAGE_ICONS.star,
        pressed: doc.starred,
        onRun: onToggleStar,
      }
    : null;
  const download: StageAction = {
    id: "download",
    label: STAGE_ACTIONS.download,
    svg: STAGE_ICONS.download,
    href: doc.content_uri,
    download: doc.title || "file",
  };
  // NO REF: print needs the <img> the stage is ACTUALLY showing (a `blob:`
  // URL, not `doc.content_uri`), which exists only after paint — and a ref in
  // an action object built during render is what the React compiler refuses.
  const handlePrint = (): void => {
    const shown = document.querySelector<HTMLImageElement>(
      "[data-quicklook-body] img"
    );
    printDoc(doc, shown?.src ?? null);
  };
  const print: StageAction = {
    id: "print",
    label: STAGE_ACTIONS.print,
    svg: STAGE_ICONS.print,
    disabled: !printable,
    ...(printable ? {} : { reason: printRefusal(doc) }),
    onRun: handlePrint,
  };
  // A Share the host cannot fulfil is a verb that exists to refuse.
  const share: StageAction | null = shareHost
    ? {
        id: "share",
        label: STAGE_ACTIONS.share,
        svg: STAGE_ICONS.share,
        onRun: () => setShareOpen(true),
      }
    : null;
  const properties: StageAction = {
    id: "properties",
    label: STAGE_ACTIONS.properties,
    svg: STAGE_ICONS.info,
    pressed: infoOpen,
    onRun: () => setInfoOpen((open) => !open),
  };
  const trash: StageAction | null = onTrash
    ? {
        id: "trash",
        label: STAGE_ACTIONS.trash,
        svg: STAGE_ICONS.trash,
        destructive: true,
        onRun: onTrash,
      }
    : null;

  const barActions = [star, download, print, share, properties].filter(
    (a): a is StageAction => a !== null
  );
  const phoneActions = [share, star, properties, download, trash].filter(
    (a): a is StageAction => a !== null
  );

  let body: ReactNode = (
    <QuickLookStage
      doc={doc}
      hasPrev={idx > 0}
      hasNext={idx >= 0 && idx < rows.length - 1}
      onStep={onStep}
    />
  );
  if (infoOpen)
    body = (
      <>
        {body}
        <QuickLookInfo
          doc={doc}
          folderName={folderName}
          onClose={() => setInfoOpen(false)}
          {...(onRename ? { onRename } : {})}
        />
      </>
    );

  return (
    <KitModal
      layer="inline"
      className={styles.quick}
      data={{ "data-narrow": String(narrow) }}
      ariaModal
      label="Quick look"
    >
      {/* The one shared grant sheet; no sharing flow of its own. */}
      {shareHost ? (
        <GrantSheet
          open={shareOpen}
          onClose={() => setShareOpen(false)}
          audiences={shareHost.audiences}
          subject={{
            subjectType: "core.document",
            subjectId: doc.document_id,
            ...(doc.title ? { label: doc.title } : {}),
          }}
          onStatus={handleStatus}
        />
      ) : null}
      <div className={styles.topbar}>
        {/* Close leads the bar: the way out never hides after six verbs. */}
        <button
          type="button"
          className={styles.close}
          aria-label={STAGE_ACTIONS.close}
          onClick={onClose}
        >
          <Icon svg={I.close!} />
        </button>
        {/* Title AND kind, weight, filing — or a member closes it to see. */}
        <div className={styles.heading}>
          <div className={styles.title}>{doc.title || "Untitled"}</div>
          <div className={styles.metaLine}>
            {m.name} · {fmtBytes(doc.byte_size)} · {folderName(doc.folder_id)}
          </div>
        </div>
        {/* THE SPACER MUST NOT FLEX, or it splits the slack with the
            heading and truncates the title. */}
        <span className={styles.spacer} aria-hidden="true" />
        {narrow ? null : <BarActions actions={barActions} labelled />}
      </div>
      <div className={styles.body} data-quicklook-body="">
        {body}
      </div>
      {/* Position in the set, plus the custody fact a row cannot fit. */}
      <p className={styles.status}>
        <span className={styles.statusDot} aria-hidden="true" />
        <span className={styles.statusText}>
          {idx >= 0 ? `${idx + 1} of ${rows.length} · ` : ""}
          {doc.custody_state === "local-only"
            ? "on this device only — the one custody state you can lose something to"
            : "on this gateway and on this device"}
        </span>
      </p>
      {narrow ? <BottomBar actions={phoneActions} /> : null}
    </KitModal>
  );
}
