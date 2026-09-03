import { useCallback, useEffect, useRef, useState } from "react";

import { GrantSheet } from "../../_shared/GrantSheet.tsx";
import {
  canWriteScope,
  mountedScopes,
  scopeAttr,
} from "../../_shared/scope-kit.ts";
import { SAVED_TO_MY_VAULT } from "../../_shared/shared-copy.ts";
import { displayText, safeMediaUrl } from "../../_shared/untrusted.ts";
import { toggleFavorite } from "../assets-actions.ts";
import { isVideoAsset } from "../format.ts";
import { usePhotoShare } from "../grant-audiences.ts";
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

const COMPACT = 720;

function withProbedDims(asset: Asset, probed: Dims | null): Asset {
  return probed && asset.width == null && asset.height == null
    ? { ...asset, ...probed }
    : asset;
}

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
  const [probedFor, setProbedFor] = useState(asset.asset_id);
  if (probedFor !== asset.asset_id) {
    setProbedFor(asset.asset_id);
    setProbed(null);
    setMoreOpen(false);
  }
  const displayAsset = withProbedDims(asset, probed);
  const canWrite = canWriteScope(asset.scope_id);
  const readOnly = canWrite ? undefined : "This library is read-only for you.";
  const compact = rootWidth > 0 && rootWidth < COMPACT;
  const labelled = labelsVisible(barWidth);
  const downloadHref = safeMediaUrl(asset.content_uri);
  const editable =
    isRenderableUri(asset.content_uri) && !isVideoAsset(asset) && canWrite;
  const share = usePhotoShare(notice);
  const scopes = mountedScopes();
  const actorVaultId = asset.scope_id ?? scopes[0]?.id ?? "";
  const [residentAssetId, setResidentAssetId] = useState<string | null>(null);
  const commonsResident = residentAssetId === asset.asset_id;
  useEffect(() => {
    let active = true;
    if (!actorVaultId || !window.centraid.commonsResidents) return;
    void window.centraid
      .commonsResidents(actorVaultId)
      .then((items) => {
        if (active)
          setResidentAssetId(
            items.some(
              (item) =>
                item.itemType === "media.asset" &&
                item.itemId === asset.asset_id
            )
              ? asset.asset_id
              : null
          );
      })
      .catch(() => {
        if (active) setResidentAssetId(null);
      });
    return () => {
      active = false;
    };
  }, [actorVaultId, asset.asset_id]);

  async function saveToMyVault(): Promise<void> {
    if (!commonsResident || !actorVaultId || !window.centraid.retainCommonsItem)
      return;
    try {
      await window.centraid.retainCommonsItem({
        actorVaultId,
        itemType: "media.asset",
        itemId: asset.asset_id,
      });
      setResidentAssetId(null);
      notice(SAVED_TO_MY_VAULT);
      await refresh();
    } catch (error) {
      notice(
        error instanceof Error
          ? `Photo was not saved: ${error.message}`
          : "Photo was not saved to your vault."
      );
    }
  }

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
      label: commonsResident ? "Save to my vault" : "Share",
      disabled: false,
      onRun: () => (commonsResident ? void saveToMyVault() : share.request()),
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
    <div
      className={styles.lightbox}
      ref={rootRef}
      data-info={!editing && infoOpen ? "open" : undefined}
    >
      <GrantSheet
        open={share.open}
        onClose={() => share.close()}
        audiences={share.audiences}
        subject={{
          subjectType: "media.asset",
          subjectId: asset.asset_id,
          ...(displayText(asset.title ?? "").trim()
            ? { label: displayText(asset.title ?? "").trim() }
            : {}),
        }}
        onStatus={notice}
      />
      <div className={styles.topbar} ref={barRef}>
        <button
          type="button"
          className={styles.close}
          aria-label="Close"
          onClick={onClose}
        >
          <CloseIcon size={18} />
        </button>
        <div className={styles.heading}>
          {/* While editing the bar names the ACT, not the photograph. */}
          <div className={styles.title}>
            {editing
              ? "Crop and rotate"
              : displayText(asset.title || asset.place?.name || "Photograph")}
          </div>
          <div className={styles.captureLine}>
            {editing
              ? editorSourceLine(
                  displayAsset,
                  list.find(
                    (a) => a.asset_id === displayAsset.source_asset_id
                  ) ?? null
                )
              : captureLine(displayAsset)}
          </div>
        </div>
        {/* MUST NOT FLEX: beside a `flex: 1` heading the title truncates. */}
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
        {/* `#lightbox`'s close listener gates on `e.target === e.currentTarget`. */}
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
                `Fetching the original from ${gatewayName} — it stays once it lands.`
              )
            }
          />
        )}
        {!editing && infoOpen ? (
          <aside className={styles.info} aria-label="About this photograph">
            {/* Grabber on the phone; a seam on the rail. */}
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
            key={`${a.scope_id ?? ""}:${a.asset_id}`}
            type="button"
            aria-current={active ? "true" : undefined}
            className={styles.frame}
            data-active={active ? "true" : "false"}
            aria-label={displayText(a.title ?? "Photograph")}
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
