import { AudiencePlacement } from "../../_shared/AudiencePlacement.tsx";
// The main pane's toolbar row: active-view title + subtitle, a back
// affordance inside an album, "Add photos"/"New album" on the views that
// want them, and the Select toggle. Pure view — app.tsx computes every
// derived string/flag and passes it straight through.
//
// The scope chips (issue #599) appear here, under the title, ONLY when this
// mount actually spans scopes: a member with one library must see the toolbar
// exactly as it was, so `scopes` arriving with a single entry renders nothing.
import { ScopeChips } from "../../_shared/ScopeChips.tsx";
import type { InlineScope } from "../../inline-types.ts";
import { ChevronLeftIcon, PlusIcon } from "../icons.tsx";

import styles from "./Toolbar.module.css";

export function ToolbarView({
  title,
  subtitle,
  showBack,
  onBack,
  showNewAlbum,
  onNewAlbum,
  showAddPhotos,
  onAddPhotos,
  showSelect,
  selectMode,
  onToggleSelect,
  scopes,
  ownScopeId,
  selectedScopeId,
  onSelectScope,
  albumId,
}: {
  title: string;
  subtitle: string;
  showBack: boolean;
  onBack: () => void;
  showNewAlbum: boolean;
  onNewAlbum: () => void;
  showAddPhotos: boolean;
  onAddPhotos: () => void;
  showSelect: boolean;
  selectMode: boolean;
  onToggleSelect: () => void;
  /** Every mounted scope, primary first. One entry means "no chips at all". */
  scopes: readonly InlineScope[];
  ownScopeId: string;
  /** The selected chip, or null for "All". */
  selectedScopeId: string | null;
  onSelectScope: (scopeId: string | null) => void;
  albumId?: string | null;
}) {
  return (
    <div className={styles.toolbar}>
      {showBack ? (
        <button
          type="button"
          className={`kit-icon-btn ${styles.backBtn}`}
          aria-label="Back to albums"
          onClick={onBack}
        >
          <ChevronLeftIcon />
        </button>
      ) : null}
      <div className={styles.toolbarTitle}>
        <div className={styles.toolbarH1}>{title}</div>
        <div className={styles.toolbarSub}>{subtitle}</div>
        {scopes.length > 1 ? (
          <div className={styles.toolbarScopes}>
            <ScopeChips
              scopes={scopes}
              ownScopeId={ownScopeId}
              selectedScopeId={selectedScopeId}
              onSelect={onSelectScope}
              label="Shown from"
            />
          </div>
        ) : null}
      </div>
      <div className={styles.toolbarActions}>
        {albumId ? (
          <AudiencePlacement
            itemType="core.collection"
            itemId={albumId}
            label="Share album"
          />
        ) : null}
        {showAddPhotos ? (
          <button
            type="button"
            className={`kit-btn ${styles.pillBtn}`}
            onClick={onAddPhotos}
          >
            Add to this album
          </button>
        ) : null}
        {showNewAlbum ? (
          <button
            type="button"
            className={`kit-btn ${styles.pillBtn}`}
            onClick={onNewAlbum}
          >
            <PlusIcon size={15} />
            New album
          </button>
        ) : null}
        {showSelect ? (
          <button
            type="button"
            className={`kit-btn ${styles.pillBtn}`}
            data-active={selectMode ? "true" : "false"}
            onClick={onToggleSelect}
          >
            {selectMode ? "Cancel" : "Select"}
          </button>
        ) : null}
      </div>
    </div>
  );
}
