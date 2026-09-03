import type { ReactNode } from "react";

import { titlesOf } from "../access-model.ts";
import type { Bag } from "../bag.ts";
import { emptySeed } from "../draft.ts";
import { clockAt } from "../format.ts";
import { reviewRegister } from "../review-model.ts";
import type { RouteActs } from "../route-acts.ts";
import {
  ACCESS,
  EDIT,
  EXPORT,
  FILL,
  GEN,
  IMPORT,
  SEARCH,
  TRASH,
  WATCH,
} from "../shelves.ts";
import type { ShelfId } from "../shelves.ts";
import type { SurfaceActs } from "../surface-acts.ts";
import { AccessScreen } from "./Access.tsx";
import { EditScreen } from "./Edit.tsx";
import { ExportScreen } from "./Export.tsx";
import { GenScreen } from "./Gen.tsx";
import { ImportScreen } from "./Import.tsx";
import { ReviewScreen } from "./Review.tsx";
import { SearchScreen } from "./Search.tsx";
import { FillScreen } from "./Surfaces.tsx";
import { TrashScreen } from "./Trash.tsx";

const ROUTED: ReadonlySet<string> = new Set([
  String(EDIT),
  String(GEN),
  String(WATCH),
  String(SEARCH),
  String(IMPORT),
  String(ACCESS),
  String(TRASH),
  String(EXPORT),
  String(FILL),
]);

export function isRoutedScreen(shelf: ShelfId): boolean {
  return shelf !== null && ROUTED.has(String(shelf));
}

export interface ScreensProps {
  shelf: ShelfId;
  bag: Bag;
  loaded: boolean;
  offline: boolean;
  busy: boolean;
  now: number;
  acts: RouteActs;
  surfaces: SurfaceActs;
  hasImportDoor: boolean;
  onOpenItem: (itemId: string) => void;
  onCancelEdit: () => void;
}

export function Screens(props: ScreensProps): ReactNode {
  const { acts, bag, shelf } = props;

  if (shelf === EDIT) {
    return (
      <EditScreen
        seed={bag.editSeed ?? emptySeed()}
        detail={bag.editSeed?.mode === "edit" ? bag.detail : null}
        sidecarDraft={bag.sidecarDraft}
        offline={props.offline}
        busy={props.busy}
        error={bag.editError}
        onChange={acts.handleEditChange}
        onRetype={acts.handleRetype}
        onGenerate={() => acts.handleGenerateInto("password")}
        onSave={acts.handleSave}
        onCancel={props.onCancelEdit}
        onFieldDraft={acts.handleFieldDraft}
        onFieldSave={acts.handleFieldSave}
        onFieldRemove={acts.handleFieldRemove}
        onAddressDraft={acts.handleAddressDraft}
        onAddressSave={acts.handleAddressSave}
        onPasskeyDraft={acts.handlePasskeyDraft}
        onPasskeySave={acts.handlePasskeySave}
        onPasskeyClear={acts.handlePasskeyClear}
      />
    );
  }

  if (shelf === GEN) {
    return (
      <GenScreen
        value={bag.generated}
        options={bag.genOptions}
        onOptions={acts.handleGenOptions}
        onRegenerate={acts.handleRegenerate}
        onCopy={acts.handleCopyGenerated}
        onPutOnItem={acts.handlePutOnItem}
      />
    );
  }

  if (shelf === WATCH) {
    return (
      <ReviewScreen
        register={reviewRegister(bag.items, props.now)}
        windowCount={bag.items.length}
        checkedAtClock={bag.lastMatchedAt ? clockAt(bag.lastMatchedAt) : null}
        loaded={props.loaded}
        onShowThem={acts.handleShowVerdict}
        onChange={(row) => props.onOpenItem(row.item_id)}
      />
    );
  }

  if (shelf === SEARCH) {
    return (
      <SearchScreen
        query={bag.searchTerm}
        status={bag.searchStatus}
        results={bag.searchResults}
        onQuery={acts.handleQuery}
        onClear={acts.handleClearQuery}
        onRetry={acts.handleRetrySearch}
        onOpen={props.onOpenItem}
      />
    );
  }

  if (shelf === TRASH) {
    return (
      <TrashScreen
        rows={bag.trashRows}
        loaded={props.loaded}
        onRestore={acts.handleRestore}
        onPurge={acts.handleAskPurge}
      />
    );
  }

  if (shelf === IMPORT) {
    return (
      <ImportScreen
        hasDoor={props.hasImportDoor}
        offline={props.offline}
        batches={bag.importBatches}
        rows={bag.importRows}
        openBatchId={bag.openBatchId}
        note={bag.importNote}
        onStage={props.surfaces.handleStageFile}
        onOpen={props.surfaces.handleOpenBatch}
        onPublish={props.surfaces.handlePublishBatch}
        onDiscard={props.surfaces.handleDiscardBatch}
      />
    );
  }

  if (shelf === ACCESS) {
    return (
      <AccessScreen
        entries={bag.accessEntries}
        window={bag.accessWindow}
        itemId={bag.accessItemId}
        titles={titlesOf(bag.items)}
        offline={props.offline}
        onNarrow={props.surfaces.handleNarrowAccess}
      />
    );
  }

  if (shelf === EXPORT) {
    return (
      <ExportScreen
        items={bag.total ?? bag.items.length}
        offline={props.offline}
        busy={props.busy}
        includeTrashed={bag.exportTrashed}
        includeHistory={bag.exportHistory}
        onOption={props.surfaces.handleExportOption}
        onAsk={props.surfaces.handleAskExport}
      />
    );
  }

  if (shelf === FILL) return <FillScreen />;
  return null;
}
