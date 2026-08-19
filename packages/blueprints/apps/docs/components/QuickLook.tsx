// THE STAGE (#quickRoot root) — Docs spec §7's `docsStage`.
//
// The second tenant of the product's one theater ground: `--stage` /
// `--on-stage` / `--stage-line`, the SAME literals in both themes, and the
// same surface Photos stands its lightbox on. Docs uses it for the kinds it
// renders AS MEDIA — a PDF, an image, audio, video — and for text it lays that
// text on paper at the reading measure, because that is what the app's
// declared register promises.
//
// WHAT LIVES WHERE, on the seam Photos already cut: this file is the SHELL —
// which regions exist, and what the bar carries. The document itself and the
// two steps beside it are in `QuickLookStage.tsx`; the properties panel is in
// `QuickLookInfo.tsx`; every word either of them says is in `document-copy.ts`.
//
// ONE ACTION SET, TWO ARRANGEMENTS (the handoff's `acts` and `bottomActs`).
// The desktop bar and the phone's bottom bar carry the same names and the same
// marks; what differs is where the row sits. So each action is described ONCE,
// as data, and laid out twice — rather than two lists drifting apart on what a
// verb is called or which of them a phone gets.
//
// WITHHELD, and named here so nobody re-derives the omission as an oversight:
// the page filmstrip and the zoom chip. Both step through the pages of ONE
// document, and neither this seat nor the `<iframe>` a PDF renders in exposes
// a page model — the browser's own viewer owns paging and zoom inside that
// frame, and drawing a second set of controls over it that could not drive it
// would be two controls for one job, one of them fake. The handoff's `Keep
// this on my device` status action goes with them: there is no
// fetch-the-original verb on this seat to put behind it.
import { useState } from "react";
import type { ReactNode } from "react";

import { GrantSheet } from "../../_shared/GrantSheet.tsx";
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

/** One action, described once. `href` makes it an anchor — Download is a real
 *  link, so it keeps the browser's own save behaviour and its context menu. */
interface StageAction {
  id: string;
  label: string;
  svg: string;
  onRun?: () => void;
  href?: string;
  download?: string;
  pressed?: boolean;
  disabled?: boolean;
  /** Why it is disabled, ON the control — never in a toast (§6). */
  reason?: string;
  destructive?: boolean;
}

/** The bar's row: outlined stage buttons, labelled unless the pane is narrow.
 *  A control that cannot fire is DISABLED and says why, rather than firing and
 *  apologising. */
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
        // An icon-only control names itself twice on purpose: `aria-label` for
        // a screen reader, `title` for a pointer that hovers and wonders.
        // Labelled, the visible text IS the name, so `title` only carries the
        // reason a disabled control cannot fire.
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

/** The phone's bottom bar: 56px targets where a thumb is. Never labelled — at
 *  390px there is no width for five words — so every one of them carries its
 *  name on the element instead. */
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
  /** The compact form factor — the actions leave the bar for a bottom row
   *  where a thumb is, and the properties panel becomes a pointer affordance
   *  the pane has no width to hold beside the document. Carried as a prop and
   *  stamped on this component's own dialog, never read off a global state
   *  class another module owns (trap #5). */
  narrow: boolean;
  folderName: (id: string | null | undefined) => string;
  onClose: () => void;
  onStep: (delta: number) => void;
  /** Omitted where the shelf cannot write (trash) — as are rename and trash. */
  onToggleStar?: () => void;
  onRename?: () => void;
  onTrash?: () => void;
  /** The roster and status line Share needs, or `null` where this seat has no
   *  grant plane — the stage then draws no Share verb at all. */
  shareHost: DocsShareHost | null;
}) {
  const m = typeMeta(doc.media_type, doc.title);
  const idx = rows.findIndex((d) => d.document_id === doc.document_id);
  // Closed by default: the document is what the member came for, and a panel
  // that opens itself takes a third of the stage to answer a question nobody
  // asked yet.
  const [infoOpen, setInfoOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  // The stage reports through the app's one status line, never its own.
  const handleStatus = (message: string): void => shareHost?.onStatus(message);
  const printable = printKind(doc) !== null;
  // The stage's own region, read for ONE thing: the src the picture is
  // currently showing. Off the gateway origin that is a `blob:` URL the shell
  // authorized in this tree, and the print sheet — a separate document — can
  // only load what is already same-origin. See print.ts.

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
  // Named, so the ref read is unmistakably a HANDLER body rather than a
  // closure the render's own data flow carries. The picture's `src` is taken
  // off the element the stage is already showing (print.ts), and that element
  // only exists once the stage has painted — so the read has to happen at
  // press time, never while building this list.
  // NO REF, and the reason is not style. Print needs the src of the <img> the
  // stage is ACTUALLY showing: off the gateway origin the shell's authorizer
  // rewrites the vault path to a `blob:` URL, so `doc.content_uri` is not the
  // thing on screen. That element does not exist until the stage has painted,
  // so the read has to happen on press — and a ref carrying it would be a ref
  // captured by an action object built during render, which is exactly the
  // shape the React compiler refuses to reason about. The stage marks itself
  // instead, and only one QuickLook is ever open.
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
  // Drawn only where the grant plane can be reached: a Share the host cannot
  // fulfil is a verb that exists to refuse.
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
    <dialog
      open
      className={styles.quick}
      data-narrow={String(narrow)}
      aria-modal="true"
      aria-label="Quick look"
    >
      {/* Share opens the one shared grant sheet, object-first over the
          document already on the stage; the stage invents no sharing flow of
          its own and keeps no share state beyond "is it open". */}
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
        {/* Close is the FIRST thing in the bar, at the leading edge: it is the
            way back out of a surface that covers everything, and the way out
            does not hide at the end of a row of six verbs. */}
        <button
          type="button"
          className={styles.close}
          aria-label={STAGE_ACTIONS.close}
          onClick={onClose}
        >
          <Icon svg={I.close!} />
        </button>
        {/* Title AND what it is, stacked. A stage that names the document but
            not its kind, its weight or its filing makes a member close it to
            find out. */}
        <div className={styles.heading}>
          <div className={styles.title}>{doc.title || "Untitled"}</div>
          <div className={styles.metaLine}>
            {m.name} · {fmtBytes(doc.byte_size)} · {folderName(doc.folder_id)}
          </div>
        </div>
        {/* THE SPACER MUST NOT FLEX. Beside a `flex: 1` heading, a growable
            spacer splits the slack with it and the title truncates with empty
            space beside it. */}
        <span className={styles.spacer} aria-hidden="true" />
        {narrow ? null : <BarActions actions={barActions} labelled />}
      </div>
      <div className={styles.body} data-quicklook-body="">
        {body}
      </div>
      {/* The status line: where in the set this document is, and where its
          bytes are — the one custody fact a stage can state and a row cannot
          fit. */}
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
    </dialog>
  );
}
