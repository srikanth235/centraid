// The viewer (v4 handoff §7.1) — one of the three modes that stand on the
// STAGE: full-bleed `--stage` in both themes, ink `--on-stage`, hairlines
// `--stage-line`, covering the entire frame including the stem.
//
// THE STAGE IS NOT A THEMED SURFACE. `--stage` is the same literal in light
// and dark because a media ground does not follow the theme; the one thing
// that must still work there is FOCUS, so the focus ring on this surface takes
// its colour from `--focus-ring-color` and its inner gap from `--stage` —
// never from `currentColor`, which would vanish the moment a control inverted.
//
// WHAT LIVES WHERE. The pure rules — the label breakpoint, the zoom ladder and
// its readout, the transports, where the original lives — are in viewer.ts, so
// the tests and this file read the same answers. The stage's media, steps,
// zoom and transport are in ViewerStage.tsx; the action set is in
// ViewerActions.tsx, described once and laid out twice. What is left here is
// the shell: which regions exist, and what the bar carries.
//
// `refresh`/`onClose` are the only orchestrator-owned pieces threaded down;
// every command fires through `act` (outcomes.ts) directly, and every outcome
// lands on the FRAME's one status line via `notice`.
import { useCallback, useEffect, useRef, useState } from "react";

import {
  canWriteScope,
  mountedScopes,
  scopeAttr,
} from "../../_shared/scope-kit.ts";
import { ShareSheet } from "../../_shared/ShareSheet.tsx";
import { displayText, safeMediaUrl } from "../../_shared/untrusted.ts";
import { toggleFavorite } from "../assets-actions.ts";
import { isVideoAsset } from "../format.ts";
import {
  CloseIcon,
  DownloadIcon,
  EditIcon,
  HeartIcon,
  InfoMarkIcon,
  MoreIcon,
  PlayIcon,
  ShareIcon,
  TrashIcon,
} from "../icons.tsx";
import { gridSrc, isRenderableUri } from "../media.ts";
import { act, narrate, notice } from "../outcomes.ts";
import { photosScopeDeclaration } from "../scope-declaration.ts";
import type { Album, Asset, Place } from "../types.ts";
import {
  captureLine,
  DEFAULT_GATEWAY_NAME,
  editorSourceLine,
  labelsVisible,
  originStatus,
} from "../viewer.ts";
import { EditorView } from "./Editor.tsx";
import { LightboxInfo } from "./LightboxInfo.tsx";
import { ViewerBarActions, ViewerBottomBar } from "./ViewerActions.tsx";
import type { ViewerActionSpec } from "./ViewerActions.tsx";
import { ViewerStage } from "./ViewerStage.tsx";

import styles from "./Lightbox.module.css";

interface Dims {
  width: number;
  height: number;
}

/** The compact form factor, in ONE place. Below this the top bar keeps close
 *  and More only, and the five actions move to a bottom bar where a thumb is
 *  (§7.1, §D). */
const COMPACT = 720;

function withProbedDims(asset: Asset, probed: Dims | null): Asset {
  return probed && asset.width == null && asset.height == null
    ? { ...asset, ...probed }
    : asset;
}

/** An element's live inline size. Two things are derived from a measurement
 *  rather than a media query here: whether the bar is labelled, and whether
 *  the actions sit in the bar at all. */
function useWidth(): [(el: HTMLElement | null) => void, number] {
  const [width, setWidth] = useState(0);
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: HTMLElement | null) => {
    observer.current?.disconnect();
    if (!el || typeof ResizeObserver !== "function") return;
    observer.current = new ResizeObserver((entries) => {
      setWidth(entries[0]?.contentRect.width ?? 0);
    });
    observer.current.observe(el);
    setWidth(el.getBoundingClientRect().width);
  }, []);
  useEffect(() => () => observer.current?.disconnect(), []);
  return [ref, width];
}

export function LightboxShell({
  asset,
  idx,
  list,
  albums: albumList,
  places,
  renderSeq,
  gatewayName = DEFAULT_GATEWAY_NAME,
  onStep,
  refresh,
  onClose,
  onSlideshow,
}: {
  asset: Asset;
  idx: number;
  list: Asset[];
  albums: Album[];
  places: Place[];
  renderSeq: number;
  /** What the member calls the machine the originals live on. Never invented
   *  as a hostname — `the gateway` is true on every deployment. */
  gatewayName?: string;
  onStep: (delta: number) => void;
  refresh: () => Promise<void>;
  onClose: () => void;
  onSlideshow: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [infoOpen, setInfoOpen] = useState(true);
  const [moreOpen, setMoreOpen] = useState(false);
  const [probed, setProbed] = useState<Dims | null>(null);
  const [rootRef, rootWidth] = useWidth();
  const [barRef, barWidth] = useWidth();
  // Dims probed off the previous asset are dropped during the render that
  // first sees a new asset_id (React's "adjust state when a prop changes"
  // pattern), not one commit later from an effect — an effect would paint the
  // old dimensions against the new photograph for a frame (#573).
  const [probedFor, setProbedFor] = useState(asset.asset_id);
  if (probedFor !== asset.asset_id) {
    setProbedFor(asset.asset_id);
    setProbed(null);
    setMoreOpen(false);
  }
  const displayAsset = withProbedDims(asset, probed);
  // Same rule as the grid tile: a read-only audience's photograph is viewable,
  // and the actions that would write are DISABLED with the reason rather than
  // firing and apologising (§6, #599).
  const canWrite = canWriteScope(asset.scope_id);
  const readOnly = canWrite ? undefined : "This library is read-only for you.";
  const compact = rootWidth > 0 && rootWidth < COMPACT;
  const labelled = labelsVisible(barWidth);
  const downloadHref = safeMediaUrl(asset.content_uri);
  const editable =
    isRenderableUri(asset.content_uri) && !isVideoAsset(asset) && canWrite;
  // Share (issue #726 P6): opens the unified give/lend sheet rather than
  // firing a sole-destination shortcut. Give copies this ONE photograph;
  // lend opens a live window over the whole library (the sheet's own note
  // says so) — see `_shared/ShareSheet.tsx`'s header for why lend has no
  // per-item granularity.
  const [shareOpen, setShareOpen] = useState(false);

  async function trash(): Promise<void> {
    const outcome = await act(
      "delete-asset",
      { asset_id: asset.asset_id },
      asset.scope_id
    );
    if (!narrate(outcome)) return;
    onClose();
    notice("Moved to trash — it leaves every album it was in.", () => {
      void (async () => {
        await act("restore", { asset_id: asset.asset_id }, asset.scope_id);
        await refresh();
      })();
    });
    await refresh();
  }

  // Described ONCE, laid out twice (§D: same five names, same marks).
  const specs: Record<string, ViewerActionSpec> = {
    favorite: {
      id: "favorite",
      icon: HeartIcon,
      filled: !!asset.favorite,
      pressed: !!asset.favorite,
      disabled: !canWrite,
      reason: readOnly,
      onRun: () => void toggleFavorite(asset, refresh),
    },
    edit: {
      id: "edit",
      icon: EditIcon,
      disabled: !editable,
      // The reason must name THIS control's actual blocker. `readOnly` is
      // right for favorite/trash, but edit has two more ways to be off —
      // a video, or an original that is not here to render — and telling a
      // member "read-only" over a video misstates their own grant (§6).
      reason: canWrite
        ? isVideoAsset(asset)
          ? "Only photographs can be cropped and rotated."
          : "The original is not on this device yet."
        : readOnly,
      onRun: () => setEditing(true),
    },
    info: {
      id: "info",
      icon: InfoMarkIcon,
      pressed: infoOpen,
      onRun: () => setInfoOpen((v) => !v),
    },
    copy: {
      id: "copy",
      icon: ShareIcon,
      label: "Share",
      // The sheet resolves the true empty state (own vaults sync, linked
      // people async) itself — this control never disables on a guess.
      disabled: false,
      onRun: () => setShareOpen(true),
    },
    download: {
      id: "download",
      icon: DownloadIcon,
      href: downloadHref ?? undefined,
      download: displayText(asset.title).trim() || `photo-${asset.asset_id}`,
      scope: scopeAttr(asset.scope_id),
      disabled: downloadHref === null,
    },
    slideshow: { id: "slideshow", icon: PlayIcon, onRun: onSlideshow },
    trash: {
      id: "trash",
      icon: TrashIcon,
      destructive: true,
      disabled: !canWrite,
      reason: readOnly,
      onRun: () => void trash(),
    },
  };
  const barSpecs = [
    specs.favorite!,
    specs.edit!,
    specs.info!,
    specs.copy!,
    specs.download!,
    specs.slideshow!,
  ];
  const phoneSpecs = [
    specs.copy!,
    specs.favorite!,
    specs.info!,
    specs.edit!,
    specs.trash!,
  ];

  return (
    <div className={styles.lightbox} ref={rootRef}>
      <ShareSheet
        open={shareOpen}
        onClose={() => setShareOpen(false)}
        sourceScopeId={asset.scope_id ?? mountedScopes()[0]?.id ?? ""}
        scopes={mountedScopes()}
        verbs={["give", "lend"]}
        itemType="media.media_asset"
        itemIds={[asset.asset_id]}
        mintedIdFamilies={photosScopeDeclaration.mintedIdFamilies}
        appLabel="Photos"
        onDone={(outcome) => {
          notice(outcome.message);
          if (outcome.ok && outcome.verb === "give") void refresh();
        }}
      />
      <div className={styles.topbar} ref={barRef}>
        <button
          type="button"
          className={styles.close}
          aria-label="Close"
          title="Close"
          onClick={onClose}
        >
          <CloseIcon size={18} />
        </button>
        <div className={styles.heading}>
          {/* While editing, the bar names the ACT, not the photograph — the
              title is `Crop and rotate` and the meta says what the source is
              (proto 4510–4511). The viewer's caption/capture pair returns the
              moment the editor closes. */}
          <div className={styles.title}>
            {editing
              ? "Crop and rotate"
              : displayText(asset.title || asset.place?.name || "Photograph")}
          </div>
          <div className={styles.captureLine}>
            {editing
              ? editorSourceLine(
                  displayAsset,
                  // The source of an edited copy, when this page happens to
                  // hold it (issue #711). `list` is a bounded window, so a
                  // miss is ordinary — the line handles not knowing.
                  list.find(
                    (a) => a.asset_id === displayAsset.source_asset_id
                  ) ?? null
                )
              : captureLine(displayAsset)}
          </div>
        </div>
        {/* THE SPACER MUST NOT FLEX. Beside a `flex: 1` heading, a growable
            spacer splits the slack with it and the title truncates with empty
            space beside it (§7.1). */}
        <span className={styles.spacer} aria-hidden="true" />
        {editing ? null : compact ? (
          <button
            type="button"
            className={styles.close}
            aria-label="More"
            title="More"
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen((v) => !v)}
          >
            <MoreIcon size={18} />
          </button>
        ) : (
          <ViewerBarActions specs={barSpecs} labelled={labelled} />
        )}
      </div>

      {compact && moreOpen && !editing ? (
        <div className={styles.moreSheet}>
          <ViewerBarActions
            specs={[specs.download!, specs.slideshow!, specs.trash!]}
            labelled
          />
        </div>
      ) : null}

      <div className={styles.body}>
        {/* No backdrop-shield onClick here: `#lightbox`'s native close listener
            already gates on `e.target === e.currentTarget` (see lightbox.tsx),
            so a click on this region never reached it in the first place. */}
        {editing ? (
          <div className={styles.editorHost}>
            <EditorView
              key={asset.asset_id}
              asset={asset}
              refresh={refresh}
              onCancel={() => setEditing(false)}
              onSaved={() => setEditing(false)}
            />
          </div>
        ) : (
          <ViewerStage
            key={asset.asset_id}
            asset={displayAsset}
            hasPrev={idx > 0}
            hasNext={idx >= 0 && idx < list.length - 1}
            onStep={onStep}
            onDims={(w, h) => setProbed({ width: w, height: h })}
            status={originStatus(asset, gatewayName)}
            onLoadOriginal={() =>
              notice(
                `Fetching the original from ${gatewayName}. It stays on this device once it lands.`
              )
            }
          />
        )}
        {!editing && infoOpen ? (
          <aside className={styles.info} aria-label="About this photograph">
            {/* The phone's sheet is dragged by its grabber; on the rail the
                same element is the seam between the panel and the stage. */}
            <span className={styles.grabber} aria-hidden="true" />
            <LightboxInfo
              key={renderSeq}
              asset={displayAsset}
              albums={albumList}
              places={places}
              gatewayName={gatewayName}
              refresh={refresh}
              onClose={onClose}
            />
          </aside>
        ) : null}
      </div>

      {editing ? null : (
        <>
          {compact ? <ViewerBottomBar specs={phoneSpecs} /> : null}
          <Filmstrip list={list} current={asset} idx={idx} onStep={onStep} />
        </>
      )}
    </div>
  );
}

/**
 * The filmstrip (§7.1) — KEPT ON THE PHONE, at 58px. Swipe and the strip are
 * the same control approached from two directions, and dropping it there would
 * make the phone a slideshow.
 *
 * A frame is a step-to control, not a grid tile: it has no selection slot, no
 * vault rule and no state line, so it deliberately does not reach for
 * Tile.tsx. What it shares with the grid is the CHEAP source rule — a thumb,
 * never a full remote original.
 */
function Filmstrip({
  list,
  current,
  idx,
  onStep,
}: {
  list: Asset[];
  current: Asset;
  idx: number;
  onStep: (delta: number) => void;
}) {
  if (list.length < 2) return null;
  return (
    <div className={styles.filmstrip} aria-label="Nearby photographs">
      {list.map((a, i) => {
        const src = gridSrc(a);
        const active = a.asset_id === current.asset_id;
        return (
          <button
            // Scope-qualified for the same reason the grid's tiles are.
            key={`${a.scope_id ?? ""}:${a.asset_id}`}
            type="button"
            aria-current={active ? "true" : undefined}
            className={styles.frame}
            data-active={active ? "true" : "false"}
            aria-label={displayText(a.title ?? "Photograph")}
            /* The strip mixes scopes: each frame names its own so the
               authorizer's nearest-ancestor lookup finds the right one. */
            data-scope={scopeAttr(a.scope_id)}
            onClick={(e) => {
              e.stopPropagation();
              onStep(i - idx);
            }}
          >
            {src ? (
              <img src={src} loading="lazy" decoding="async" alt="" />
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
